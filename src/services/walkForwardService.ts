// Walk-forward analysis engine.
//
// Splits the candle range into N non-overlapping windows. Each window is
// further split: the first `isRatio` fraction is IN-SAMPLE (used to pick the
// best parameter via a sweep), the remainder is OUT-OF-SAMPLE (used to
// validate the IS-best parameter on unseen data).
//
// The aggregate stats are the most important output: if the strategy's edge
// survives OOS (avgOosSharpe > 0, low IS→OOS decay), it's plausibly real.
// If IS Sharpe is positive but OOS is zero or negative, the parameter
// optimisation is overfitting — common pitfall.

import { prisma } from '../config/db';
import { Prisma } from '@prisma/client';
import { AppError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';
import { getCandles } from './candleService';
import { runEngineInline, type EngineConfig } from './backtestEngine';
import { generateSignalsPure, type PureCandle, type Signal } from './backtestEngineCore';
import { summariseIteration, type SweepIterationMetrics, type SweepAxis } from './sweepService';

// ── Public types ─────────────────────────────────────────────────────────────

export type SelectionMetric = 'sharpe' | 'totalPnl' | 'profitFactor';

export interface WalkForwardConfig {
  windows:         number;          // 2..12
  isRatio:         number;          // 0.3..0.9 — fraction of each window used for IS
  selectionMetric: SelectionMetric; // metric used to pick the IS-best param
}

export interface WindowResult {
  windowIndex:     number;
  isStartDate:     string;          // ISO
  isEndDate:       string;
  oosStartDate:    string;
  oosEndDate:      string;
  isResults:       SweepIterationMetrics[];   // every paramValue evaluated on IS
  isBestParam:     number;
  // Whether isBestParam was a genuine metric-driven optimum. False when the
  // selection was an arbitrary fallback (no IS trades / all params tie / too
  // few trades) — the OOS leg still runs, but the result is not meaningful.
  // Optional for backward-compat with results persisted before this field.
  isBestReliable?: boolean;
  selectionWarning?: string | null;
  // Same metric block as a sweep iteration, computed on the OOS slice with
  // the IS-best param.
  oosMetrics:      SweepIterationMetrics;
}

export interface WalkForwardAggregate {
  avgIsSharpe:      number;
  avgOosSharpe:     number;
  avgIsPnl:         number;
  avgOosPnl:        number;
  // OOS Sharpe / IS Sharpe — closer to 1.0 = strategy edge transfers cleanly.
  // 0 or negative = overfit / no edge in OOS.
  decayRatio:       number;
  // Fraction of windows where OOS pnl > 0.
  oosWinRate:       number;
  // Fraction of windows where IS-best survived OOS at all (OOS Sharpe > 0).
  consistencyScore: number;
  // Loud flag: IS positive Sharpe but OOS negative → almost certainly overfit.
  overfitWarning:   boolean;
}

export interface WalkForwardRow {
  id:              string;
  userId:          string;
  parentSessionId: string;
  axis:            SweepAxis;
  baseConfig:      Record<string, unknown>;
  windowsConfig:   WalkForwardConfig;
  status:          'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress:        number;
  results:         WindowResult[] | null;
  aggregate:       WalkForwardAggregate | null;
  runError:        string | null;
  startedAt:       Date | null;
  completedAt:     Date | null;
  createdAt:       Date;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface CreateWalkForwardInput {
  axis:           SweepAxis;
  baseConfig:     Record<string, unknown>;
  windowsConfig:  WalkForwardConfig;
}

export async function createWalkForward(
  userId: string,
  parentSessionId: string,
  input: CreateWalkForwardInput,
): Promise<WalkForwardRow> {
  const parent = await prisma.backtestSession.findFirst({
    where: { id: parentSessionId, userId },
  });
  if (!parent) throw new AppError('Session not found', 404);
  if (parent.mode !== 'AUTO') {
    throw new AppError('Walk-forward only supported on AUTO sessions.', 400);
  }
  if (!parent.timeframe) {
    throw new AppError('Parent session has no timeframe configured.', 400);
  }
  if (input.axis.values.length < 2) {
    throw new AppError('Walk-forward needs at least 2 parameter values to compare.', 400);
  }
  if (input.axis.values.length > 20) {
    // Tighter cap than the basic sweep — each value is run N_windows × 2 times.
    throw new AppError('Walk-forward limited to 20 parameter values.', 400);
  }
  if (input.windowsConfig.windows < 2 || input.windowsConfig.windows > 12) {
    throw new AppError('Walk-forward windows must be between 2 and 12.', 400);
  }
  if (input.windowsConfig.isRatio < 0.3 || input.windowsConfig.isRatio > 0.9) {
    throw new AppError('IS ratio must be between 0.3 and 0.9.', 400);
  }

  const wf = await prisma.backtestWalkForward.create({
    data: {
      userId,
      parentSessionId,
      axis:          input.axis           as unknown as Prisma.InputJsonValue,
      baseConfig:    input.baseConfig     as Prisma.InputJsonValue,
      windowsConfig: input.windowsConfig  as unknown as Prisma.InputJsonValue,
      status:        'PENDING',
      progress:      0,
    },
  });

  runWalkForward(wf.id).catch(err => {
    logger.error(`WalkForward ${wf.id} crashed during dispatch: ${err instanceof Error ? err.message : String(err)}`);
  });

  return mapRow(wf);
}

async function runWalkForward(wfId: string): Promise<void> {
  const wf = await prisma.backtestWalkForward.findUnique({ where: { id: wfId } });
  if (!wf) {
    logger.error(`runWalkForward called with unknown id ${wfId}`);
    return;
  }
  const parent = await prisma.backtestSession.findUnique({ where: { id: wf.parentSessionId } });
  if (!parent) {
    await markFailed(wfId, 'Parent session was deleted before walk-forward started');
    return;
  }
  if (!parent.timeframe) {
    await markFailed(wfId, 'Parent session has no timeframe configured');
    return;
  }

  const axis    = wf.axis as unknown as SweepAxis;
  const base    = wf.baseConfig as unknown as Record<string, unknown>;
  const wConfig = wf.windowsConfig as unknown as WalkForwardConfig;

  await prisma.backtestWalkForward.update({
    where: { id: wfId },
    data:  { status: 'RUNNING', startedAt: new Date() },
  });

  // Single candle fetch — shared across all windows.
  let candles: PureCandle[];
  try {
    const rows = await getCandles(
      parent.symbol, parent.instrumentType, parent.timeframe,
      parent.startDate, parent.endDate,
    );
    candles = rows as PureCandle[];
  } catch (err) {
    await markFailed(wfId, `Candle fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const n = candles.length;
  if (n < wConfig.windows * 10) {
    await markFailed(
      wfId,
      `Not enough candles for ${wConfig.windows} windows (got ${n}, need at least ${wConfig.windows * 10}). ` +
      `Use a longer date range, smaller timeframe, or fewer windows.`,
    );
    return;
  }

  const barsPerWindow = Math.floor(n / wConfig.windows);
  const isBarsPerWin  = Math.floor(barsPerWindow * wConfig.isRatio);

  if (isBarsPerWin < 5 || (barsPerWindow - isBarsPerWin) < 5) {
    await markFailed(
      wfId,
      `Each window must have ≥5 IS bars and ≥5 OOS bars. ` +
      `Got IS=${isBarsPerWin}, OOS=${barsPerWindow - isBarsPerWin} per window. ` +
      `Reduce window count or adjust isRatio.`,
    );
    return;
  }

  // Pre-compute signals for every axis value ONCE on the FULL candle series.
  // Slicing candles per window and regenerating signals on the short slice
  // restarts indicator warmup inside each window — for a slow strategy
  // (e.g. SMA-30) that ate the entire ~35-bar OOS slice and every OOS
  // window came back with 0 trades (false "no edge" verdict). Generating
  // on the full history first, then slicing the aligned signal array,
  // preserves warmup so OOS windows actually trade. Indicators only look
  // backward, so a signal at bar i never uses future data — slicing the
  // signal array introduces no look-ahead.
  const signalsByParam = new Map<number, Signal[]>();
  for (const value of axis.values) {
    try {
      const cfg = buildEngineConfig(base, parent.startingBalance, parent.instrumentType, axis.paramKey, value);
      signalsByParam.set(
        value,
        generateSignalsPure(candles, cfg.strategyType, cfg.strategyConfig, cfg.customStrategy),
      );
    } catch (err) {
      logger.warn(`WF ${wfId}: signal precompute failed for ${axis.paramKey}=${value}: ${err instanceof Error ? err.message : String(err)}`);
      signalsByParam.set(value, new Array(candles.length).fill(null));
    }
  }

  const totalIterations = wConfig.windows * (axis.values.length + 1); // +1 = OOS validation per window
  let doneIterations = 0;
  const windowResults: WindowResult[] = [];

  for (let w = 0; w < wConfig.windows; w++) {
    const winStart = w * barsPerWindow;
    const winEnd   = (w === wConfig.windows - 1) ? n : (w + 1) * barsPerWindow;
    const isEnd    = winStart + isBarsPerWin;

    const isSlice   = candles.slice(winStart, isEnd);
    const oosSlice  = candles.slice(isEnd, winEnd);

    // Phase A: run every paramValue on the IS slice. Signals are sliced from
    // the full-series precompute (warmup preserved), NOT regenerated on the
    // short slice.
    const isResults: SweepIterationMetrics[] = [];
    for (const value of axis.values) {
      try {
        const cfg = buildEngineConfig(base, parent.startingBalance, parent.instrumentType, axis.paramKey, value);
        const isSignals = (signalsByParam.get(value) ?? []).slice(winStart, isEnd);
        const { closedTrades, finalBalance, diagnostics } = runEngineInline(
          isSlice, isSignals, cfg, parent.symbol, () => { /* no-op */ },
        );
        isResults.push(summariseIteration(value, closedTrades, parent.startingBalance, finalBalance, diagnostics));
      } catch (err) {
        isResults.push(emptyMetrics(value, parent.startingBalance, `IS iteration failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      doneIterations++;
      // Persist progress after each iteration so the UI updates in real time.
      await prisma.backtestWalkForward.update({
        where: { id: wfId },
        data:  { progress: Math.round((doneIterations / totalIterations) * 100) },
      });
    }

    // Phase B: pick IS-best by selected metric. Skip iterations with zero
    // trades — they can't be "best."
    const isBestParam = pickBest(isResults, wConfig.selectionMetric);
    const selection   = assessSelection(isResults, wConfig.selectionMetric, isBestParam);

    // Phase C: re-run IS-best on the OOS slice.
    let oosMetrics: SweepIterationMetrics;
    try {
      const cfg = buildEngineConfig(base, parent.startingBalance, parent.instrumentType, axis.paramKey, isBestParam);
      const oosSignals = (signalsByParam.get(isBestParam) ?? []).slice(isEnd, winEnd);
      const { closedTrades, finalBalance, diagnostics } = runEngineInline(
        oosSlice, oosSignals, cfg, parent.symbol, () => { /* no-op */ },
      );
      oosMetrics = summariseIteration(isBestParam, closedTrades, parent.startingBalance, finalBalance, diagnostics);
    } catch (err) {
      oosMetrics = emptyMetrics(isBestParam, parent.startingBalance, `OOS validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    doneIterations++;

    windowResults.push({
      windowIndex:  w,
      isStartDate:  isSlice[0]?.openTime.toISOString() ?? '',
      isEndDate:    isSlice[isSlice.length - 1]?.openTime.toISOString() ?? '',
      oosStartDate: oosSlice[0]?.openTime.toISOString() ?? '',
      oosEndDate:   oosSlice[oosSlice.length - 1]?.openTime.toISOString() ?? '',
      isResults,
      isBestParam,
      isBestReliable:   selection.reliable,
      selectionWarning: selection.reason,
      oosMetrics,
    });

    await prisma.backtestWalkForward.update({
      where: { id: wfId },
      data: {
        progress: Math.round((doneIterations / totalIterations) * 100),
        results:  windowResults as unknown as Prisma.InputJsonValue,
      },
    });
  }

  const aggregate = computeAggregate(windowResults);

  await prisma.backtestWalkForward.update({
    where: { id: wfId },
    data: {
      status:      'COMPLETED',
      progress:    100,
      results:     windowResults as unknown as Prisma.InputJsonValue,
      aggregate:   aggregate     as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function pickBest(
  results: SweepIterationMetrics[],
  metric:  SelectionMetric,
): number {
  // Filter out zero-trade rows — they have all-zero metrics that would
  // otherwise tie with legitimately-zero results.
  const eligible = results.filter(r => r.tradeCount > 0);
  if (eligible.length === 0) {
    // Fall back to the first param value so the OOS leg still runs.
    return results[0]?.paramValue ?? 0;
  }
  let best = eligible[0];
  for (const r of eligible) {
    if (r[metric] > best[metric]) best = r;
  }
  return best.paramValue;
}

// Minimum in-sample trades for an IS-best selection to be statistically
// meaningful. Matches sweepService's "Sample size <5 trades" convention.
export const MIN_RELIABLE_IS_TRADES = 5;

export interface SelectionAssessment {
  reliable:       boolean;
  reason:         string | null;
  eligibleCount:  number; // params that produced >0 IS trades
  bestTradeCount: number; // IS trade count of the chosen param
}

// Classifies whether pickBest's choice was a real metric-driven optimum or a
// degenerate fallback. pickBest itself MUST keep returning a number (the OOS
// leg still needs a param to run), so this is a separate analysis layer that
// the orchestrator records on each WindowResult instead of silently
// presenting an arbitrary param as if the metric had chosen it (SR9).
export function assessSelection(
  results:   SweepIterationMetrics[],
  metric:    SelectionMetric,
  bestParam: number,
  minTrades: number = MIN_RELIABLE_IS_TRADES,
): SelectionAssessment {
  const eligible       = results.filter(r => r.tradeCount > 0);
  const bestTradeCount = results.find(r => r.paramValue === bestParam)?.tradeCount ?? 0;

  if (eligible.length === 0) {
    return {
      reliable: false,
      reason: `No parameter produced any in-sample trades — IS-best (${bestParam}) is an arbitrary fallback, not a ${metric}-driven choice. The OOS result is not meaningful; widen the date range or loosen the strategy.`,
      eligibleCount: 0,
      bestTradeCount,
    };
  }

  // Compare metric values at the precision the UI displays. Raw floats that
  // differ by 1e-4 still render as identical "0.00" — without this epsilon
  // the picker would crown one as "best" when the user sees them tied.
  const metricVals = eligible.map(r => r[metric]);
  // sharpe / profitFactor render at 2 dp → ±0.005 is invisible
  // totalPnl renders at 0 dp → ±0.5 is invisible
  const TIE_EPSILON: Record<SelectionMetric, number> = {
    sharpe:       0.005,
    profitFactor: 0.005,
    totalPnl:     0.5,
  };
  if (Math.max(...metricVals) - Math.min(...metricVals) < TIE_EPSILON[metric]) {
    return {
      reliable: false,
      reason: `All ${eligible.length} in-sample parameters tie on ${metric} (=${metricVals[0]}). IS-best (${bestParam}) is just the first by order, not a real optimum — changing the selection metric will not change the result.`,
      eligibleCount: eligible.length,
      bestTradeCount,
    };
  }

  if (bestTradeCount < minTrades) {
    return {
      reliable: false,
      reason: `IS-best (${bestParam}) was chosen on only ${bestTradeCount} in-sample trade${bestTradeCount === 1 ? '' : 's'} (<${minTrades}) — too few for ${metric} to be statistically meaningful.`,
      eligibleCount: eligible.length,
      bestTradeCount,
    };
  }

  return { reliable: true, reason: null, eligibleCount: eligible.length, bestTradeCount };
}

export function computeAggregate(windows: WindowResult[]): WalkForwardAggregate {
  if (windows.length === 0) {
    return {
      avgIsSharpe: 0, avgOosSharpe: 0,
      avgIsPnl:    0, avgOosPnl:    0,
      decayRatio:  0, oosWinRate:   0,
      consistencyScore: 0, overfitWarning: false,
    };
  }
  // For IS metrics use the chosen best param's IS row, not the average across
  // all params — that's what would actually be deployed.
  const isBestRows  = windows.map(w => w.isResults.find(r => r.paramValue === w.isBestParam) ?? w.isResults[0]);
  const isSharpes   = isBestRows.map(r => r.sharpe);
  const isPnls      = isBestRows.map(r => r.totalPnl);
  const oosSharpes  = windows.map(w => w.oosMetrics.sharpe);
  const oosPnls     = windows.map(w => w.oosMetrics.totalPnl);

  const avg = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const avgIsSharpe  = avg(isSharpes);
  const avgOosSharpe = avg(oosSharpes);
  const avgIsPnl     = avg(isPnls);
  const avgOosPnl    = avg(oosPnls);

  // Decay = ratio of OOS to IS Sharpe. 1.0 = no decay, 0 = total collapse.
  // Clamp to [0, ∞) so a negative IS doesn't produce a misleading positive.
  const decayRatio = avgIsSharpe > 0 ? Math.max(0, avgOosSharpe / avgIsSharpe) : 0;
  const oosWinRate       = windows.filter(w => w.oosMetrics.totalPnl > 0).length / windows.length;
  const consistencyScore = windows.filter(w => w.oosMetrics.sharpe > 0).length / windows.length;
  const overfitWarning   = avgIsSharpe > 0.1 && avgOosSharpe <= 0;

  return {
    avgIsSharpe:      round3(avgIsSharpe),
    avgOosSharpe:     round3(avgOosSharpe),
    avgIsPnl:         round2(avgIsPnl),
    avgOosPnl:        round2(avgOosPnl),
    decayRatio:       round3(decayRatio),
    oosWinRate:       round3(oosWinRate),
    consistencyScore: round3(consistencyScore),
    overfitWarning,
  };
}

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

function emptyMetrics(paramValue: number, startingBalance: number, warning: string): SweepIterationMetrics {
  return {
    paramValue, tradeCount: 0,
    totalPnl: 0, totalPnlPct: 0, winRate: 0, profitFactor: 0,
    sharpe: 0, maxDrawdown: 0, forceClosedPct: 0,
    finalBalance: startingBalance, warnings: [warning],
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

async function markFailed(wfId: string, reason: string): Promise<void> {
  await prisma.backtestWalkForward.update({
    where: { id: wfId },
    data: {
      status:      'FAILED',
      runError:    reason,
      completedAt: new Date(),
    },
  });
}

// ── Read API ─────────────────────────────────────────────────────────────────

export async function getWalkForward(userId: string, wfId: string): Promise<WalkForwardRow> {
  const wf = await prisma.backtestWalkForward.findFirst({ where: { id: wfId, userId } });
  if (!wf) throw new AppError('Walk-forward not found', 404);
  return mapRow(wf);
}

export async function listWalkForwardsForSession(userId: string, parentSessionId: string): Promise<WalkForwardRow[]> {
  const wfs = await prisma.backtestWalkForward.findMany({
    where: { userId, parentSessionId },
    orderBy: { createdAt: 'desc' },
  });
  return wfs.map(mapRow);
}

function mapRow(row: {
  id: string; userId: string; parentSessionId: string;
  axis: unknown; baseConfig: unknown; windowsConfig: unknown;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress: number; results: unknown; aggregate: unknown; runError: string | null;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
}): WalkForwardRow {
  return {
    id:              row.id,
    userId:          row.userId,
    parentSessionId: row.parentSessionId,
    axis:            row.axis as SweepAxis,
    baseConfig:      row.baseConfig as Record<string, unknown>,
    windowsConfig:   row.windowsConfig as WalkForwardConfig,
    status:          row.status,
    progress:        row.progress,
    results:         (row.results as WindowResult[] | null) ?? null,
    aggregate:       (row.aggregate as WalkForwardAggregate | null) ?? null,
    runError:        row.runError,
    startedAt:       row.startedAt,
    completedAt:     row.completedAt,
    createdAt:       row.createdAt,
  };
}
