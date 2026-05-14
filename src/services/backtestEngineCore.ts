// Pure computation core for the backtest engine.
//
// This module contains zero database access and zero I/O. It is imported
// by both the main-thread orchestrator (backtestEngine.ts) and the worker
// thread (backtestWorker.ts). Putting it here means both paths run the
// exact same code — the worker just adds a process boundary so the inner
// loop doesn't block the Express event loop on a busy server.

import { type StrategyType } from './strategyDefinitions';
import {
  calcSMA, calcEMA, calcRSI, calcMACD, calcBB,
  calcStochastic, calcADX, calcDonchian, calcCCI, calcWilliamsR,
} from './indicatorService';
import { generateCustomSignals, type CustomStrategyDSL } from './customStrategyInterpreter';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PureEngineConfig {
  strategyType:     StrategyType;
  strategyConfig:   Record<string, number | string>;
  customStrategy?:  CustomStrategyDSL;
  startingBalance:  number;
  volume:           number;
  stopLossPct:      number;
  takeProfitRatio:  number;
  slippagePct:      number;
  commission:       number;
  maxOpenPositions: number;
  instrumentType:   string;
}

export interface PureCandle {
  openTime: Date;
  open:     number;
  high:     number;
  low:      number;
  close:    number;
  volume:   number;
}

export interface OpenPosition {
  side:       'BUY' | 'SELL';
  entryPrice: number;
  entryAt:    Date;
  stopLoss:   number;
  takeProfit: number;
  volume:     number;
  slippage:   number;
}

export interface PureTradeResult {
  symbol:     string;
  side:       'BUY' | 'SELL';
  entryPrice: number;
  exitPrice:  number;
  volume:     number;
  stopLoss:   number;
  takeProfit: number;
  pnl:        number;
  pnlPct:     number;
  commission: number;
  slippage:   number;
  ambiguous:  boolean;
  entryAt:    Date;
  exitAt:     Date;
}

export type Signal = 'BUY' | 'SELL' | null;

// Optional: receives a 0-100 progress value periodically. The orchestrator
// uses this to write progress to the DB; tests pass a no-op.
export type ProgressCb = (progress: number) => void;

// ── P&L formula — instrument-aware ────────────────────────────────────────────

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
    case 'FOREX':   return priceDiff * volume * 100000;
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

function checkExit(pos: OpenPosition, high: number, low: number): ExitResult | null {
  const slHit = pos.side === 'BUY'
    ? low  <= pos.stopLoss
    : high >= pos.stopLoss;

  const tpHit = pos.side === 'BUY'
    ? high >= pos.takeProfit
    : low  <= pos.takeProfit;

  if (!slHit && !tpHit) return null;

  // Rule 2: SL always wins when both are crossed on the same candle.
  const ambiguous = slHit && tpHit;
  return {
    exitPrice: slHit ? pos.stopLoss : pos.takeProfit,
    ambiguous,
  };
}

// ── Strategy signal generation ────────────────────────────────────────────────

export function generateSignalsPure(
  candles: PureCandle[],
  strategyType: StrategyType,
  strategyConfig: Record<string, number | string>,
  customStrategy?: CustomStrategyDSL,
): Signal[] {
  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
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
        if (prev <= oversold   && curr > oversold)   { signals[i] = 'BUY';  continue; }
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

    case 'STOCHASTIC_CROSS': {
      const period       = Number(strategyConfig.period       ?? 14);
      const signalPeriod = Number(strategyConfig.signalPeriod ?? 3);
      const oversold     = Number(strategyConfig.oversold     ?? 20);
      const overbought   = Number(strategyConfig.overbought   ?? 80);
      const stoch = calcStochastic(highs, lows, closes, period, signalPeriod);
      for (let i = 1; i < candles.length; i++) {
        const prev = stoch[i - 1], curr = stoch[i];
        if (prev.k === null || curr.k === null || prev.d === null || curr.d === null) continue;
        if (prev.k <= prev.d && curr.k > curr.d && curr.k < oversold) { signals[i] = 'BUY';  continue; }
        if (prev.k >= prev.d && curr.k < curr.d && curr.k > overbought) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'ADX_TREND': {
      const period    = Number(strategyConfig.period    ?? 14);
      const threshold = Number(strategyConfig.threshold ?? 25);
      const adx = calcADX(highs, lows, closes, period);
      for (let i = 1; i < candles.length; i++) {
        const prev = adx[i - 1], curr = adx[i];
        if (curr.adx === null || curr.pdi === null || curr.mdi === null) continue;
        if (prev.pdi === null || prev.mdi === null) continue;
        if (curr.adx < threshold) continue;
        if (prev.pdi <= prev.mdi && curr.pdi > curr.mdi) { signals[i] = 'BUY';  continue; }
        if (prev.pdi >= prev.mdi && curr.pdi < curr.mdi) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'DONCHIAN_BREAKOUT': {
      const period = Number(strategyConfig.period ?? 20);
      const dc = calcDonchian(highs, lows, period);
      for (let i = 1; i < candles.length; i++) {
        const prev = dc[i - 1];
        if (prev.upper === null || prev.lower === null) continue;
        if (closes[i] > prev.upper) { signals[i] = 'BUY';  continue; }
        if (closes[i] < prev.lower) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'CCI_REVERSAL': {
      const period     = Number(strategyConfig.period     ?? 20);
      const oversold   = Number(strategyConfig.oversold   ?? -100);
      const overbought = Number(strategyConfig.overbought ?? 100);
      const cci = calcCCI(highs, lows, closes, period);
      for (let i = 1; i < candles.length; i++) {
        const prev = cci[i - 1], curr = cci[i];
        if (prev === null || curr === null) continue;
        if (prev <= oversold   && curr > oversold)   { signals[i] = 'BUY';  continue; }
        if (prev >= overbought && curr < overbought) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'WILLIAMS_R': {
      const period     = Number(strategyConfig.period     ?? 14);
      const oversold   = Number(strategyConfig.oversold   ?? -80);
      const overbought = Number(strategyConfig.overbought ?? -20);
      const wr = calcWilliamsR(highs, lows, closes, period);
      for (let i = 1; i < candles.length; i++) {
        const prev = wr[i - 1], curr = wr[i];
        if (prev === null || curr === null) continue;
        if (prev <= oversold   && curr > oversold)   { signals[i] = 'BUY';  continue; }
        if (prev >= overbought && curr < overbought) { signals[i] = 'SELL'; continue; }
      }
      break;
    }

    case 'RSI_MA_COMBO': {
      const rsiPeriod  = Number(strategyConfig.rsiPeriod  ?? 14);
      const oversold   = Number(strategyConfig.oversold   ?? 30);
      const overbought = Number(strategyConfig.overbought ?? 70);
      const maPeriod   = Number(strategyConfig.maPeriod   ?? 50);
      const maType     = String(strategyConfig.maType     ?? 'EMA');
      const rsi = calcRSI(closes, rsiPeriod);
      const ma  = maType === 'SMA' ? calcSMA(closes, maPeriod) : calcEMA(closes, maPeriod);
      for (let i = 1; i < candles.length; i++) {
        const prevRsi = rsi[i - 1], currRsi = rsi[i];
        const maVal   = ma[i];
        if (prevRsi === null || currRsi === null || maVal === null) continue;
        if (prevRsi <= oversold && currRsi > oversold && closes[i] > maVal) {
          signals[i] = 'BUY'; continue;
        }
        if (prevRsi <= overbought && currRsi > overbought && closes[i] < maVal) {
          signals[i] = 'SELL'; continue;
        }
      }
      break;
    }

    case 'CUSTOM': {
      // Loud failure beats a silent zero-trade run. A CUSTOM run without a
      // DSL is a misconfiguration upstream (controller forgot to forward
      // the customStrategy field, or persisted session row was corrupted).
      if (!customStrategy) {
        throw new Error('CUSTOM strategy selected but no customStrategy DSL provided');
      }
      const customSignals = generateCustomSignals(candles, customStrategy);
      for (let i = 0; i < candles.length; i++) signals[i] = customSignals[i];
      break;
    }
  }

  return signals;
}

// ── Minimum candles required for first valid signal ───────────────────────────

export function minCandlesRequired(
  strategyType: StrategyType,
  strategyConfig: Record<string, number | string>,
  customStrategy?: CustomStrategyDSL,
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
    case 'STOCHASTIC_CROSS':
      return Number(strategyConfig.period ?? 14) + Number(strategyConfig.signalPeriod ?? 3) + 1;
    case 'ADX_TREND':
      return Number(strategyConfig.period ?? 14) * 2 + 1;
    case 'DONCHIAN_BREAKOUT':
      return Number(strategyConfig.period ?? 20) + 1;
    case 'CCI_REVERSAL':
      return Number(strategyConfig.period ?? 20) + 1;
    case 'WILLIAMS_R':
      return Number(strategyConfig.period ?? 14) + 1;
    case 'RSI_MA_COMBO':
      return Math.max(
        Number(strategyConfig.rsiPeriod ?? 14),
        Number(strategyConfig.maPeriod  ?? 50),
      ) + 2;
    case 'CUSTOM':
      // Walk the DSL and pick the largest warmup window. A user wiring up
      // SMA(200) shouldn't see "got 32 candles" pass validation only to
      // produce zero signals because the indicator is null for 200 bars.
      return customStrategyWarmup(customStrategy);
  }
}

function customStrategyWarmup(dsl?: CustomStrategyDSL): number {
  if (!dsl) return 30;
  let maxPeriod = 0;
  for (const ind of dsl.indicators) {
    const p = (ind.params ?? {}) as Record<string, unknown>;
    const candidates = [p.period, p.fastPeriod, p.slowPeriod, p.signalPeriod];
    for (const v of candidates) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > maxPeriod) maxPeriod = n;
    }
    if (ind.type === 'MACD_LINE' || ind.type === 'MACD_SIGNAL' || ind.type === 'MACD_HIST') {
      const slow   = Number(p.slowPeriod   ?? 26);
      const signal = Number(p.signalPeriod ?? 9);
      if (slow + signal > maxPeriod) maxPeriod = slow + signal;
    }
    if (ind.type === 'ADX' || ind.type === 'DI_PLUS' || ind.type === 'DI_MINUS') {
      const period = Number(p.period ?? 14);
      if (period * 2 > maxPeriod) maxPeriod = period * 2;
    }
  }
  return Math.max(maxPeriod + 1, 30);
}

// ── Pure event loop ───────────────────────────────────────────────────────────
// Same Float64Array hoisting + in-place compaction as the original. Progress
// reports go through `onProgress` so the main thread can decide what to do
// with them (write to DB, post-message back, log, ignore).

export function runEventLoopPure(
  candles: PureCandle[],
  signals: Signal[],
  config: PureEngineConfig,
  symbol: string,
  onProgress?: ProgressCb,
): { closedTrades: PureTradeResult[]; finalBalance: number } {
  const n = candles.length;

  const opens     = new Float64Array(n);
  const highs     = new Float64Array(n);
  const lows      = new Float64Array(n);
  const closes    = new Float64Array(n);
  const openTimes = new Array<Date>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    opens[i]     = c.open;
    highs[i]     = c.high;
    lows[i]      = c.low;
    closes[i]    = c.close;
    openTimes[i] = c.openTime;
  }

  const openPositions: OpenPosition[] = [];
  const closedTrades:  PureTradeResult[] = [];
  let runningBalance = config.startingBalance;

  // Hoist config out of the hot loop.
  const slippagePct      = config.slippagePct;
  const stopLossPct      = config.stopLossPct;
  const takeProfitRatio  = config.takeProfitRatio;
  const commission       = config.commission;
  const volume           = config.volume;
  const startingBalance  = config.startingBalance;
  const maxOpenPositions = config.maxOpenPositions;
  const instrumentType   = config.instrumentType;

  let lastProgressTs = Date.now();
  const PROGRESS_THROTTLE_MS = 500;

  for (let i = 0; i < n; i++) {
    if (onProgress) {
      const now = Date.now();
      if (now - lastProgressTs >= PROGRESS_THROTTLE_MS) {
        lastProgressTs = now;
        // Progress spans 15-100 (first 15% reserved for the data-fetch phase).
        onProgress(Math.floor(15 + (i / n) * 85));
      }
    }

    const candleHigh = highs[i];
    const candleLow  = lows[i];

    // Step 1: in-place exit check (write index <= read index).
    let writeIdx = 0;
    for (let r = 0; r < openPositions.length; r++) {
      const pos = openPositions[r];
      const exit = checkExit(pos, candleHigh, candleLow);
      if (exit) {
        const rawPnl   = calcRawPnl(pos.side, pos.entryPrice, exit.exitPrice, pos.volume, instrumentType);
        const finalPnl = rawPnl - commission;
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
          pnlPct:     (finalPnl / startingBalance) * 100,
          commission,
          slippage:   pos.slippage,
          ambiguous:  exit.ambiguous,
          entryAt:    pos.entryAt,
          exitAt:     openTimes[i],
        });
      } else {
        openPositions[writeIdx++] = pos;
      }
    }
    openPositions.length = writeIdx;

    // Step 2: entry signal.
    if (openPositions.length < maxOpenPositions && i + 1 < n) {
      const signal = signals[i];
      if (signal) {
        const rawEntry = opens[i + 1];
        const entryPrice = signal === 'BUY'
          ? rawEntry * (1 + slippagePct)
          : rawEntry * (1 - slippagePct);
        const slippage = rawEntry * slippagePct;
        const stopLoss = signal === 'BUY'
          ? entryPrice * (1 - stopLossPct)
          : entryPrice * (1 + stopLossPct);
        const takeProfit = signal === 'BUY'
          ? entryPrice * (1 + stopLossPct * takeProfitRatio)
          : entryPrice * (1 - stopLossPct * takeProfitRatio);

        openPositions.push({
          side:       signal,
          entryPrice,
          entryAt:    openTimes[i + 1],
          stopLoss,
          takeProfit,
          volume,
          slippage,
        });
      }
    }
  }

  // Force-close anything still open at the last candle.
  const lastIdx      = n - 1;
  const lastClose    = closes[lastIdx];
  const lastOpenTime = openTimes[lastIdx];
  for (const pos of openPositions) {
    const rawPnl   = calcRawPnl(pos.side, pos.entryPrice, lastClose, pos.volume, instrumentType);
    const finalPnl = rawPnl - commission;
    runningBalance += finalPnl;
    closedTrades.push({
      symbol,
      side:       pos.side,
      entryPrice: pos.entryPrice,
      exitPrice:  lastClose,
      volume:     pos.volume,
      stopLoss:   pos.stopLoss,
      takeProfit: pos.takeProfit,
      pnl:        finalPnl,
      pnlPct:     (finalPnl / startingBalance) * 100,
      commission,
      slippage:   pos.slippage,
      ambiguous:  false,
      entryAt:    pos.entryAt,
      exitAt:     lastOpenTime,
    });
  }

  return { closedTrades, finalBalance: runningBalance };
}
