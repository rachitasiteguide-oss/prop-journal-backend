import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';
import { BacktestStatus, TradeSide, TradeStatus, Prisma } from '@prisma/client';
import { runAutomatedBacktest, type EngineConfig } from './backtestEngine';
import { calcRawPnl, getContractMultiplier } from './backtestEngineCore';
import { type StrategyType } from './strategyDefinitions';
import { getCachedCandles } from './candleService';

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function getSessions(userId: string) {
  return prisma.backtestSession.findMany({
    where: { userId },
    include: { trades: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getSession(userId: string, id: string) {
  const session = await prisma.backtestSession.findFirst({
    where: { id, userId },
    include: { trades: { orderBy: { entryAt: 'asc' } } },
  });
  if (!session) throw new AppError('Session not found', 404);
  return session;
}

export const SUPPORTED_INSTRUMENT_TYPES = ['FOREX', 'STOCKS', 'FUTURES', 'CRYPTO', 'CFD'] as const;
export type SupportedInstrumentType = typeof SUPPORTED_INSTRUMENT_TYPES[number];

export async function createSession(userId: string, data: {
  name: string; symbol: string; instrumentType?: string;
  startDate: Date; endDate: Date; startingBalance?: number; notes?: string;
  mode?: 'MANUAL' | 'AUTO';
  timeframe?: string;
  strategyType?: string;
  strategyConfig?: Record<string, unknown>;
}) {
  const balance = data.startingBalance ?? 10000;
  const instrumentType = data.instrumentType ?? 'FOREX';
  if (!SUPPORTED_INSTRUMENT_TYPES.includes(instrumentType as SupportedInstrumentType)) {
    throw new AppError(
      `Unsupported instrumentType "${instrumentType}". Expected one of ${SUPPORTED_INSTRUMENT_TYPES.join(', ')}.`,
      400,
    );
  }
  return prisma.backtestSession.create({
    data: {
      userId,
      name:            data.name,
      symbol:          data.symbol,
      instrumentType,
      startDate:       data.startDate,
      endDate:         data.endDate,
      startingBalance: balance,
      currentBalance:  balance,
      notes:           data.notes ?? null,
      mode:            data.mode ?? 'MANUAL',
      timeframe:       data.timeframe ?? null,
      strategyType:    data.strategyType ?? null,
      strategyConfig:  data.strategyConfig as Prisma.InputJsonValue | undefined,
    },
    include: { trades: true },
  });
}

export async function updateSession(userId: string, id: string, data: {
  name?: string; status?: BacktestStatus; notes?: string;
}) {
  const existing = await prisma.backtestSession.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError('Session not found', 404);
  return prisma.backtestSession.update({ where: { id }, data, include: { trades: true } });
}

export async function deleteSession(userId: string, id: string) {
  const existing = await prisma.backtestSession.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError('Session not found', 404);
  await prisma.backtestSession.delete({ where: { id } });
}

// ── Trades ───────────────────────────────────────────────────────────────────

export async function addTrade(userId: string, sessionId: string, data: {
  symbol: string; side: TradeSide; entryPrice: number; exitPrice?: number;
  volume?: number; stopLoss?: number; takeProfit?: number; entryAt: Date;
  exitAt?: Date; notes?: string;
}) {
  // Verify session belongs to user
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  // Calculate P&L if exit price provided
  let pnl: number | null = null;
  let pnlPct: number | null = null;
  let status: TradeStatus = 'OPEN';

  if (data.exitPrice != null && data.exitPrice > 0) {
    const rawPnl = calcRawPnl(
      data.side, data.entryPrice, data.exitPrice, data.volume ?? 1, session.instrumentType, session.symbol,
    );
    pnl = parseFloat(rawPnl.toFixed(2));
    pnlPct = parseFloat(((pnl / session.startingBalance) * 100).toFixed(4));
    status = 'CLOSED';
  }

  const trade = await prisma.backtestTrade.create({
    data: {
      sessionId,
      symbol: data.symbol,
      side: data.side,
      entryPrice: data.entryPrice,
      exitPrice: data.exitPrice ?? null,
      volume: data.volume ?? 1,
      stopLoss: data.stopLoss ?? null,
      takeProfit: data.takeProfit ?? null,
      pnl,
      pnlPct,
      status,
      entryAt: data.entryAt,
      exitAt: data.exitAt ?? null,
      notes: data.notes ?? null,
    },
  });

  // Update session current balance
  if (pnl !== null) {
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { increment: pnl } },
    });
  }

  return trade;
}

export async function updateTrade(userId: string, sessionId: string, tradeId: string, data: {
  exitPrice?: number; exitAt?: Date; stopLoss?: number; takeProfit?: number; notes?: string; status?: TradeStatus;
}) {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  const trade = await prisma.backtestTrade.findFirst({ where: { id: tradeId, sessionId } });
  if (!trade) throw new AppError('Trade not found', 404);

  let pnl = trade.pnl;
  let pnlPct = trade.pnlPct;
  let status = data.status ?? trade.status;

  if (data.exitPrice != null && trade.exitPrice == null) {
    const newPnl = parseFloat(
      calcRawPnl(
        trade.side, trade.entryPrice, data.exitPrice, trade.volume, session.instrumentType, session.symbol,
      ).toFixed(2),
    );
    const newPnlPct = parseFloat(((newPnl / session.startingBalance) * 100).toFixed(4));
    pnl = newPnl;
    pnlPct = newPnlPct;
    status = 'CLOSED';
    // Update balance
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { increment: newPnl } },
    });
  }

  return prisma.backtestTrade.update({
    where: { id: tradeId },
    data: { ...data, pnl, pnlPct, status },
  });
}

export async function bulkAddTrades(userId: string, sessionId: string, trades: Array<{
  symbol: string; side: TradeSide; entryPrice: number; exitPrice?: number;
  volume?: number; stopLoss?: number; takeProfit?: number; entryAt: Date;
  exitAt?: Date; notes?: string;
}>) {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  let balanceDelta = 0;
  const created = [];

  for (const data of trades) {
    let pnl: number | null = null;
    let pnlPct: number | null = null;
    let status: TradeStatus = 'OPEN';

    if (data.exitPrice != null && data.exitPrice > 0) {
      pnl = parseFloat(
        calcRawPnl(
          data.side, data.entryPrice, data.exitPrice, data.volume ?? 1, session.instrumentType, session.symbol,
        ).toFixed(2),
      );
      pnlPct = parseFloat(((pnl / session.startingBalance) * 100).toFixed(4));
      status = 'CLOSED';
      balanceDelta += pnl;
    }

    const trade = await prisma.backtestTrade.create({
      data: {
        sessionId,
        symbol: data.symbol,
        side: data.side,
        entryPrice: data.entryPrice,
        exitPrice: data.exitPrice ?? null,
        volume: data.volume ?? 1,
        stopLoss: data.stopLoss ?? null,
        takeProfit: data.takeProfit ?? null,
        pnl,
        pnlPct,
        status,
        entryAt: data.entryAt,
        exitAt: data.exitAt ?? null,
        notes: data.notes ?? null,
      },
    });
    created.push(trade);
  }

  if (balanceDelta !== 0) {
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { increment: balanceDelta } },
    });
  }

  return created;
}

export async function deleteTrade(userId: string, sessionId: string, tradeId: string) {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);
  const trade = await prisma.backtestTrade.findFirst({ where: { id: tradeId, sessionId } });
  if (!trade) throw new AppError('Trade not found', 404);

  // Reverse balance if trade was closed
  if (trade.pnl !== null) {
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { decrement: trade.pnl } },
    });
  }
  await prisma.backtestTrade.delete({ where: { id: tradeId } });
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export async function getSessionAnalytics(userId: string, sessionId: string) {
  const session = await getSession(userId, sessionId);
  const trades = session.trades.filter((t) => t.status === 'CLOSED');

  const totalTrades = trades.length;
  const winners = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losers = trades.filter((t) => (t.pnl ?? 0) < 0);
  const breakeven = trades.filter((t) => (t.pnl ?? 0) === 0);

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + (t.pnl ?? 0), 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + (t.pnl ?? 0), 0) / losers.length : 0;
  const bestWin = winners.length > 0 ? Math.max(...winners.map((t) => t.pnl ?? 0)) : 0;
  const worstLoss = losers.length > 0 ? Math.min(...losers.map((t) => t.pnl ?? 0)) : 0;

  const profitFactor = Math.abs(avgLoss) > 0 ? Math.abs(avgWin * winners.length) / Math.abs(avgLoss * losers.length) : 0;

  // Equity curve — the public series stays trade-close-to-trade-close so
  // the rendered chart isn't polluted with mid-trade troughs. Intra-trade
  // troughs are still considered for drawdown below.
  let runningBalance = session.startingBalance;
  const equityCurve = [{ date: session.startDate.toISOString(), balance: runningBalance }];
  for (const t of trades) {
    runningBalance += t.pnl ?? 0;
    equityCurve.push({ date: (t.exitAt ?? t.entryAt).toISOString(), balance: parseFloat(runningBalance.toFixed(2)) });
  }

  // Drawdown — HWM-to-trough including intra-trade excursion. The classic
  // close-to-close calc understates true MDD by an order of magnitude for
  // long-held positions (e.g. a trade that drew down 50% and recovered to
  // +5% would report 0% DD on the trade-close curve).
  let peak = session.startingBalance;
  let maxDrawdown = 0;
  let eq = session.startingBalance;
  for (const t of trades) {
    // Mid-trade trough = equity-at-entry − peak adverse excursion. We treat
    // it as a transient point that doesn't update `peak`, but does count
    // toward MDD.
    const trade = t as typeof t & { maxAdverse?: number | null };
    const mae = Number(trade.maxAdverse ?? 0);
    if (mae > 0) {
      const trough = eq - mae;
      const dd = peak > 0 ? ((peak - trough) / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    eq += t.pnl ?? 0;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Performance by day of week
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = dayLabels.map((day, i) => {
    const dayTrades = trades.filter((t) => {
      const d = new Date(t.exitAt ?? t.entryAt).getDay();
      const mapped = d === 0 ? 6 : d - 1; // convert Sun=0 to Mon=0 index
      return mapped === i;
    });
    const pnl = dayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return { day, pnl: parseFloat(pnl.toFixed(2)), trades: dayTrades.length };
  });

  // Performance by hour
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const hourTrades = trades.filter((t) => new Date(t.exitAt ?? t.entryAt).getHours() === h);
    const pnl = hourTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return { hour: h, pnl: parseFloat(pnl.toFixed(2)), trades: hourTrades.length };
  }).filter((h) => h.trades > 0);

  // Buy vs Sell
  const buyTrades = trades.filter((t) => t.side === 'BUY');
  const sellTrades = trades.filter((t) => t.side === 'SELL');
  const bySide = {
    buy: { trades: buyTrades.length, winRate: buyTrades.length > 0 ? (buyTrades.filter(t => (t.pnl ?? 0) > 0).length / buyTrades.length) * 100 : 0, pnl: buyTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) },
    sell: { trades: sellTrades.length, winRate: sellTrades.length > 0 ? (sellTrades.filter(t => (t.pnl ?? 0) > 0).length / sellTrades.length) * 100 : 0, pnl: sellTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) },
  };

  // Performance by month
  const byMonth: Record<string, { pnl: number; trades: number }> = {};
  for (const t of trades) {
    const key = new Date(t.exitAt ?? t.entryAt).toISOString().slice(0, 7);
    if (!byMonth[key]) byMonth[key] = { pnl: 0, trades: 0 };
    byMonth[key].pnl += t.pnl ?? 0;
    byMonth[key].trades += 1;
  }

  // Duration stats
  const avgDuration = trades.length > 0 ? trades.reduce((s, t) => {
    if (!t.exitAt) return s;
    return s + (new Date(t.exitAt).getTime() - new Date(t.entryAt).getTime());
  }, 0) / trades.length / 1000 / 60 : 0; // in minutes

  // ── Standard quant metrics ────────────────────────────────────────────────
  // All computed on a per-trade-return basis. Returns are pnl / equity-at-
  // entry, which is what each trade actually risked the strategy against.
  // No risk-free rate adjustment — assumes 0% for backtest comparability.
  const tradeReturns: number[] = [];
  let eqForReturns = session.startingBalance;
  for (const t of trades) {
    const r = eqForReturns > 0 ? (t.pnl ?? 0) / eqForReturns : 0;
    tradeReturns.push(r);
    eqForReturns += t.pnl ?? 0;
  }
  const mean = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((s, x) => s + x, 0) / arr.length;
  const stdev = (arr: number[]) => {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const sq = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(sq);
  };
  const meanReturn = mean(tradeReturns);
  const stdReturn  = stdev(tradeReturns);
  const downside   = tradeReturns.filter((r) => r < 0);
  const downsideStd = stdev(downside);
  // Sharpe and Sortino are PER-TRADE here (not annualised). Annualising would
  // require a trade frequency assumption (trades/year) that varies by run; we
  // report the raw ratio so it remains directly comparable across backtests
  // run on the same strategy/timeframe.
  // Guard against tiny-sample blow-ups: with a handful of trades the
  // downside (or total) deviation can be a near-zero number, sending the
  // ratio to absurd values (observed 943 Sortino on 4 trades). Require a
  // minimum sample, an epsilon floor on the denominator, and clamp the
  // result to a sane band — a per-trade Sharpe/Sortino realistically never
  // exceeds single digits; anything past that is noise, not skill.
  const RATIO_EPS = 1e-9;
  const RATIO_CAP = 20;
  const clampRatio = (x: number) =>
    !Number.isFinite(x) ? 0 : Math.max(-RATIO_CAP, Math.min(RATIO_CAP, x));
  const sharpe = (tradeReturns.length >= 2 && stdReturn > RATIO_EPS)
    ? clampRatio(meanReturn / stdReturn)
    : 0;
  const sortino = (downside.length >= 2 && downsideStd > RATIO_EPS)
    ? clampRatio(meanReturn / downsideStd)
    : 0;

  // CAGR over the actual run window. Uses the persisted run dates, not the
  // configured session range — they're identical for AUTO sessions.
  const runDays = Math.max(
    1,
    (new Date(session.endDate).getTime() - new Date(session.startDate).getTime()) / (1000 * 60 * 60 * 24),
  );
  const finalBalance = session.startingBalance + totalPnl;
  const cagr = session.startingBalance > 0 && finalBalance > 0
    ? (Math.pow(finalBalance / session.startingBalance, 365 / runDays) - 1) * 100
    : 0;

  // Expectancy: average $ per trade. Most intuitive when looking at scaling
  // up — multiply by expected number of trades/period to estimate gross.
  const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0;

  // R-multiple: net P&L ÷ initial dollar risk. The dollar risk must be
  // computed at the SAME scale as pnl. pnl = priceDiff × volume × instrument
  // multiplier − commission, so initial risk = |entry − stopLoss| × volume ×
  // instrument multiplier. Pull from the same single source of truth as
  // calcRawPnl so symbol-specific overrides (XAU=100, XAG=5000) stay in sync.
  const instrumentMultiplier = getContractMultiplier(session.symbol, session.instrumentType);
  const rMultiples = trades
    .map((t) => {
      if (t.stopLoss == null) return null;
      const riskPrice = Math.abs(t.entryPrice - t.stopLoss);
      if (riskPrice === 0 || t.volume <= 0) return null;
      const dollarRisk = riskPrice * t.volume * instrumentMultiplier;
      if (dollarRisk <= 0) return null;
      return (t.pnl ?? 0) / dollarRisk;
    })
    .filter((x): x is number => x !== null);
  const avgRMultiple = mean(rMultiples);

  // Ambiguous-exit ratio — bars where both SL and TP were hit on the same
  // candle, with SL taking priority by Rule 2. Above ~30% means a meaningful
  // share of "losses" are arbitrary tie-breaks the backtester resolved one
  // way but live execution could go either way.
  const ambiguousCount = trades.filter((t) => t.ambiguous === true).length;
  const ambiguousPct   = totalTrades > 0 ? (ambiguousCount / totalTrades) * 100 : 0;

  // Cost-vs-edge sanity. If round-trip commission exceeds the average
  // gross-per-trade gain, the strategy is a guaranteed loser no matter the
  // signal. Surface explicitly — the bottom-line balance hides it.
  const avgGrossPerTrade = totalTrades > 0
    ? trades.reduce((s, t) => s + Math.abs(t.pnl ?? 0) + (t.commission ?? 0), 0) / totalTrades
    : 0;
  const avgCommissionPerTrade = totalTrades > 0
    ? trades.reduce((s, t) => s + (t.commission ?? 0), 0) / totalTrades
    : 0;
  const costsExceedEdge = avgCommissionPerTrade > 0
    && totalTrades >= 5
    && avgCommissionPerTrade >= Math.abs(expectancy)
    && expectancy <= 0;

  // Force-close ratio — visible across every run, not just zero-trade runs.
  // Above 20% means the strategy's reported edge is partly an artefact of
  // where the data window ended.
  const forceClosedCount = trades.filter((t) => {
    const tx = t as typeof t & { forceClosed?: boolean | null };
    return tx.forceClosed === true;
  }).length;
  const forceClosedPct = totalTrades > 0 ? (forceClosedCount / totalTrades) * 100 : 0;

  // Surface engine-emitted diagnostics so the UI can explain a zero-trade
  // run without forcing the user to re-run anything. Falls back to an
  // inferred reason for legacy sessions that pre-date the runDiagnostics
  // column (e.g. an empty trade list with no diagnostics is most likely an
  // older run from before the column existed).
  const sessionLike = session as typeof session & { runDiagnostics?: unknown };
  const diagnostics = (sessionLike.runDiagnostics ?? null) as
    | (import('./backtestEngineCore').RunDiagnostics)
    | null;

  let emptyReason: string | undefined;
  if (totalTrades === 0) {
    if (diagnostics?.emptyReason) {
      emptyReason = diagnostics.emptyReason;
    } else if (session.runStatus === 'FAILED') {
      emptyReason = `Run failed: ${session.runError ?? 'unknown error'}.`;
    } else if (session.runStatus !== 'COMPLETED') {
      emptyReason = `Run is ${session.runStatus.toLowerCase()} — wait for it to complete.`;
    } else {
      emptyReason = 'No trades were produced. Re-run the backtest to capture detailed diagnostics.';
    }
  }

  return {
    session: { ...session, trades: undefined },
    trades: session.trades,
    diagnostics,
    emptyReason,
    metrics: {
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      totalPnlPct: parseFloat(((totalPnl / session.startingBalance) * 100).toFixed(2)),
      currentBalance: parseFloat(session.currentBalance.toFixed(2)),
      winRate: parseFloat(winRate.toFixed(2)),
      totalTrades,
      winners: winners.length,
      losers: losers.length,
      breakeven: breakeven.length,
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      bestWin: parseFloat(bestWin.toFixed(2)),
      worstLoss: parseFloat(worstLoss.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      avgDurationMinutes: parseFloat(avgDuration.toFixed(0)),
      sharpe:        parseFloat(sharpe.toFixed(3)),
      sortino:       parseFloat(sortino.toFixed(3)),
      cagr:          parseFloat(cagr.toFixed(2)),
      expectancy:    parseFloat(expectancy.toFixed(2)),
      avgRMultiple:  parseFloat(avgRMultiple.toFixed(2)),
      forceClosed:    forceClosedCount,
      forceClosedPct: parseFloat(forceClosedPct.toFixed(1)),
      ambiguous:      ambiguousCount,
      ambiguousPct:   parseFloat(ambiguousPct.toFixed(1)),
      avgCommissionPerTrade: parseFloat(avgCommissionPerTrade.toFixed(2)),
      avgGrossPerTrade:      parseFloat(avgGrossPerTrade.toFixed(2)),
      costsExceedEdge,
    },
    equityCurve,
    byDay,
    byHour,
    bySide,
    byMonth,
  };
}

// ── Automated run functions ───────────────────────────────────────────────────

// Stores run config on the session, then executes the backtest synchronously.
// For MVP the HTTP request waits for completion (controller should allow 120 s).
export async function triggerRun(
  userId: string,
  sessionId: string,
  params: {
    timeframe:       string;
    strategyType:    StrategyType;
    strategyConfig:  Record<string, number | string>;
    customStrategy?: Record<string, unknown>;
    volume:          number;
    stopLossPct:     number;
    takeProfitRatio: number;
    slippagePct:     number;
    commission:      number;
    maxOpenPositions: number;
    propFirmRules?:  import('./backtestEngineCore').PropFirmRulesConfig;
    sizing?:         import('./backtestEngineCore').SizingConfig;
  },
): Promise<void> {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  // "Run Again" on the analytics page resubmits without the full builder
  // payload — fall back to the DSL we persisted on the previous run.
  const sessionRow = session as typeof session & { customStrategy?: unknown };
  const effectiveCustomStrategy = (params.customStrategy ?? sessionRow.customStrategy ?? undefined) as
    | import('./customStrategyInterpreter').CustomStrategyDSL
    | undefined;

  // Same fallback for prop-firm rules — Run Again without explicit rules
  // should keep the previous run's challenge config.
  const persistedConfig = (session.strategyConfig as Record<string, unknown> | null) ?? {};
  const effectivePropFirmRules =
    params.propFirmRules
    ?? (persistedConfig.propFirmRules as
        import('./backtestEngineCore').PropFirmRulesConfig
        | undefined);

  // Same fallback for sizing config.
  const effectiveSizing =
    params.sizing
    ?? (persistedConfig.sizing as
        import('./backtestEngineCore').SizingConfig
        | undefined);

  if (params.strategyType === 'CUSTOM' && !effectiveCustomStrategy) {
    throw new AppError(
      'CUSTOM strategy requires a customStrategy DSL. Open the strategy builder and save your rules.',
      400,
    );
  }

  // Persist the run config on the session before execution starts.
  // Merge slippage/commission/sizing into the JSON blob so the frontend
  // bias banner can read them from session.strategyConfig.
  await prisma.backtestSession.update({
    where: { id: sessionId },
    data: {
      timeframe:      params.timeframe,
      strategyType:   params.strategyType,
      strategyConfig: {
        ...params.strategyConfig,
        slippagePct:     params.slippagePct,
        commission:      params.commission,
        volume:          params.volume,
        stopLossPct:     params.stopLossPct,
        takeProfitRatio: params.takeProfitRatio,
        // Prop-firm rules persisted inside strategyConfig so "Run Again"
        // pre-populates them without a separate column.
        ...(effectivePropFirmRules ? { propFirmRules: effectivePropFirmRules } : {}),
        ...(effectiveSizing        ? { sizing:        effectiveSizing        } : {}),
      } as unknown as Prisma.InputJsonValue,
      // Store the DSL when CUSTOM; clear it otherwise so a session that
      // switches from CUSTOM to a built-in doesn't carry stale rules.
      customStrategy: params.strategyType === 'CUSTOM'
        ? (effectiveCustomStrategy as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });

  const config: EngineConfig = {
    strategyType:     params.strategyType,
    strategyConfig:   params.strategyConfig,
    customStrategy:   effectiveCustomStrategy,
    startingBalance:  session.startingBalance,
    volume:           params.volume,
    stopLossPct:      params.stopLossPct,
    takeProfitRatio:  params.takeProfitRatio,
    slippagePct:      params.slippagePct,
    commission:       params.commission,
    maxOpenPositions: params.maxOpenPositions,
    instrumentType:   session.instrumentType,
    propFirmRules:    effectivePropFirmRules,
    sizing:           effectiveSizing,
  };

  // Fire-and-forget: return immediately so the HTTP request doesn't time out.
  // runStatus / runProgress in the DB are updated by the engine; the frontend polls.
  runAutomatedBacktest(userId, sessionId, config).catch((err) => {
    logger.error(
      `Background backtest ${sessionId} crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export async function getRunStatus(
  userId: string,
  sessionId: string,
): Promise<{ runStatus: string; runProgress: number; runError: string | null }> {
  const session = await prisma.backtestSession.findFirst({
    where: { id: sessionId, userId },
    select: { runStatus: true, runProgress: true, runError: true },
  });
  if (!session) throw new AppError('Session not found', 404);
  return {
    runStatus:   session.runStatus,
    runProgress: session.runProgress,
    runError:    session.runError,
  };
}

// Returns candles from the local cache for the session's symbol/timeframe/range.
// Only populated after a successful run — returns [] if the session was never run.
export async function getSessionCandles(userId: string, sessionId: string) {
  const session = await prisma.backtestSession.findFirst({
    where: { id: sessionId, userId },
    select: { symbol: true, timeframe: true, startDate: true, endDate: true },
  });
  if (!session) throw new AppError('Session not found', 404);
  if (!session.timeframe) return [];

  return getCachedCandles(session.symbol, session.timeframe, session.startDate, session.endDate);
}
