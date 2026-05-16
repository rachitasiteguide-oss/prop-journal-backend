// Parameter sweep engine.
//
// A sweep iterates the backtest engine N times with one strategy parameter
// perturbed across a list of values, collects per-iteration summary metrics,
// and persists them to the BacktestSweep row. Trades are NOT persisted —
// otherwise a 50-iteration sweep would write thousands of rows for results
// the user will mostly compare in aggregate.
//
// Walk-forward analysis layers cleanly on top: split the date range into N
// windows, run a sweep per window, report IS-best params + OOS metrics. Not
// implemented in this MVP; the data model already supports it.

import { prisma } from '../config/db';
import { Prisma } from '@prisma/client';
import { AppError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';
import { getCandles } from './candleService';
import { runEngineInline, type EngineConfig } from './backtestEngine';
import {
  type PureCandle,
  type PureTradeResult,
  type RunDiagnostics,
} from './backtestEngineCore';

// ── Public types ────────────────────────────────────────────────────────────

export interface SweepAxis {
  paramKey: string;        // e.g. "fastPeriod" — must exist in strategyConfig schema
  values:   number[];      // the values to sweep across (deduped + sorted client-side)
}

export interface SweepIterationMetrics {
  paramValue:        number;
  tradeCount:        number;
  totalPnl:          number;
  totalPnlPct:       number;
  winRate:           number;
  profitFactor:      number;
  sharpe:            number;
  maxDrawdown:       number;   // percent (0-100)
  forceClosedPct:    number;
  finalBalance:      number;
  // Optional — present only when the run used PropFirmRules.
  challengeStatus?:  string;
  breachedRule?:     string;
  // Diagnostic flags that indicate the result may not be statistically meaningful.
  warnings:          string[];
}

export interface SweepRow {
  id:              string;
  userId:          string;
  parentSessionId: string;
  axis:            SweepAxis;
  baseConfig:      Record<string, unknown>;
  status:          'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress:        number;
  results:         SweepIterationMetrics[] | null;
  runError:        string | null;
  startedAt:       Date | null;
  completedAt:     Date | null;
  createdAt:       Date;
}

// ── Metrics helper ──────────────────────────────────────────────────────────
// Lean replacement for getSessionAnalytics — operates on in-memory trade
// results and returns only what the sweep needs. Keeps headline metrics
// numerically identical to the analytics endpoint.

export function summariseIteration(
  paramValue:      number,
  trades:          PureTradeResult[],
  startingBalance: number,
  finalBalance:    number,
  diagnostics:     RunDiagnostics,
): SweepIterationMetrics {
  const tradeCount = trades.length;
  const winners    = trades.filter(t => t.pnl > 0);
  const losers     = trades.filter(t => t.pnl < 0);

  const totalPnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const totalPnlPct = startingBalance > 0 ? (totalPnl / startingBalance) * 100 : 0;
  const winRate     = tradeCount > 0 ? (winners.length / tradeCount) * 100 : 0;

  const grossWin  = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : 0;

  // Per-trade Sharpe — matches getSessionAnalytics' formulation.
  let eq = startingBalance;
  const returns: number[] = [];
  for (const t of trades) {
    returns.push(eq > 0 ? t.pnl / eq : 0);
    eq += t.pnl;
  }
  const mean = returns.length === 0 ? 0 : returns.reduce((s, x) => s + x, 0) / returns.length;
  const std = (() => {
    if (returns.length < 2) return 0;
    const sq = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(sq);
  })();
  const sharpe = std > 0 ? mean / std : 0;

  // Intra-trade-aware MDD using maxAdverse.
  let peak = startingBalance;
  let maxDrawdown = 0;
  let runningEq = startingBalance;
  for (const t of trades) {
    const trough = runningEq - (t.maxAdverse ?? 0);
    if (peak > 0) {
      const ddTrough = ((peak - trough) / peak) * 100;
      if (ddTrough > maxDrawdown) maxDrawdown = ddTrough;
    }
    runningEq += t.pnl;
    if (runningEq > peak) peak = runningEq;
    const ddClose = peak > 0 ? ((peak - runningEq) / peak) * 100 : 0;
    if (ddClose > maxDrawdown) maxDrawdown = ddClose;
  }

  const forceClosed = trades.filter(t => t.forceClosed).length;
  const forceClosedPct = tradeCount > 0 ? (forceClosed / tradeCount) * 100 : 0;

  // Statistical-meaning warnings. The user will sort by Sharpe / PF in the
  // UI — they need to see when a number is built on too-thin a base.
  const warnings: string[] = [];
  if (tradeCount === 0)                                  warnings.push('No trades');
  if (tradeCount > 0 && tradeCount < 5)                  warnings.push('Sample size <5 trades');
  if (forceClosedPct >= 20)                              warnings.push(`${forceClosedPct.toFixed(0)}% force-closed`);
  if (diagnostics.coverageWarning)                       warnings.push('Partial data coverage');

  const out: SweepIterationMetrics = {
    paramValue,
    tradeCount,
    totalPnl:        round2(totalPnl),
    totalPnlPct:     round2(totalPnlPct),
    winRate:         round2(winRate),
    profitFactor:    round2(profitFactor),
    sharpe:          round3(sharpe),
    maxDrawdown:     round2(maxDrawdown),
    forceClosedPct:  round2(forceClosedPct),
    finalBalance:    round2(finalBalance),
    warnings,
  };
  if (diagnostics.challengeResult) {
    out.challengeStatus = diagnostics.challengeResult.status;
    if (diagnostics.challengeResult.breachedRule) {
      out.breachedRule = diagnostics.challengeResult.breachedRule;
    }
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ── Sweep orchestration ─────────────────────────────────────────────────────

export interface CreateSweepInput {
  axis:       SweepAxis;
  baseConfig: Record<string, unknown>;  // strategy + risk config; axis.paramKey will be overridden per-iteration
}

export async function createSweep(
  userId: string,
  parentSessionId: string,
  input: CreateSweepInput,
): Promise<SweepRow> {
  // Validate parent session belongs to this user.
  const parent = await prisma.backtestSession.findFirst({
    where: { id: parentSessionId, userId },
  });
  if (!parent) throw new AppError('Session not found', 404);

  if (parent.mode !== 'AUTO') {
    throw new AppError('Sweeps are only supported on AUTO sessions.', 400);
  }
  if (!parent.timeframe) {
    throw new AppError('Parent session has no timeframe configured.', 400);
  }
  if (input.axis.values.length === 0) {
    throw new AppError('Sweep axis must contain at least one value.', 400);
  }
  if (input.axis.values.length > 50) {
    throw new AppError('Sweep limited to 50 iterations to keep run time reasonable.', 400);
  }
  if (!input.axis.paramKey || input.axis.paramKey.trim() === '') {
    throw new AppError('Sweep axis paramKey is required.', 400);
  }

  const sweep = await prisma.backtestSweep.create({
    data: {
      userId,
      parentSessionId,
      axis:       input.axis as unknown as Prisma.InputJsonValue,
      baseConfig: input.baseConfig as Prisma.InputJsonValue,
      status:     'PENDING',
      progress:   0,
    },
  });

  // Fire-and-forget — controller returns 202 immediately, client polls.
  runSweep(sweep.id).catch(err => {
    logger.error(`Sweep ${sweep.id} crashed during runSweep dispatch: ${err instanceof Error ? err.message : String(err)}`);
  });

  return mapRow(sweep);
}

// Main worker. Sequential iterations so the existing signal cache pays off
// (params that produce identical signals between iterations hit the cache).
async function runSweep(sweepId: string): Promise<void> {
  const sweep = await prisma.backtestSweep.findUnique({ where: { id: sweepId } });
  if (!sweep) {
    logger.error(`runSweep called with unknown sweepId ${sweepId}`);
    return;
  }
  const parent = await prisma.backtestSession.findUnique({ where: { id: sweep.parentSessionId } });
  if (!parent) {
    await markFailed(sweepId, 'Parent session was deleted before sweep started');
    return;
  }
  if (!parent.timeframe) {
    await markFailed(sweepId, 'Parent session has no timeframe configured');
    return;
  }

  const axis       = sweep.axis as unknown as SweepAxis;
  const baseConfig = sweep.baseConfig as unknown as Record<string, unknown>;

  await prisma.backtestSweep.update({
    where: { id: sweepId },
    data:  { status: 'RUNNING', startedAt: new Date() },
  });

  // Single candle fetch — shared across all iterations.
  let candles: PureCandle[];
  try {
    const rows = await getCandles(
      parent.symbol,
      parent.instrumentType,
      parent.timeframe,
      parent.startDate,
      parent.endDate,
    );
    candles = rows as PureCandle[];
  } catch (err) {
    await markFailed(sweepId, `Candle fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const results: SweepIterationMetrics[] = [];
  const total = axis.values.length;

  for (let i = 0; i < total; i++) {
    const value = axis.values[i];
    try {
      // Build per-iteration engine config. baseConfig holds the full strategy
      // + risk shape; we override the axis param. customStrategy stays as-is.
      const cfg = buildEngineConfig(baseConfig, parent.startingBalance, parent.instrumentType, axis.paramKey, value);
      const { closedTrades, finalBalance, diagnostics } = runEngineInline(
        candles, null, cfg, parent.symbol, () => { /* progress no-op */ },
      );
      results.push(summariseIteration(value, closedTrades, parent.startingBalance, finalBalance, diagnostics));
    } catch (err) {
      // One bad iteration shouldn't kill the whole sweep. Record an
      // empty-metrics row with a warning and continue.
      results.push({
        paramValue:      value,
        tradeCount:      0,
        totalPnl:        0,
        totalPnlPct:     0,
        winRate:         0,
        profitFactor:    0,
        sharpe:          0,
        maxDrawdown:     0,
        forceClosedPct:  0,
        finalBalance:    parent.startingBalance,
        warnings:        [`Iteration failed: ${err instanceof Error ? err.message : String(err)}`],
      });
    }

    // Persist partial results after every iteration so the UI can show
    // progress without waiting for the whole sweep.
    await prisma.backtestSweep.update({
      where: { id: sweepId },
      data: {
        progress: Math.round(((i + 1) / total) * 100),
        results:  results as unknown as Prisma.InputJsonValue,
      },
    });
  }

  await prisma.backtestSweep.update({
    where: { id: sweepId },
    data: {
      status:      'COMPLETED',
      progress:    100,
      completedAt: new Date(),
    },
  });
}

async function markFailed(sweepId: string, reason: string): Promise<void> {
  await prisma.backtestSweep.update({
    where: { id: sweepId },
    data: {
      status:      'FAILED',
      runError:    reason,
      completedAt: new Date(),
    },
  });
}

// Substitute the axis param into the base config and produce an EngineConfig.
function buildEngineConfig(
  base:            Record<string, unknown>,
  startingBalance: number,
  instrumentType:  string,
  paramKey:        string,
  paramValue:      number,
): EngineConfig {
  const strategyConfig = {
    ...((base.strategyConfig ?? {}) as Record<string, number | string>),
    [paramKey]: paramValue,
  };
  return {
    strategyType:     base.strategyType as EngineConfig['strategyType'],
    strategyConfig,
    customStrategy:   base.customStrategy as EngineConfig['customStrategy'],
    startingBalance,
    volume:           Number(base.volume ?? 1),
    stopLossPct:      Number(base.stopLossPct ?? 0.02),
    takeProfitRatio:  Number(base.takeProfitRatio ?? 2),
    slippagePct:      Number(base.slippagePct ?? 0),
    commission:       Number(base.commission ?? 0),
    maxOpenPositions: Number(base.maxOpenPositions ?? 1),
    instrumentType,
    propFirmRules:    base.propFirmRules as EngineConfig['propFirmRules'],
    sizing:           base.sizing        as EngineConfig['sizing'],
  };
}

export async function getSweep(userId: string, sweepId: string): Promise<SweepRow> {
  const sweep = await prisma.backtestSweep.findFirst({ where: { id: sweepId, userId } });
  if (!sweep) throw new AppError('Sweep not found', 404);
  return mapRow(sweep);
}

export async function listSweepsForSession(userId: string, parentSessionId: string): Promise<SweepRow[]> {
  const sweeps = await prisma.backtestSweep.findMany({
    where: { userId, parentSessionId },
    orderBy: { createdAt: 'desc' },
  });
  return sweeps.map(mapRow);
}

function mapRow(row: {
  id: string; userId: string; parentSessionId: string;
  axis: unknown; baseConfig: unknown;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress: number; results: unknown; runError: string | null;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
}): SweepRow {
  return {
    id:              row.id,
    userId:          row.userId,
    parentSessionId: row.parentSessionId,
    axis:            row.axis as SweepAxis,
    baseConfig:      row.baseConfig as Record<string, unknown>,
    status:          row.status,
    progress:        row.progress,
    results:         (row.results as SweepIterationMetrics[] | null) ?? null,
    runError:        row.runError,
    startedAt:       row.startedAt,
    completedAt:     row.completedAt,
    createdAt:       row.createdAt,
  };
}
