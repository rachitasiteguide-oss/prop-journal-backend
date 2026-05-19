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
  calcATR,
} from './indicatorService';
import { generateCustomSignals, type CustomStrategyDSL } from './customStrategyInterpreter';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PureEngineConfig {
  strategyType:     StrategyType;
  strategyConfig:   Record<string, number | string>;
  customStrategy?:  CustomStrategyDSL;
  startingBalance:  number;
  // Default volume — used by FIXED sizing mode and as a fallback when a
  // RISK_BASED or PCT_EQUITY calculation yields an invalid number.
  volume:           number;
  stopLossPct:      number;
  takeProfitRatio:  number;
  slippagePct:      number;
  commission:       number;
  maxOpenPositions: number;
  instrumentType:   string;
  // Optional prop-firm-challenge rule set. When provided AND enabled, the
  // engine tracks daily equity, HWM, and trading-day count; on breach it
  // force-closes all positions and records the breach in ChallengeResult.
  propFirmRules?:   PropFirmRulesConfig;
  // Optional position-sizing override. When omitted, FIXED mode is used.
  sizing?:          SizingConfig;
}

// ── Position sizing ──────────────────────────────────────────────────────────
// Replaces fixed-volume entries with a per-trade calculation. The textbook
// retail risk-management primitive (1% of equity per trade) cannot be
// expressed under FIXED — you have to compute the right lot size by hand for
// every instrument and price. RISK_BASED handles it automatically.

export type SizingMode = 'FIXED' | 'PCT_EQUITY' | 'RISK_BASED';
export type StopSource = 'PCT' | 'ATR';

export interface SizingConfig {
  mode: SizingMode;
  // FIXED — uses config.volume directly; no extra fields read.
  //
  // PCT_EQUITY — open a notional position worth pctEquity × current equity.
  // Example: 0.10 on a $10k account at price $100 → $1000 notional → 10 shares
  // (or 0.01 lots forex at 100,000 multiplier).
  pctEquity?: number;
  // RISK_BASED — size so that hitting the stop loses riskPerTrade × equity.
  // Example: 0.01 (1% risk) on a $10k account with a $0.50 stop and $1/unit
  // P&L multiplier → volume = $100 / $0.50 = 200 units.
  riskPerTrade?: number;
  // RISK_BASED only — how to compute the stop distance for sizing purposes.
  // 'PCT' (default): stopDistance = entryPrice × config.stopLossPct.
  // 'ATR': stopDistance = atrMultiplier × ATR(atrPeriod)[entryBar].
  stopSource?: StopSource;
  atrPeriod?: number;
  atrMultiplier?: number;
}

// ── Prop-firm challenge rules ────────────────────────────────────────────────
// Mirrors the rule taxonomy used by FTMO, MyForexFunds, TheFundedTrader,
// FundedNext etc. All rule fields are optional — supply only the ones your
// challenge enforces. Pass values as fractions, not percentages
// (0.05 = 5%, not 5).

export interface PropFirmRulesConfig {
  enabled: boolean;
  // Daily loss limit as a fraction of START-OF-DAY balance. Breach = FAILED.
  dailyLossLimitPct?: number;
  // Static max loss as a fraction of STARTING balance. Breach = FAILED.
  // (FTMO's "Maximum Loss" rule on Phase 1.)
  maxLossPct?: number;
  // Trailing max DD as a fraction of HWM equity. Breach = FAILED.
  // (FTMO Swing accounts; many MFF programs.)
  trailingMaxDDPct?: number;
  // When true, HWM updates only at end-of-day, not intraday. FTMO Swing
  // accounts use this — it makes the rule materially looser than intraday-HWM.
  trailingDDEodOnly?: boolean;
  // Profit target as a fraction of STARTING balance. Required to PASS.
  profitTargetPct?: number;
  // Minimum distinct trading days required to PASS even if profit target hit.
  minTradingDays?: number;
  // Maximum trading days (challenge expires). 0 / undef = unlimited.
  maxTradingDays?: number;
}

export type ChallengeStatus =
  | 'IN_PROGRESS'   // run ended before pass or fail conditions met
  | 'PASSED'        // profit target hit AND min trading days satisfied AND no breach
  | 'FAILED'        // a hard rule was breached
  | 'EXPIRED';      // maxTradingDays exceeded without pass

export type BreachedRule =
  | 'DAILY_LOSS'
  | 'MAX_LOSS'
  | 'TRAILING_DD'
  | 'TIME_EXPIRED';

export interface ChallengeResult {
  enabled: boolean;
  status: ChallengeStatus;
  // Set when status === 'FAILED' or 'EXPIRED'.
  breachedRule?:        BreachedRule;
  breachDate?:          Date;
  breachEquity?:        number;
  breachAtTradeCount?:  number;
  // Set when profit target was hit (status may still be IN_PROGRESS if
  // minTradingDays not yet satisfied, or PASSED if both met).
  profitTargetHitDate?: Date;
  profitTargetHitEquity?: number;
  // Always populated.
  tradingDaysCount:       number;
  highWaterMark:          number;
  lowestEquity:           number;
  maxDailyLossPct:        number; // worst single-day drop observed (fraction)
  maxDrawdownFromHWMPct:  number; // worst peak-to-trough observed (fraction)
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
  entrySlippage: number;          // price units paid to slippage on entry leg
  // Equity at the moment this position was opened. Used to denominate pnlPct
  // against the trade-time balance rather than the original starting balance,
  // so late-in-run compounded trades aren't squashed in the reported %.
  equityAtEntry: number;
  // Running peak/trough of price seen while open — used to compute maximum
  // adverse / favourable excursion for intra-trade-aware drawdown.
  peakHigh:   number;
  peakLow:    number;
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
  commission: number;     // total commission (entry leg + exit leg)
  slippage:   number;     // total slippage in price units (entry + exit legs)
  ambiguous:  boolean;
  forceClosed: boolean;   // true when closed at end-of-data, not by SL/TP
  // Peak unrealised loss/gain in P&L currency units while position was open.
  // Lets the metrics endpoint compute HWM-to-trough drawdown instead of only
  // trade-to-trade closing equity.
  maxAdverse:   number;   // >= 0
  maxFavorable: number;   // >= 0
  entryAt:    Date;
  exitAt:     Date;
}

export type Signal = 'BUY' | 'SELL' | null;

// Optional: receives a 0-100 progress value periodically. The orchestrator
// uses this to write progress to the DB; tests pass a no-op.
export type ProgressCb = (progress: number) => void;

// ── P&L formula — instrument-aware ────────────────────────────────────────────

export function calcRawPnl(
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
    default:
      // Refuse to silently apply the forex 100,000x multiplier to unknown
      // instrument strings (e.g. "STOCK" singular). Would otherwise inflate
      // reported P&L by 5 orders of magnitude.
      throw new Error(
        `Unsupported instrumentType "${instrumentType}". ` +
        `Expected one of FOREX, STOCKS, FUTURES, CRYPTO, CFD.`,
      );
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

// Diagnostics emitted alongside every run. Surfaced through the metrics
// endpoint so the frontend can explain *why* a run produced zero trades
// (no signals fired, signals fired but couldn't enter, etc.).
export interface RunDiagnostics {
  candleCount:    number;
  signalCount:    number;
  buySignals:     number;
  sellSignals:    number;
  entryAttempts:  number;
  entriesTaken:   number;
  entriesSkipped: number;   // signal fired but maxOpenPositions or final-bar prevented entry
  forceClosed:    number;   // open positions closed at end of data
  emptyReason?:   string;   // human-readable explanation when closedTrades.length === 0
  // CUSTOM-strategy only: per-condition fire counts. Lets the trader see
  // *which* condition is the bottleneck when an ANDed group emits no signals.
  // Index aligns with dsl.buy.conditions[] and dsl.sell.conditions[] order.
  customConditionFires?: { buy: number[]; sell: number[] };
  // True when signal generation was served from the in-process LRU cache.
  // Lets the UI show "cached" vs "freshly computed" so a trader debugging
  // strategy stability can tell whether identical results are determinism
  // or just a cache hit.
  signalsFromCache?: boolean;
  // Number of candle bars on which BOTH SL and TP were hit. SL takes priority
  // but these are tie-breaks — large counts mean the strategy's reported
  // exits are partly arbitrary.
  ambiguousExits?: number;
  // Set when the cached/fetched candle coverage materially undershoots the
  // requested date range (e.g. Yahoo's 60-day intraday cap silently truncated
  // a 2-year request).
  coverageWarning?: string;
  // Prop-firm challenge result, present only when config.propFirmRules.enabled.
  challengeResult?: ChallengeResult;
}

export function runEventLoopPure(
  candles: PureCandle[],
  signals: Signal[],
  config: PureEngineConfig,
  symbol: string,
  onProgress?: ProgressCb,
): { closedTrades: PureTradeResult[]; finalBalance: number; diagnostics: RunDiagnostics } {
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

  // Diagnostic counters — incremented inline in the hot loop. Counting
  // signals upfront is O(n) and cheap; doing it inside the loop avoids a
  // second pass.
  let buySignals     = 0;
  let sellSignals    = 0;
  let entryAttempts  = 0;
  let entriesTaken   = 0;
  let entriesSkipped = 0;
  let ambiguousExits = 0;

  // Hoist config out of the hot loop.
  const slippagePct      = config.slippagePct;
  const stopLossPct      = config.stopLossPct;
  const takeProfitRatio  = config.takeProfitRatio;
  // Commission is treated as **per-leg** (charged on entry AND exit) — round-
  // trip cost = 2 × config.commission. The audit flagged the old single-leg
  // semantics as half-correct; this matches how brokers actually bill.
  const commissionPerLeg = config.commission;
  const defaultVolume    = config.volume;
  const maxOpenPositions = config.maxOpenPositions;
  const instrumentType   = config.instrumentType;
  const sizing           = config.sizing ?? { mode: 'FIXED' as SizingMode };

  // Pre-compute ATR if RISK_BASED + ATR stop source. Doing it once outside
  // the loop avoids O(n²) work and matches how indicators are computed for
  // signal generation.
  let atrSeries: (number | null)[] | null = null;
  if (sizing.mode === 'RISK_BASED' && sizing.stopSource === 'ATR') {
    const period = sizing.atrPeriod ?? 14;
    atrSeries = calcATR(
      Array.from(highs),
      Array.from(lows),
      Array.from(closes),
      period,
    );
  }

  // Per-1-unit-of-volume P&L at a 1-unit price move. Lets us convert dollar
  // risk to volume regardless of instrument multiplier (FOREX = 100,000,
  // STOCKS = 1), AND convert a position's price-distance excursion into
  // currency at THAT position's actual volume — critical now that
  // RISK_BASED / PCT_EQUITY sizing means volume varies per trade. MAE/MFE
  // is therefore `priceDistance * pnlPerUnitVolume * pos.volume`, never a
  // hoisted default-volume constant.
  const pnlPerUnitVolume = calcRawPnl('BUY', 0, 1, 1, instrumentType);

  // Compute the entry volume for a new position. Falls back to defaultVolume
  // (config.volume) on any non-finite result so a misconfigured sizing
  // block can never silently kill all signals.
  function computeEntryVolume(
    _side: 'BUY' | 'SELL',     // accepted for symmetry; sizing is direction-agnostic today
    entryPrice: number,
    equity: number,
    barIndex: number,
  ): number {
    if (sizing.mode === 'FIXED') return defaultVolume;
    if (equity <= 0) return 0;

    if (sizing.mode === 'PCT_EQUITY') {
      const pct = sizing.pctEquity ?? 0;
      if (pct <= 0) return defaultVolume;
      // Notional dollars to deploy → divide by price × multiplier to get volume.
      const notional = equity * pct;
      const v = notional / (entryPrice * pnlPerUnitVolume);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }

    if (sizing.mode === 'RISK_BASED') {
      const risk = sizing.riskPerTrade ?? 0;
      if (risk <= 0) return defaultVolume;

      let stopDistance: number;
      if (sizing.stopSource === 'ATR' && atrSeries) {
        const atr = atrSeries[barIndex];
        if (atr == null || atr <= 0) return 0;
        stopDistance = (sizing.atrMultiplier ?? 2) * atr;
      } else {
        // Default: use config.stopLossPct relative to entry price. Matches
        // the SL the engine will actually set.
        stopDistance = entryPrice * stopLossPct;
      }
      if (stopDistance <= 0) return 0;

      const dollarRisk = equity * risk;
      const v = dollarRisk / (stopDistance * pnlPerUnitVolume);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }

    return defaultVolume;
  }

  // ── Prop-firm challenge state ───────────────────────────────────────────
  // All fields populated only when rules.enabled. Tracking is cheap (a few
  // numeric comparisons per bar) so the cost when disabled is negligible.
  const rules = config.propFirmRules;
  const rulesActive = !!(rules && rules.enabled);
  let challengeStatus: ChallengeStatus = 'IN_PROGRESS';
  let breachedRule: BreachedRule | undefined;
  let breachDate: Date | undefined;
  let breachEquity: number | undefined;
  let breachAtTradeCount: number | undefined;
  let profitTargetHitDate: Date | undefined;
  let profitTargetHitEquity: number | undefined;
  let highWaterMark = config.startingBalance;
  let lowestEquity  = config.startingBalance;
  let maxDailyLossPct       = 0;
  let maxDrawdownFromHWMPct = 0;
  // Distinct trading days = days on which at least one entry or exit occurred.
  // Tracked via a Set of "YYYY-MM-DD" keys; cheap relative to the candle loop.
  const tradingDays = new Set<string>();
  // Day key of the previous candle, for detecting day boundaries.
  let prevDayKey: string | null = null;
  let startOfDayEquity = config.startingBalance;
  // Day count for maxTradingDays — distinct days the loop has SEEN, not just
  // days with trades. Counted per challenge convention.
  let calendarDaysSeen = 0;
  // Cached so the breach-handler block doesn't have to rebuild it for the
  // last-iteration position-close path.
  const dayKey = (d: Date): string =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  // Compute current mark-to-market equity. Realised P&L is in runningBalance;
  // open positions are marked to the candle's close, with per-leg commission
  // already accounted for (entry leg charged at open, exit leg charged on close).
  // Slippage is not modelled on the MTM mark — it's a fill cost, not a holding cost.
  const currentEquity = (closePrice: number): number => {
    let eq = runningBalance;
    for (const pos of openPositions) {
      eq += calcRawPnl(pos.side, pos.entryPrice, closePrice, pos.volume, instrumentType);
      // Subtract the exit-leg commission that WOULD be charged if we closed now.
      // The entry leg was already deducted from runningBalance at entry? No —
      // currently commission is only deducted at trade close. So mark-to-market
      // equity here ignores commission entirely, which is consistent with how a
      // broker shows floating P&L.
    }
    return eq;
  };

  // Force-close every open position at a given price + timestamp. Used on
  // challenge breach. Returns the number of positions closed.
  const forceCloseAll = (closePrice: number, atTime: Date): number => {
    const count = openPositions.length;
    for (const pos of openPositions) {
      const rawPnl   = calcRawPnl(pos.side, pos.entryPrice, closePrice, pos.volume, instrumentType);
      const totalCommission = commissionPerLeg * 2;
      const finalPnl = rawPnl - totalCommission;
      runningBalance += finalPnl;
      const maxAdversePrice = pos.side === 'BUY'
        ? Math.max(0, pos.entryPrice - pos.peakLow)
        : Math.max(0, pos.peakHigh - pos.entryPrice);
      const maxFavorablePrice = pos.side === 'BUY'
        ? Math.max(0, pos.peakHigh - pos.entryPrice)
        : Math.max(0, pos.entryPrice - pos.peakLow);
      closedTrades.push({
        symbol,
        side:        pos.side,
        entryPrice:  pos.entryPrice,
        exitPrice:   closePrice,
        volume:      pos.volume,
        stopLoss:    pos.stopLoss,
        takeProfit:  pos.takeProfit,
        pnl:         finalPnl,
        pnlPct:      (finalPnl / pos.equityAtEntry) * 100,
        commission:  totalCommission,
        slippage:    pos.entrySlippage,
        ambiguous:   false,
        forceClosed: true,
        maxAdverse:    maxAdversePrice   * pnlPerUnitVolume * pos.volume,
        maxFavorable:  maxFavorablePrice * pnlPerUnitVolume * pos.volume,
        entryAt:     pos.entryAt,
        exitAt:      atTime,
      });
    }
    openPositions.length = 0;
    return count;
  };

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

    // ── Step 0: prop-firm day-boundary detection ─────────────────────────
    // Done BEFORE exit processing so a day-flip closes out the prior day's
    // EOD-trailing HWM update, and so SOD equity is snapshotted before any
    // new realized P&L for this day lands.
    if (rulesActive) {
      const k = dayKey(openTimes[i]);
      if (k !== prevDayKey) {
        // Day flip. The previous day's "end" is i-1's close. If we're using
        // EOD-only trailing DD, this is when we update HWM for the prior day.
        if (rules!.trailingDDEodOnly && i > 0) {
          const prevDayClose = closes[i - 1];
          const eqAtEod = currentEquity(prevDayClose);
          if (eqAtEod > highWaterMark) highWaterMark = eqAtEod;
        }
        // SOD equity for the new day = prior bar's close-equity, or start
        // balance at i=0.
        startOfDayEquity = i === 0 ? config.startingBalance : currentEquity(closes[i - 1]);
        prevDayKey = k;
        calendarDaysSeen++;

        // Time-expiry check (EXPIRED status).
        if (
          rules!.maxTradingDays != null &&
          rules!.maxTradingDays > 0 &&
          calendarDaysSeen > rules!.maxTradingDays
        ) {
          challengeStatus    = 'EXPIRED';
          breachedRule       = 'TIME_EXPIRED';
          breachDate         = openTimes[i];
          breachEquity       = currentEquity(closes[i]);
          breachAtTradeCount = closedTrades.length;
          forceCloseAll(closes[i], openTimes[i]);
          break;
        }
      }
    }

    // Step 1: in-place exit check (write index <= read index).
    let writeIdx = 0;
    for (let r = 0; r < openPositions.length; r++) {
      const pos = openPositions[r];

      // Track intra-trade excursion against this bar's range before checking
      // exit, so the recorded MAE/MFE captures the worst/best price seen even
      // on the exit bar itself.
      if (candleHigh > pos.peakHigh) pos.peakHigh = candleHigh;
      if (candleLow  < pos.peakLow ) pos.peakLow  = candleLow;

      const exit = checkExit(pos, candleHigh, candleLow);
      if (exit) {
        if (exit.ambiguous) ambiguousExits++;
        // Exit slippage: SL fills can gap through; TP fills can also slip.
        // Apply the same slippagePct adversely against the position direction,
        // so the engine no longer assumes best-case fills at the exact SL/TP.
        const rawExit  = exit.exitPrice;
        const exitFill = pos.side === 'BUY'
          ? rawExit * (1 - slippagePct)
          : rawExit * (1 + slippagePct);
        const exitSlippagePrice = Math.abs(rawExit - exitFill);

        const rawPnl   = calcRawPnl(pos.side, pos.entryPrice, exitFill, pos.volume, instrumentType);
        const totalCommission = commissionPerLeg * 2;
        const finalPnl = rawPnl - totalCommission;
        runningBalance += finalPnl;

        const maxAdversePrice = pos.side === 'BUY'
          ? Math.max(0, pos.entryPrice - pos.peakLow)
          : Math.max(0, pos.peakHigh - pos.entryPrice);
        const maxFavorablePrice = pos.side === 'BUY'
          ? Math.max(0, pos.peakHigh - pos.entryPrice)
          : Math.max(0, pos.entryPrice - pos.peakLow);

        closedTrades.push({
          symbol,
          side:       pos.side,
          entryPrice: pos.entryPrice,
          exitPrice:  exitFill,
          volume:     pos.volume,
          stopLoss:   pos.stopLoss,
          takeProfit: pos.takeProfit,
          pnl:        finalPnl,
          // Denominate against equity at trade entry, not the original starting
          // balance. Keeps reported percentages comparable across a compounded
          // run instead of squashing later trades.
          pnlPct:     (finalPnl / pos.equityAtEntry) * 100,
          commission: totalCommission,
          slippage:   pos.entrySlippage + exitSlippagePrice,
          ambiguous:  exit.ambiguous,
          forceClosed: false,
          maxAdverse:   maxAdversePrice   * pnlPerUnitVolume * pos.volume,
          maxFavorable: maxFavorablePrice * pnlPerUnitVolume * pos.volume,
          entryAt:    pos.entryAt,
          exitAt:     openTimes[i],
        });
      } else {
        openPositions[writeIdx++] = pos;
      }
    }
    openPositions.length = writeIdx;

    // ── Step 1.5: prop-firm rule checks ──────────────────────────────────
    // Done AFTER exits realize and BEFORE new entries open. Equity is marked
    // to this bar's close including any still-open positions.
    if (rulesActive) {
      const eqNow = currentEquity(closes[i]);
      if (eqNow < lowestEquity) lowestEquity = eqNow;

      // Intraday HWM update (unless EOD-only mode is on).
      if (!rules!.trailingDDEodOnly && eqNow > highWaterMark) {
        highWaterMark = eqNow;
      }

      // Track worst observed daily loss and DD-from-HWM for reporting.
      if (startOfDayEquity > 0) {
        const dailyLoss = (startOfDayEquity - eqNow) / startOfDayEquity;
        if (dailyLoss > maxDailyLossPct) maxDailyLossPct = dailyLoss;
      }
      if (highWaterMark > 0) {
        const ddFromHWM = (highWaterMark - eqNow) / highWaterMark;
        if (ddFromHWM > maxDrawdownFromHWMPct) maxDrawdownFromHWMPct = ddFromHWM;
      }

      // Hard rules — first breach wins.
      let breach: BreachedRule | null = null;
      if (
        rules!.dailyLossLimitPct != null &&
        rules!.dailyLossLimitPct > 0 &&
        startOfDayEquity > 0 &&
        (startOfDayEquity - eqNow) / startOfDayEquity >= rules!.dailyLossLimitPct
      ) {
        breach = 'DAILY_LOSS';
      } else if (
        rules!.maxLossPct != null &&
        rules!.maxLossPct > 0 &&
        (config.startingBalance - eqNow) / config.startingBalance >= rules!.maxLossPct
      ) {
        breach = 'MAX_LOSS';
      } else if (
        rules!.trailingMaxDDPct != null &&
        rules!.trailingMaxDDPct > 0 &&
        highWaterMark > 0 &&
        (highWaterMark - eqNow) / highWaterMark >= rules!.trailingMaxDDPct
      ) {
        breach = 'TRAILING_DD';
      }

      if (breach) {
        challengeStatus    = 'FAILED';
        breachedRule       = breach;
        breachDate         = openTimes[i];
        breachEquity       = eqNow;
        breachAtTradeCount = closedTrades.length;
        forceCloseAll(closes[i], openTimes[i]);
        break;
      }

      // Profit-target detection (does NOT terminate — strategy can keep
      // trading, but we record when the target was first hit).
      if (
        !profitTargetHitDate &&
        rules!.profitTargetPct != null &&
        rules!.profitTargetPct > 0 &&
        eqNow >= config.startingBalance * (1 + rules!.profitTargetPct)
      ) {
        profitTargetHitDate   = openTimes[i];
        profitTargetHitEquity = eqNow;
      }
    }

    // Step 2: entry signal.
    const signal = signals[i];
    if (signal) {
      if (signal === 'BUY') buySignals++; else sellSignals++;
      const canEnter = openPositions.length < maxOpenPositions && i + 1 < n;
      if (canEnter) {
        entryAttempts++;
        const rawEntry = opens[i + 1];
        const entryPrice = signal === 'BUY'
          ? rawEntry * (1 + slippagePct)
          : rawEntry * (1 - slippagePct);
        const entrySlippage = Math.abs(rawEntry - entryPrice);
        const stopLoss = signal === 'BUY'
          ? entryPrice * (1 - stopLossPct)
          : entryPrice * (1 + stopLossPct);
        const takeProfit = signal === 'BUY'
          ? entryPrice * (1 + stopLossPct * takeProfitRatio)
          : entryPrice * (1 - stopLossPct * takeProfitRatio);

        // Compute volume per the sizing config. Uses realised-only equity
        // (runningBalance) as the base — a conservative choice that ignores
        // floating P&L on other open positions. For maxOpenPositions=1 (the
        // default) this is exactly correct.
        const v = computeEntryVolume(signal, entryPrice, runningBalance, i);
        if (v <= 0) {
          // Sizing yielded zero — most often ATR warmup not yet ready.
          // Count as skipped so the diagnostic explains why no entry landed.
          entriesSkipped++;
        } else {
          openPositions.push({
            side:       signal,
            entryPrice,
            entryAt:    openTimes[i + 1],
            stopLoss,
            takeProfit,
            volume:     v,
            entrySlippage,
            equityAtEntry: runningBalance,
            peakHigh:   entryPrice,
            peakLow:    entryPrice,
          });
          entriesTaken++;
          // Track distinct entry days for the minTradingDays rule.
          if (rulesActive) tradingDays.add(dayKey(openTimes[i + 1]));
        }
      } else {
        entriesSkipped++;
      }
    }
  }

  // Force-close anything still open at the last candle.
  const lastIdx      = n - 1;
  const lastClose    = closes[lastIdx];
  const lastOpenTime = openTimes[lastIdx];
  const forceClosed  = openPositions.length;
  for (const pos of openPositions) {
    // No exit-leg slippage on force-close — we are evaluating mark-to-market
    // at the last candle, not a real fill against price action.
    const rawPnl   = calcRawPnl(pos.side, pos.entryPrice, lastClose, pos.volume, instrumentType);
    const totalCommission = commissionPerLeg * 2;
    const finalPnl = rawPnl - totalCommission;
    runningBalance += finalPnl;

    const maxAdversePrice = pos.side === 'BUY'
      ? Math.max(0, pos.entryPrice - pos.peakLow)
      : Math.max(0, pos.peakHigh - pos.entryPrice);
    const maxFavorablePrice = pos.side === 'BUY'
      ? Math.max(0, pos.peakHigh - pos.entryPrice)
      : Math.max(0, pos.entryPrice - pos.peakLow);

    closedTrades.push({
      symbol,
      side:       pos.side,
      entryPrice: pos.entryPrice,
      exitPrice:  lastClose,
      volume:     pos.volume,
      stopLoss:   pos.stopLoss,
      takeProfit: pos.takeProfit,
      pnl:        finalPnl,
      pnlPct:     (finalPnl / pos.equityAtEntry) * 100,
      commission: totalCommission,
      slippage:   pos.entrySlippage,
      ambiguous:  false,
      forceClosed: true,
      maxAdverse:   maxAdversePrice   * pnlPerUnitVolume * pos.volume,
      maxFavorable: maxFavorablePrice * pnlPerUnitVolume * pos.volume,
      entryAt:    pos.entryAt,
      exitAt:     lastOpenTime,
    });
  }

  const diagnostics: RunDiagnostics = {
    candleCount:    n,
    signalCount:    buySignals + sellSignals,
    buySignals,
    sellSignals,
    entryAttempts,
    entriesTaken,
    entriesSkipped,
    forceClosed,
    ambiguousExits,
  };
  diagnostics.emptyReason = deriveEmptyReason(diagnostics, closedTrades.length, config);

  // Finalize challenge result. If the loop ran to completion without breach,
  // determine whether the trader passed (target hit + min trading days met)
  // or simply ran out of runway (IN_PROGRESS = "neither passed nor failed").
  if (rulesActive) {
    if (challengeStatus === 'IN_PROGRESS') {
      const minDaysOk = !rules!.minTradingDays || tradingDays.size >= rules!.minTradingDays;
      if (profitTargetHitDate && minDaysOk) {
        challengeStatus = 'PASSED';
      }
    }
    diagnostics.challengeResult = {
      enabled:               true,
      status:                challengeStatus,
      breachedRule,
      breachDate,
      breachEquity:          breachEquity != null ? parseFloat(breachEquity.toFixed(2)) : undefined,
      breachAtTradeCount,
      profitTargetHitDate,
      profitTargetHitEquity: profitTargetHitEquity != null ? parseFloat(profitTargetHitEquity.toFixed(2)) : undefined,
      tradingDaysCount:      tradingDays.size,
      highWaterMark:         parseFloat(highWaterMark.toFixed(2)),
      lowestEquity:          parseFloat(lowestEquity.toFixed(2)),
      // Stored as percentage (0-100) to match the rest of the metrics
      // surface; the input config uses fractions (0.05 = 5%).
      maxDailyLossPct:       parseFloat((maxDailyLossPct * 100).toFixed(2)),
      maxDrawdownFromHWMPct: parseFloat((maxDrawdownFromHWMPct * 100).toFixed(2)),
    };
  }

  return { closedTrades, finalBalance: runningBalance, diagnostics };
}

// Build a user-facing explanation of why the run produced zero trades.
// Ordered by specificity — the first matching condition wins.
function deriveEmptyReason(
  d: RunDiagnostics,
  closedTradeCount: number,
  config: PureEngineConfig,
): string | undefined {
  if (closedTradeCount > 0) return undefined;

  if (d.signalCount === 0) {
    if (config.strategyType === 'CUSTOM') {
      return 'Your strategy produced no buy or sell signals over this date range. '
        + 'The conditions may be too restrictive, indicator thresholds may never have been crossed, '
        + 'or the date range may be too short for the indicator warmup. '
        + 'Try widening the date range or loosening the threshold values.';
    }
    return `The ${config.strategyType} strategy produced no signals over this date range. `
      + 'Try widening the date range or adjusting the strategy parameters.';
  }

  if (d.entryAttempts === 0 && d.entriesSkipped > 0) {
    return `Signals fired (${d.signalCount}) but every one landed on the final bar, `
      + 'so no entries could be taken. Extend the end date by at least one bar.';
  }

  if (d.entriesTaken === 0) {
    return `Signals fired (${d.signalCount}) but no entries were taken. `
      + 'Check maxOpenPositions and slippage settings.';
  }

  // Entries were taken but somehow zero trades closed — shouldn't be
  // reachable because we force-close at end of data, but cover defensively.
  return 'Entries were taken but no trades were recorded. This is unexpected — '
    + 'please report this run id.';
}
