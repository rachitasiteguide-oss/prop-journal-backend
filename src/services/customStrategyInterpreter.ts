import {
  calcSMA, calcEMA, calcRSI, calcMACD, calcBB,
  calcStochastic, calcATR, calcCCI, calcWilliamsR, calcADX, calcDonchian,
} from './indicatorService';

// ── DSL Types (shared with frontend) ─────────────────────────────────────────

export type IndicatorType =
  | 'RSI' | 'SMA' | 'EMA'
  | 'MACD_LINE' | 'MACD_SIGNAL' | 'MACD_HIST'
  | 'BB_UPPER' | 'BB_MIDDLE' | 'BB_LOWER'
  | 'STOCH_K' | 'STOCH_D'
  | 'ATR' | 'CCI' | 'WILLIAMS_R'
  | 'ADX' | 'DI_PLUS' | 'DI_MINUS'
  | 'DONCHIAN_UPPER' | 'DONCHIAN_LOWER' | 'DONCHIAN_MIDDLE'
  | 'CLOSE' | 'OPEN' | 'HIGH' | 'LOW' | 'VOLUME';

export type ConditionOp =
  | 'GT' | 'LT' | 'GTE' | 'LTE' | 'EQ'
  | 'CROSSES_ABOVE' | 'CROSSES_BELOW';

export interface IndicatorDef {
  id:      string;
  type:    IndicatorType;
  params?: Record<string, number>;
}

export interface Condition {
  left:  string;        // indicator id or numeric string
  op:    ConditionOp;
  right: string | number;  // indicator id or numeric value
}

export interface RuleGroup {
  logic:      'AND' | 'OR';
  conditions: Condition[];
}

export interface CustomStrategyDSL {
  name:        string;
  description?: string;
  indicators:  IndicatorDef[];
  buy:         RuleGroup;
  sell:        RuleGroup;
}

// ── Candle slice (minimal interface) ─────────────────────────────────────────

interface Candle {
  open: number; high: number; low: number; close: number; volume: number;
}

// ── Series registry ───────────────────────────────────────────────────────────
// Maps indicator id → null-padded series aligned to candle array length.

type Series = (number | null)[];

// Frontend inputs sometimes round-trip period values through string state
// (e.g. `<input type="number">` binding to a string). The interpreter must
// accept those transparently — otherwise the indicator calculators receive
// a string for `period` and silently produce NaN-laden output, which then
// fails every comparison and emits zero signals.
function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function buildRegistry(candles: Candle[], indicators: IndicatorDef[]): Map<string, Series> {
  const map = new Map<string, Series>();
  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // Built-in price series
  map.set('CLOSE',  closes);
  map.set('OPEN',   candles.map((c) => c.open));
  map.set('HIGH',   highs);
  map.set('LOW',    lows);
  map.set('VOLUME', volumes);

  for (const def of indicators) {
    const p = (def.params ?? {}) as Record<string, unknown>;

    switch (def.type) {
      case 'RSI':
        map.set(def.id, calcRSI(closes, num(p.period, 14)));
        break;
      case 'SMA':
        map.set(def.id, calcSMA(closes, num(p.period, 20)));
        break;
      case 'EMA':
        map.set(def.id, calcEMA(closes, num(p.period, 20)));
        break;
      case 'MACD_LINE':
      case 'MACD_SIGNAL':
      case 'MACD_HIST': {
        const macd = calcMACD(closes, num(p.fastPeriod, 12), num(p.slowPeriod, 26), num(p.signalPeriod, 9));
        if (def.type === 'MACD_LINE')   map.set(def.id, macd.map((m) => m.macd));
        if (def.type === 'MACD_SIGNAL') map.set(def.id, macd.map((m) => m.signal));
        if (def.type === 'MACD_HIST')   map.set(def.id, macd.map((m) => m.histogram));
        break;
      }
      case 'BB_UPPER':
      case 'BB_MIDDLE':
      case 'BB_LOWER': {
        const bb = calcBB(closes, num(p.period, 20), num(p.stdDev, 2));
        if (def.type === 'BB_UPPER')  map.set(def.id, bb.map((b) => b.upper));
        if (def.type === 'BB_MIDDLE') map.set(def.id, bb.map((b) => b.middle));
        if (def.type === 'BB_LOWER')  map.set(def.id, bb.map((b) => b.lower));
        break;
      }
      case 'STOCH_K':
      case 'STOCH_D': {
        const stoch = calcStochastic(highs, lows, closes, num(p.period, 14), num(p.signalPeriod, 3));
        if (def.type === 'STOCH_K') map.set(def.id, stoch.map((s) => s.k));
        if (def.type === 'STOCH_D') map.set(def.id, stoch.map((s) => s.d));
        break;
      }
      case 'ATR':
        map.set(def.id, calcATR(highs, lows, closes, num(p.period, 14)));
        break;
      case 'CCI':
        map.set(def.id, calcCCI(highs, lows, closes, num(p.period, 20)));
        break;
      case 'WILLIAMS_R':
        map.set(def.id, calcWilliamsR(highs, lows, closes, num(p.period, 14)));
        break;
      case 'ADX':
      case 'DI_PLUS':
      case 'DI_MINUS': {
        const adx = calcADX(highs, lows, closes, num(p.period, 14));
        if (def.type === 'ADX')      map.set(def.id, adx.map((a) => a.adx));
        if (def.type === 'DI_PLUS')  map.set(def.id, adx.map((a) => a.pdi));
        if (def.type === 'DI_MINUS') map.set(def.id, adx.map((a) => a.mdi));
        break;
      }
      case 'DONCHIAN_UPPER':
      case 'DONCHIAN_LOWER':
      case 'DONCHIAN_MIDDLE': {
        const dc = calcDonchian(highs, lows, num(p.period, 20));
        if (def.type === 'DONCHIAN_UPPER')  map.set(def.id, dc.map((d) => d.upper));
        if (def.type === 'DONCHIAN_LOWER')  map.set(def.id, dc.map((d) => d.lower));
        if (def.type === 'DONCHIAN_MIDDLE') map.set(def.id, dc.map((d) => d.middle));
        break;
      }
      // CLOSE/OPEN/HIGH/LOW/VOLUME already registered; skip if user re-declares them
      case 'CLOSE': map.set(def.id, closes);   break;
      case 'OPEN':  map.set(def.id, candles.map((c) => c.open)); break;
      case 'HIGH':  map.set(def.id, highs);    break;
      case 'LOW':   map.set(def.id, lows);     break;
      case 'VOLUME':map.set(def.id, volumes);  break;
    }
  }

  return map;
}

// ── Condition evaluator ───────────────────────────────────────────────────────

function resolve(ref: string | number, registry: Map<string, Series>, i: number): number | null {
  if (typeof ref === 'number') return ref;
  const n = Number(ref);
  if (!isNaN(n)) return n;
  // Lookup by id
  const series = registry.get(ref);
  return series ? (series[i] ?? null) : null;
}

function evalCondition(
  cond: Condition,
  registry: Map<string, Series>,
  i: number,
): boolean {
  const { left, op, right } = cond;

  if (op === 'CROSSES_ABOVE' || op === 'CROSSES_BELOW') {
    if (i < 1) return false;
    const leftSeries  = registry.get(left);
    const rightSeries = typeof right === 'string' && !isNaN(Number(right)) ? null : registry.get(right as string);
    const rightVal    = rightSeries ? null : (typeof right === 'number' ? right : Number(right));

    const leftPrev  = leftSeries?.[i - 1] ?? null;
    const leftCurr  = leftSeries?.[i]     ?? null;
    const rightPrev = rightSeries ? (rightSeries[i - 1] ?? null) : rightVal;
    const rightCurr = rightSeries ? (rightSeries[i]     ?? null) : rightVal;

    if (leftPrev === null || leftCurr === null || rightPrev === null || rightCurr === null) return false;

    if (op === 'CROSSES_ABOVE') return leftPrev <= rightPrev && leftCurr > rightCurr;
    if (op === 'CROSSES_BELOW') return leftPrev >= rightPrev && leftCurr < rightCurr;
  }

  const l = resolve(left, registry, i);
  const r = resolve(right, registry, i);
  if (l === null || r === null) return false;

  switch (op) {
    case 'GT':  return l > r;
    case 'LT':  return l < r;
    case 'GTE': return l >= r;
    case 'LTE': return l <= r;
    case 'EQ':  return Math.abs(l - r) < 1e-10;
    default:    return false;
  }
}

function evalGroup(
  group: RuleGroup,
  registry: Map<string, Series>,
  i: number,
): boolean {
  if (group.conditions.length === 0) return false;

  if (group.logic === 'AND') {
    return group.conditions.every((c) => evalCondition(c, registry, i));
  }
  return group.conditions.some((c) => evalCondition(c, registry, i));
}

// ── Main export ───────────────────────────────────────────────────────────────

export type Signal = 'BUY' | 'SELL' | null;

export function generateCustomSignals(
  candles: Candle[],
  dsl: CustomStrategyDSL,
): Signal[] {
  const registry = buildRegistry(candles, dsl.indicators);
  const signals: Signal[] = new Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i++) {
    if (evalGroup(dsl.buy, registry, i)) {
      signals[i] = 'BUY';
    } else if (evalGroup(dsl.sell, registry, i)) {
      signals[i] = 'SELL';
    }
  }

  return signals;
}
