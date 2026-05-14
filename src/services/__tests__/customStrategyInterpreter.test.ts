// Exhaustive tests for the CUSTOM strategy DSL interpreter.
//
// Goal: exercise every indicator type, every operator, every logic mode,
// every operand shape (id↔id, id↔number, id↔numeric-string, etc.), and the
// end-to-end pathway through generateSignalsPure with strategyType='CUSTOM'.
// If custom backtesting "doesn't work," the failures here will say *why*.

import { describe, it, expect } from 'vitest';
import {
  generateCustomSignals,
  type CustomStrategyDSL,
  type IndicatorType,
  type ConditionOp,
} from '../customStrategyInterpreter';
import { generateSignalsPure, minCandlesRequired, runEventLoopPure } from '../backtestEngineCore';

// ── Synthetic candle generators ─────────────────────────────────────────────

interface C { open: number; high: number; low: number; close: number; volume: number }

// Smooth uptrend: makes SMA/EMA/RSI predictable.
function uptrend(n: number, start = 100, step = 1): C[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * step;
    return { open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
  });
}

function downtrend(n: number, start = 200, step = 1): C[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start - i * step;
    return { open: close + 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
  });
}

// Sine-wave oscillator: produces RSI extremes & crosses.
function oscillating(n: number, base = 100, amp = 20, period = 20): C[] {
  return Array.from({ length: n }, (_, i) => {
    const close = base + amp * Math.sin((i / period) * 2 * Math.PI);
    return { open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
  });
}

// Helper: count signals of a given kind in a result array.
function count(signals: Array<'BUY'|'SELL'|null>, kind: 'BUY'|'SELL'): number {
  return signals.filter((s) => s === kind).length;
}

// ── Indicator-registry coverage ─────────────────────────────────────────────
// For each indicator type, build a trivial DSL whose BUY rule is
// `<indicator> GT -1e12` (essentially "fire whenever the indicator has a
// value"), and assert that at least one BUY is produced once the warmup
// window has elapsed. If the registry forgot to wire up a type, every value
// in the series is null → no signal → test fails loudly.

const INDICATOR_CASES: Array<{
  type: IndicatorType;
  params?: Record<string, number>;
  warmup: number;   // approximate first index where the indicator becomes non-null
}> = [
  { type: 'RSI',             params: { period: 14 }, warmup: 15 },
  { type: 'SMA',             params: { period: 10 }, warmup: 10 },
  { type: 'EMA',             params: { period: 10 }, warmup: 10 },
  { type: 'MACD_LINE',       params: { fastPeriod: 5, slowPeriod: 10, signalPeriod: 3 }, warmup: 13 },
  { type: 'MACD_SIGNAL',     params: { fastPeriod: 5, slowPeriod: 10, signalPeriod: 3 }, warmup: 13 },
  { type: 'MACD_HIST',       params: { fastPeriod: 5, slowPeriod: 10, signalPeriod: 3 }, warmup: 13 },
  { type: 'BB_UPPER',        params: { period: 10, stdDev: 2 }, warmup: 10 },
  { type: 'BB_MIDDLE',       params: { period: 10, stdDev: 2 }, warmup: 10 },
  { type: 'BB_LOWER',        params: { period: 10, stdDev: 2 }, warmup: 10 },
  { type: 'STOCH_K',         params: { period: 14, signalPeriod: 3 }, warmup: 17 },
  { type: 'STOCH_D',         params: { period: 14, signalPeriod: 3 }, warmup: 17 },
  { type: 'ATR',             params: { period: 14 }, warmup: 15 },
  { type: 'CCI',             params: { period: 20 }, warmup: 20 },
  { type: 'WILLIAMS_R',      params: { period: 14 }, warmup: 14 },
  { type: 'ADX',             params: { period: 14 }, warmup: 28 },
  { type: 'DI_PLUS',         params: { period: 14 }, warmup: 28 },
  { type: 'DI_MINUS',        params: { period: 14 }, warmup: 28 },
  { type: 'DONCHIAN_UPPER',  params: { period: 10 }, warmup: 10 },
  { type: 'DONCHIAN_LOWER',  params: { period: 10 }, warmup: 10 },
  { type: 'DONCHIAN_MIDDLE', params: { period: 10 }, warmup: 10 },
  { type: 'CLOSE',  warmup: 0 },
  { type: 'OPEN',   warmup: 0 },
  { type: 'HIGH',   warmup: 0 },
  { type: 'LOW',    warmup: 0 },
  { type: 'VOLUME', warmup: 0 },
];

describe('customStrategyInterpreter: indicator registry coverage', () => {
  const candles = oscillating(120);

  for (const { type, params, warmup } of INDICATOR_CASES) {
    it(`registers ${type} and produces a value past warmup ${warmup}`, () => {
      const dsl: CustomStrategyDSL = {
        name: `probe-${type}`,
        indicators: [{ id: 'x', type, params }],
        buy:  { logic: 'AND', conditions: [{ left: 'x', op: 'GT', right: -1e12 }] },
        sell: { logic: 'AND', conditions: [] },
      };
      const signals = generateCustomSignals(candles, dsl);
      // We expect at least one BUY after warmup (since all real values > -1e12).
      const fired = signals.slice(warmup + 1).some((s) => s === 'BUY');
      expect(fired, `${type} never produced a BUY past i=${warmup}`).toBe(true);
    });
  }
});

// ── Operator coverage ───────────────────────────────────────────────────────

describe('customStrategyInterpreter: operator semantics', () => {
  // Two candles is enough to test scalar comparisons.
  const candles = uptrend(40); // closes 100,101,102,...

  // close[i] vs constant 110: GT fires from i=11 onward.
  const ops: Array<{ op: ConditionOp; expectFireOnce: boolean; desc: string }> = [
    { op: 'GT',  expectFireOnce: true,  desc: 'close > 110 fires once price exceeds threshold' },
    { op: 'LT',  expectFireOnce: true,  desc: 'close < 110 fires while price below threshold' },
    { op: 'GTE', expectFireOnce: true,  desc: 'close >= 110 fires' },
    { op: 'LTE', expectFireOnce: true,  desc: 'close <= 110 fires' },
    { op: 'EQ',  expectFireOnce: true,  desc: 'close == 110 fires on exactly one bar' },
  ];

  for (const { op, expectFireOnce, desc } of ops) {
    it(desc, () => {
      const dsl: CustomStrategyDSL = {
        name: `op-${op}`,
        indicators: [],
        buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op, right: 110 }] },
        sell: { logic: 'AND', conditions: [] },
      };
      const signals = generateCustomSignals(candles, dsl);
      const fired = count(signals, 'BUY') > 0;
      expect(fired, `${op} produced zero BUYs`).toBe(expectFireOnce);
    });
  }

  it('CROSSES_ABOVE: fires exactly when close transitions from <= threshold to > threshold', () => {
    // closes 100..139. We cross 110 between i=10 (close=110) and i=11 (close=111).
    const dsl: CustomStrategyDSL = {
      name: 'cross-above',
      indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'CROSSES_ABOVE', right: 110 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(signals[11]).toBe('BUY');
    // Should not fire on any other bar.
    expect(count(signals, 'BUY')).toBe(1);
  });

  it('CROSSES_BELOW: fires on downtrend through threshold', () => {
    const c = downtrend(40);  // 200,199,...
    const dsl: CustomStrategyDSL = {
      name: 'cross-below',
      indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'CROSSES_BELOW', right: 190 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(c, dsl);
    // close[10]=190, close[11]=189 → cross-below at i=11
    expect(signals[11]).toBe('BUY');
    expect(count(signals, 'BUY')).toBe(1);
  });

  it('CROSSES_ABOVE between two indicator series (SMA fast vs slow)', () => {
    const c = oscillating(120, 100, 30, 30);
    const dsl: CustomStrategyDSL = {
      name: 'ma-cross',
      indicators: [
        { id: 'fast', type: 'SMA', params: { period: 5 } },
        { id: 'slow', type: 'SMA', params: { period: 20 } },
      ],
      buy:  { logic: 'AND', conditions: [{ left: 'fast', op: 'CROSSES_ABOVE', right: 'slow' }] },
      sell: { logic: 'AND', conditions: [{ left: 'fast', op: 'CROSSES_BELOW', right: 'slow' }] },
    };
    const signals = generateCustomSignals(c, dsl);
    expect(count(signals, 'BUY')).toBeGreaterThan(0);
    expect(count(signals, 'SELL')).toBeGreaterThan(0);
  });

  it('EQ uses epsilon comparison for floats', () => {
    // CLOSE==110 should hit exactly once.
    const dsl: CustomStrategyDSL = {
      name: 'eq',
      indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'EQ', right: 110 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(signals[10]).toBe('BUY');
    expect(count(signals, 'BUY')).toBe(1);
  });
});

// ── Operand-shape coverage ─────────────────────────────────────────────────

describe('customStrategyInterpreter: operand shapes', () => {
  const candles = uptrend(40);

  it('right as numeric value (number)', () => {
    const dsl: CustomStrategyDSL = {
      name: 'r-num', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: 110 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(count(generateCustomSignals(candles, dsl), 'BUY')).toBeGreaterThan(0);
  });

  it('right as numeric string ("110") — frontend often sends strings from inputs', () => {
    const dsl: CustomStrategyDSL = {
      name: 'r-str', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: '110' }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(count(generateCustomSignals(candles, dsl), 'BUY')).toBeGreaterThan(0);
  });

  it('left as numeric string compared to indicator id', () => {
    const dsl: CustomStrategyDSL = {
      name: 'l-str', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: '110', op: 'LT', right: 'CLOSE' }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(count(generateCustomSignals(candles, dsl), 'BUY')).toBeGreaterThan(0);
  });

  it('indicator id ↔ indicator id', () => {
    const dsl: CustomStrategyDSL = {
      name: 'id-id',
      indicators: [
        { id: 'sma5',  type: 'SMA', params: { period: 5 } },
        { id: 'sma20', type: 'SMA', params: { period: 20 } },
      ],
      buy:  { logic: 'AND', conditions: [{ left: 'sma5', op: 'GT', right: 'sma20' }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(count(generateCustomSignals(candles, dsl), 'BUY')).toBeGreaterThan(0);
  });

  it('unknown indicator id silently produces no signals (current behavior — caller must validate)', () => {
    const dsl: CustomStrategyDSL = {
      name: 'unknown', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'nonexistent', op: 'GT', right: 0 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(count(generateCustomSignals(candles, dsl), 'BUY')).toBe(0);
  });
});

// ── Logic-group semantics ───────────────────────────────────────────────────

describe('customStrategyInterpreter: AND/OR/empty groups', () => {
  const candles = uptrend(40);

  it('AND requires all conditions true', () => {
    const dsl: CustomStrategyDSL = {
      name: 'and', indicators: [],
      buy: { logic: 'AND', conditions: [
        { left: 'CLOSE', op: 'GT', right: 110 },
        { left: 'CLOSE', op: 'LT', right: 120 },
      ] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    // CLOSE 111..119 → 9 bars satisfy both. (Not strict on exact count;
    // assert >0 and <total.)
    const n = count(signals, 'BUY');
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(candles.length);
  });

  it('OR fires if any condition is true', () => {
    const dsl: CustomStrategyDSL = {
      name: 'or', indicators: [],
      buy: { logic: 'OR', conditions: [
        { left: 'CLOSE', op: 'LT', right: 105 },
        { left: 'CLOSE', op: 'GT', right: 130 },
      ] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(count(signals, 'BUY')).toBeGreaterThan(0);
  });

  it('empty conditions never fires', () => {
    const dsl: CustomStrategyDSL = {
      name: 'empty', indicators: [],
      buy:  { logic: 'AND', conditions: [] },
      sell: { logic: 'OR',  conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(count(signals, 'BUY')).toBe(0);
    expect(count(signals, 'SELL')).toBe(0);
  });

  it('BUY wins on the same bar when both rules match (documented precedence)', () => {
    const dsl: CustomStrategyDSL = {
      name: 'tie', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: 100 }] },
      sell: { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: 100 }] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(count(signals, 'SELL')).toBe(0);
    expect(count(signals, 'BUY')).toBeGreaterThan(0);
  });
});

// ── Param-type coercion ─────────────────────────────────────────────────────

describe('customStrategyInterpreter: indicator-param type coercion', () => {
  // JSON deserialization is type-preserving, but the frontend builder
  // sometimes round-trips period inputs through string state. The interpreter
  // must accept numeric strings transparently.
  const candles = oscillating(120);

  it('params with stringified numbers ({ period: "14" }) still produce values', () => {
    const dsl: CustomStrategyDSL = {
      name: 'param-str',
      indicators: [{ id: 'r', type: 'RSI', params: { period: '14' as unknown as number } }],
      buy:  { logic: 'AND', conditions: [{ left: 'r', op: 'GT', right: 50 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(count(signals, 'BUY')).toBeGreaterThan(0);
  });

  it('params undefined → defaults apply (RSI default 14)', () => {
    const dsl: CustomStrategyDSL = {
      name: 'param-default',
      indicators: [{ id: 'r', type: 'RSI' }],
      buy:  { logic: 'AND', conditions: [{ left: 'r', op: 'GT', right: -1 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateCustomSignals(candles, dsl);
    expect(count(signals, 'BUY')).toBeGreaterThan(0);
  });
});

// ── End-to-end through generateSignalsPure ──────────────────────────────────

describe('generateSignalsPure: CUSTOM dispatch', () => {
  const candles = uptrend(60).map((c, i) => ({ ...c, openTime: new Date(2024, 0, 1 + i) }));

  it('routes strategyType=CUSTOM through the interpreter and emits signals', () => {
    const dsl: CustomStrategyDSL = {
      name: 'e2e', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'CROSSES_ABOVE', right: 120 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const signals = generateSignalsPure(candles, 'CUSTOM', {}, dsl);
    // CLOSE goes 100..159; crosses 120 at i=21 (close=121, prev=120).
    expect(signals[21]).toBe('BUY');
    expect(count(signals, 'BUY')).toBe(1);
  });

  it('strategyType=CUSTOM with no customStrategy throws (loud failure beats silent zero-trade run)', () => {
    expect(() => generateSignalsPure(candles, 'CUSTOM', {})).toThrow(/no customStrategy DSL/i);
  });

  it('CUSTOM ignores strategyConfig — params come from the DSL', () => {
    const dsl: CustomStrategyDSL = {
      name: 'ignore-cfg', indicators: [],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: 130 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    const a = generateSignalsPure(candles, 'CUSTOM', { unused: 'value' }, dsl);
    const b = generateSignalsPure(candles, 'CUSTOM', {}, dsl);
    expect(a).toEqual(b);
  });
});

// ── minCandlesRequired for CUSTOM ───────────────────────────────────────────

describe('minCandlesRequired: CUSTOM warmup derivation', () => {
  it('returns the floor (30) when DSL has no period-bearing indicators', () => {
    const dsl: CustomStrategyDSL = {
      name: 'no-periods', indicators: [{ id: 'c', type: 'CLOSE' }],
      buy:  { logic: 'AND', conditions: [{ left: 'c', op: 'GT', right: 0 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(minCandlesRequired('CUSTOM', {}, dsl)).toBe(30);
  });

  it('picks the largest single period across multiple indicators', () => {
    const dsl: CustomStrategyDSL = {
      name: 'mixed',
      indicators: [
        { id: 'sma200', type: 'SMA', params: { period: 200 } },
        { id: 'rsi14',  type: 'RSI', params: { period: 14 } },
      ],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: 'sma200' }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(minCandlesRequired('CUSTOM', {}, dsl)).toBe(201);
  });

  it('accounts for MACD warmup = slow + signal', () => {
    const dsl: CustomStrategyDSL = {
      name: 'macd',
      indicators: [{ id: 'm', type: 'MACD_LINE', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } }],
      buy:  { logic: 'AND', conditions: [{ left: 'm', op: 'GT', right: 0 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    // slow(26) + signal(9) = 35 → +1 buffer → 36
    expect(minCandlesRequired('CUSTOM', {}, dsl)).toBe(36);
  });

  it('accounts for ADX warmup = 2 × period', () => {
    const dsl: CustomStrategyDSL = {
      name: 'adx',
      indicators: [{ id: 'a', type: 'ADX', params: { period: 14 } }],
      buy:  { logic: 'AND', conditions: [{ left: 'a', op: 'GT', right: 25 }] },
      sell: { logic: 'AND', conditions: [] },
    };
    // 2 × 14 = 28 → below the 30 floor → 30
    expect(minCandlesRequired('CUSTOM', {}, dsl)).toBe(30);
  });

  it('coerces string params for warmup derivation', () => {
    const dsl: CustomStrategyDSL = {
      name: 'str-period',
      indicators: [{ id: 's', type: 'SMA', params: { period: '100' as unknown as number } }],
      buy:  { logic: 'AND', conditions: [{ left: 'CLOSE', op: 'GT', right: 's' }] },
      sell: { logic: 'AND', conditions: [] },
    };
    expect(minCandlesRequired('CUSTOM', {}, dsl)).toBe(101);
  });
});

// ── Run diagnostics: explain why zero trades ────────────────────────────────

describe('runEventLoopPure: zero-trade diagnostics', () => {
  const baseConfig = {
    strategyType:     'CUSTOM' as const,
    strategyConfig:   {},
    startingBalance:  10000,
    volume:           1,
    stopLossPct:      0.02,
    takeProfitRatio:  2,
    slippagePct:      0,
    commission:       0,
    maxOpenPositions: 1,
    instrumentType:   'STOCK',
  };

  function pureCandles(n: number): Array<{ openTime: Date; open: number; high: number; low: number; close: number; volume: number }> {
    return uptrend(n).map((c, i) => ({ ...c, openTime: new Date(Date.UTC(2024, 0, i + 1)) }));
  }

  it('flags no-signals when every signal slot is null', () => {
    const candles = pureCandles(30);
    const signals = new Array<'BUY'|'SELL'|null>(30).fill(null);
    const { diagnostics } = runEventLoopPure(candles, signals, baseConfig, 'TEST');
    expect(diagnostics.signalCount).toBe(0);
    expect(diagnostics.entriesTaken).toBe(0);
    expect(diagnostics.emptyReason).toMatch(/no buy or sell signals/i);
  });

  it('flags final-bar-only signals as unenterable', () => {
    const candles = pureCandles(30);
    const signals = new Array<'BUY'|'SELL'|null>(30).fill(null);
    signals[29] = 'BUY'; // last bar — entry can't fire (needs i+1)
    const { diagnostics, closedTrades } = runEventLoopPure(candles, signals, baseConfig, 'TEST');
    expect(closedTrades.length).toBe(0);
    expect(diagnostics.signalCount).toBe(1);
    expect(diagnostics.entriesTaken).toBe(0);
    expect(diagnostics.entriesSkipped).toBe(1);
    expect(diagnostics.emptyReason).toMatch(/final bar/i);
  });

  it('reports counts and no emptyReason when trades close normally', () => {
    const candles = pureCandles(30);
    const signals = new Array<'BUY'|'SELL'|null>(30).fill(null);
    signals[5] = 'BUY';
    const { diagnostics, closedTrades } = runEventLoopPure(candles, signals, baseConfig, 'TEST');
    expect(diagnostics.signalCount).toBe(1);
    expect(diagnostics.entriesTaken).toBe(1);
    expect(closedTrades.length).toBe(1); // closed by force-close or SL/TP
    expect(diagnostics.emptyReason).toBeUndefined();
  });
});

// ── Worker-boundary serialization parity ────────────────────────────────────
// The worker thread receives the DSL via structured clone. JSON round-trip
// is a strict subset of structured-clone semantics, so JSON parity is a
// sufficient proxy and is cheaper to test than spinning up a worker.

describe('customStrategyInterpreter: JSON round-trip parity', () => {
  it('signals are identical after JSON serialize/deserialize of the DSL', () => {
    const candles = oscillating(120);
    const original: CustomStrategyDSL = {
      name: 'rt',
      indicators: [
        { id: 'rsi', type: 'RSI', params: { period: 14 } },
        { id: 'sma', type: 'SMA', params: { period: 20 } },
      ],
      buy: { logic: 'AND', conditions: [
        { left: 'rsi', op: 'CROSSES_ABOVE', right: 30 },
        { left: 'CLOSE', op: 'GT', right: 'sma' },
      ] },
      sell: { logic: 'OR', conditions: [
        { left: 'rsi', op: 'GT', right: 70 },
      ] },
    };
    const clone = JSON.parse(JSON.stringify(original)) as CustomStrategyDSL;
    const a = generateCustomSignals(candles, original);
    const b = generateCustomSignals(candles, clone);
    expect(a).toEqual(b);
  });
});
