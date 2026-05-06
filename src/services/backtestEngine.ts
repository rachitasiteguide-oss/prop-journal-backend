import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';
import { getCandles } from './candleService';
import { type StrategyType } from './strategyDefinitions';
import { calcSMA, calcEMA, calcRSI, calcMACD, calcBB } from './indicatorService';

// ── Public config interface ───────────────────────────────────────────────────

export interface EngineConfig {
  strategyType:     StrategyType;
  strategyConfig:   Record<string, number | string>;
  startingBalance:  number;
  volume:           number;
  stopLossPct:      number;        // e.g. 0.02 = 2% from entry
  takeProfitRatio:  number;        // TP distance = stopLossPct × ratio
  slippagePct:      number;        // REQUIRED — applied at entry (Rule 3)
  commission:       number;        // REQUIRED — deducted at close (Rule 4)
  maxOpenPositions: number;
  instrumentType:   string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface Candle {
  id:       string;
  symbol:   string;
  timeframe: string;
  openTime: Date;
  open:     number;
  high:     number;
  low:      number;
  close:    number;
  volume:   number;
}

interface OpenPosition {
  side:             'BUY' | 'SELL';
  entryPrice:       number;
  entryAt:          Date;
  stopLoss:         number;
  takeProfit:       number;
  volume:           number;
  slippage:         number;  // price-unit slippage (rawOpen × slippagePct)
}

interface TradeResult {
  symbol:     string;
  side:       'BUY' | 'SELL';
  entryPrice: number;
  exitPrice:  number;
  volume:     number;
  stopLoss:   number;
  takeProfit: number;
  pnl:        number;   // net after commission
  pnlPct:     number;
  commission: number;
  slippage:   number;
  ambiguous:  boolean;
  entryAt:    Date;
  exitAt:     Date;
}

type Signal = 'BUY' | 'SELL' | null;

// ── P&L formula — instrument-aware (Rule 8 from gotchas) ─────────────────────
// The existing backtestService.ts formula is FOREX-only.
// This function handles all instrument types correctly.

function calcRawPnl(
  side: 'BUY' | 'SELL',
  entryPrice: number,
  exitPrice: number,
  volume: number,
  instrumentType: string,
): number {
  const direction = side === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - entryPrice) * direction;
  switch (instrumentType) {
    case 'FOREX':   return priceDiff * volume * 100000; // standard lot
    case 'STOCKS':  return priceDiff * volume;
    case 'FUTURES': return priceDiff * volume;
    case 'CRYPTO':  return priceDiff * volume;
    case 'CFD':     return priceDiff * volume;
    default:        return priceDiff * volume * 100000;
  }
}

// ── SL/TP exit check (Rules 1 + 2) ───────────────────────────────────────────

interface ExitResult {
  exitPrice: number;
  ambiguous: boolean;
}

function checkExit(pos: OpenPosition, candle: Candle): ExitResult | null {
  const slHit = pos.side === 'BUY'
    ? candle.low  <= pos.stopLoss
    : candle.high >= pos.stopLoss;

  const tpHit = pos.side === 'BUY'
    ? candle.high >= pos.takeProfit
    : candle.low  <= pos.takeProfit;

  if (!slHit && !tpHit) return null;

  // Rule 2: SL always wins when both are crossed on the same candle.
  const ambiguous = slHit && tpHit;
  const exitAtSL  = slHit;
  return {
    exitPrice: exitAtSL ? pos.stopLoss : pos.takeProfit,
    ambiguous,
  };
}

// ── Strategy signal generation ────────────────────────────────────────────────
// Outputs one signal per candle index; entry will happen at candles[i+1].open.
// null = no signal.

function generateSignals(
  candles: Candle[],
  strategyType: StrategyType,
  strategyConfig: Record<string, number | string>,
): Signal[] {
  const closes  = candles.map((c) => c.close);
  const signals: Signal[] = new Array(candles.length).fill(null);

  switch (strategyType) {
    case 'MA_CROSS': {
      const fastPeriod = Number(strategyConfig.fastPeriod ?? 10);
      const slowPeriod = Number(strategyConfig.slowPeriod ?? 30);
      const maType     = String(strategyConfig.maType ?? 'EMA');

      const fastMA = maType === 'SMA' ? calcSMA(closes, fastPeriod) : calcEMA(closes, fastPeriod);
      const slowMA = maType === 'SMA' ? calcSMA(closes, slowPeriod) : calcEMA(closes, slowPeriod);

      for (let i = 1; i < candles.length; i++) {
        const pf = fastMA[i - 1], cf = fastMA[i];
        const ps = slowMA[i - 1], cs = slowMA[i];
        if (pf === null || cf === null || ps === null || cs === null) continue;

        if (pf <= ps && cf > cs) { signals[i] = 'BUY';  continue; }
        if (pf >= ps && cf < cs) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'RSI_REVERSAL': {
      const period     = Number(strategyConfig.period     ?? 14);
      const oversold   = Number(strategyConfig.oversold   ?? 30);
      const overbought = Number(strategyConfig.overbought ?? 70);

      const rsi = calcRSI(closes, period);

      for (let i = 1; i < candles.length; i++) {
        const prev = rsi[i - 1], curr = rsi[i];
        if (prev === null || curr === null) continue;

        // BUY: RSI rises above oversold (recovery confirmation)
        if (prev <= oversold && curr > oversold) { signals[i] = 'BUY';  continue; }
        // SELL: RSI rises above overbought (short entry at overbought)
        if (prev <= overbought && curr > overbought) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'MACD_SIGNAL': {
      const fastPeriod   = Number(strategyConfig.fastPeriod   ?? 12);
      const slowPeriod   = Number(strategyConfig.slowPeriod   ?? 26);
      const signalPeriod = Number(strategyConfig.signalPeriod ?? 9);

      const macd = calcMACD(closes, fastPeriod, slowPeriod, signalPeriod);

      for (let i = 1; i < candles.length; i++) {
        const prev = macd[i - 1], curr = macd[i];
        if (prev.macd === null || curr.macd === null ||
            prev.signal === null || curr.signal === null) continue;

        if (prev.macd <= prev.signal && curr.macd > curr.signal) { signals[i] = 'BUY';  continue; }
        if (prev.macd >= prev.signal && curr.macd < curr.signal) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'BB_BREAKOUT': {
      const period = Number(strategyConfig.period ?? 20);
      const stdDev = Number(strategyConfig.stdDev ?? 2);

      const bb = calcBB(closes, period, stdDev);

      for (let i = 0; i < candles.length; i++) {
        const { upper, lower } = bb[i];
        if (upper === null || lower === null) continue;

        if (closes[i] > upper) { signals[i] = 'BUY';  continue; }
        if (closes[i] < lower) { signals[i] = 'SELL'; continue; }
      }
      break;
    }
  }

  return signals;
}

// ── Minimum candles required for first valid signal ───────────────────────────

function minCandlesRequired(
  strategyType: StrategyType,
  strategyConfig: Record<string, number | string>,
): number {
  switch (strategyType) {
    case 'MA_CROSS':
      return Number(strategyConfig.slowPeriod ?? 30) + 1;
    case 'RSI_REVERSAL':
      return Number(strategyConfig.period ?? 14) + 2;
    case 'MACD_SIGNAL': {
      const slow   = Number(strategyConfig.slowPeriod   ?? 26);
      const signal = Number(strategyConfig.signalPeriod ?? 9);
      return slow + signal;
    }
    case 'BB_BREAKOUT':
      return Number(strategyConfig.period ?? 20) + 1;
  }
}

// ── Core event loop ───────────────────────────────────────────────────────────

async function runEventLoop(
  candles: Candle[],
  signals: Signal[],
  config: EngineConfig,
  sessionId: string,
  symbol: string,
): Promise<{ closedTrades: TradeResult[]; finalBalance: number }> {
  const openPositions: OpenPosition[] = [];
  const closedTrades: TradeResult[]   = [];
  let runningBalance = config.startingBalance;

  // Update DB every ~10% of candles processed.
  const progressInterval = Math.max(1, Math.floor(candles.length / 10));

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Progress update
    if (i % progressInterval === 0) {
      await prisma.backtestSession.update({
        where: { id: sessionId },
        data:  { runProgress: Math.floor((i / candles.length) * 100) },
      });
    }

    // ── Step 1: Check exits for all open positions ────────────────────────
    const stillOpen: OpenPosition[] = [];
    for (const pos of openPositions) {
      const exit = checkExit(pos, candle);
      if (exit) {
        const rawPnl   = calcRawPnl(pos.side, pos.entryPrice, exit.exitPrice, pos.volume, config.instrumentType);
        const finalPnl = rawPnl - config.commission;   // Rule 4
        runningBalance += finalPnl;
        closedTrades.push({
          symbol,
          side:       pos.side,
          entryPrice: pos.entryPrice,
          exitPrice:  exit.exitPrice,
          volume:     pos.volume,
          stopLoss:   pos.stopLoss,
          takeProfit: pos.takeProfit,
          pnl:        finalPnl,
          pnlPct:     (finalPnl / config.startingBalance) * 100,
          commission: config.commission,
          slippage:   pos.slippage,
          ambiguous:  exit.ambiguous,
          entryAt:    pos.entryAt,
          exitAt:     candle.openTime,
        });
      } else {
        stillOpen.push(pos);
      }
    }
    // Replace positions array in-place
    openPositions.length = 0;
    openPositions.push(...stillOpen);

    // ── Step 2: Check for entry signal ───────────────────────────────────
    // Only enter if room in position book AND a next candle exists for entry.
    if (openPositions.length < config.maxOpenPositions && i + 1 < candles.length) {
      const signal = signals[i];
      if (signal) {
        const nextCandle = candles[i + 1];

        // Rule 1: entry at next bar open.
        const rawEntry = nextCandle.open;

        // Rule 3: apply slippage to entry price; SL/TP computed from post-slippage price.
        const entryPrice =
          signal === 'BUY'
            ? rawEntry * (1 + config.slippagePct)
            : rawEntry * (1 - config.slippagePct);

        const slippage = rawEntry * config.slippagePct; // price-unit slippage

        const stopLoss =
          signal === 'BUY'
            ? entryPrice * (1 - config.stopLossPct)
            : entryPrice * (1 + config.stopLossPct);

        const takeProfit =
          signal === 'BUY'
            ? entryPrice * (1 + config.stopLossPct * config.takeProfitRatio)
            : entryPrice * (1 - config.stopLossPct * config.takeProfitRatio);

        openPositions.push({
          side:       signal,
          entryPrice,
          entryAt:    nextCandle.openTime,
          stopLoss,
          takeProfit,
          volume:     config.volume,
          slippage,
        });
      }
    }
  }

  // ── Force-close any positions left open on the last candle ───────────────
  const lastCandle = candles[candles.length - 1];
  for (const pos of openPositions) {
    const exitPrice = lastCandle.close;
    const rawPnl    = calcRawPnl(pos.side, pos.entryPrice, exitPrice, pos.volume, config.instrumentType);
    const finalPnl  = rawPnl - config.commission;
    runningBalance += finalPnl;
    closedTrades.push({
      symbol,
      side:       pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      volume:     pos.volume,
      stopLoss:   pos.stopLoss,
      takeProfit: pos.takeProfit,
      pnl:        finalPnl,
      pnlPct:     (finalPnl / config.startingBalance) * 100,
      commission: config.commission,
      slippage:   pos.slippage,
      ambiguous:  false,
      entryAt:    pos.entryAt,
      exitAt:     lastCandle.openTime,
    });
  }

  return { closedTrades, finalBalance: runningBalance };
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Called by backtestService.triggerRun() (Phase 3).
// For MVP this is synchronous — the HTTP request waits for completion.
// Controller should set a 120-second request timeout comment.

export async function runAutomatedBacktest(
  userId: string,
  sessionId: string,
  config: EngineConfig,
): Promise<void> {
  // 1. Validate session belongs to this user.
  const session = await prisma.backtestSession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) throw new AppError('Session not found', 404);

  const timeframe = session.timeframe;
  if (!timeframe) throw new AppError('Session has no timeframe configured', 400);

  // 2. Mark as RUNNING, reset balance for fresh run.
  await prisma.backtestSession.update({
    where: { id: sessionId },
    data: {
      runStatus:      'RUNNING',
      runStartedAt:   new Date(),
      runProgress:    0,
      runError:       null,
      currentBalance: session.startingBalance,
    },
  });

  try {
    // 3. Delete existing auto-generated trades (re-run safety).
    await prisma.backtestTrade.deleteMany({ where: { sessionId } });

    // 4. Fetch (or serve from cache) candle data.
    const candles = await getCandles(
      session.symbol,
      config.instrumentType,
      timeframe,
      session.startDate,
      session.endDate,
    ) as Candle[];

    // 5. Validate enough candles for a meaningful run.
    const lookback = minCandlesRequired(config.strategyType, config.strategyConfig);
    const needed   = lookback + 2; // +1 for signal candle, +1 for entry candle
    if (candles.length < needed) {
      throw new AppError(
        `Insufficient data: need at least ${needed} candles for ${config.strategyType} ` +
        `(got ${candles.length}). Try a longer date range or lower indicator periods.`,
        400,
      );
    }

    // 6. Compute strategy signals for every candle.
    const signals = generateSignals(candles, config.strategyType, config.strategyConfig);

    // 7. Run the candle-by-candle event loop (exits first, then entries per Rule 1).
    const { closedTrades, finalBalance } = await runEventLoop(
      candles,
      signals,
      config,
      sessionId,
      session.symbol,
    );

    // 8. Persist all trades in one batch.
    if (closedTrades.length > 0) {
      await prisma.backtestTrade.createMany({
        data: closedTrades.map((t) => ({
          sessionId,
          symbol:     t.symbol,
          side:       t.side,
          entryPrice: t.entryPrice,
          exitPrice:  t.exitPrice,
          volume:     t.volume,
          stopLoss:   t.stopLoss,
          takeProfit: t.takeProfit,
          pnl:        parseFloat(t.pnl.toFixed(2)),
          pnlPct:     parseFloat(t.pnlPct.toFixed(4)),
          commission: t.commission,
          slippage:   t.slippage,
          ambiguous:  t.ambiguous,
          status:     'CLOSED' as const,
          entryAt:    t.entryAt,
          exitAt:     t.exitAt,
        })),
      });
    }

    // 9. Mark session COMPLETED.
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: {
        runStatus:      'COMPLETED',
        runProgress:    100,
        runCompletedAt: new Date(),
        currentBalance: parseFloat(finalBalance.toFixed(2)),
      },
    });

    logger.info(
      `Backtest ${sessionId} completed: ${closedTrades.length} trades, ` +
      `final balance $${finalBalance.toFixed(2)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Backtest ${sessionId} failed: ${msg}`);

    // Best-effort status update — swallow secondary errors.
    await prisma.backtestSession
      .update({ where: { id: sessionId }, data: { runStatus: 'FAILED', runError: msg } })
      .catch(() => undefined);

    throw err;
  }
}
