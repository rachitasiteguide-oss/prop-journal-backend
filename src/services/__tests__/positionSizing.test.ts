// Position-sizing primitive tests.
//
// Each test constructs a deterministic candle series, kicks off a BUY signal,
// and asserts the recorded trade.volume matches the textbook sizing formula.
// All scenarios use STOCKS so the multiplier is 1 — every $1 of price move
// is $1 of P&L per unit of volume — which makes the maths trivially verifiable.

import { describe, it, expect } from 'vitest';
import {
  runEventLoopPure,
  type PureCandle,
  type PureEngineConfig,
  type Signal,
} from '../backtestEngineCore';

function flatCandles(n: number, price: number): PureCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: new Date(Date.UTC(2024, 0, i + 1)),
    open: price, high: price, low: price, close: price, volume: 1000,
  }));
}

const baseConfig: PureEngineConfig = {
  strategyType:     'CUSTOM',
  strategyConfig:   {},
  startingBalance:  10_000,
  volume:           1,           // FIXED fallback
  stopLossPct:      0.02,        // 2% SL
  takeProfitRatio:  2,
  slippagePct:      0,
  commission:       0,
  maxOpenPositions: 1,
  instrumentType:   'STOCKS',
};

describe('SizingConfig: FIXED', () => {
  it('uses config.volume when sizing.mode === FIXED', () => {
    const c = flatCandles(10, 100);
    const signals: Signal[] = [null, ...Array(9).fill(null)] as Signal[];
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = {
      ...baseConfig,
      volume: 7,
      sizing: { mode: 'FIXED' },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(1);
    expect(closedTrades[0].volume).toBe(7);
  });

  it('FIXED is the default when sizing omitted', () => {
    const c = flatCandles(10, 100);
    const signals: Signal[] = Array(10).fill(null) as Signal[];
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = { ...baseConfig, volume: 3 };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades[0].volume).toBe(3);
  });
});

describe('SizingConfig: PCT_EQUITY', () => {
  it('sizes notional to pctEquity × startingBalance', () => {
    // 10% of $10k = $1000 notional. STOCKS at $100 → 10 shares.
    const c = flatCandles(10, 100);
    const signals: Signal[] = Array(10).fill(null) as Signal[];
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = {
      ...baseConfig,
      sizing: { mode: 'PCT_EQUITY', pctEquity: 0.10 },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(1);
    expect(closedTrades[0].volume).toBeCloseTo(10, 4);
  });

  it('uses entry price after slippage (entry side has slippage baked in)', () => {
    // pctEquity = 5%, slippage = 1% → entry at $101. Notional $500 / $101 = ~4.95.
    const c = flatCandles(10, 100);
    const signals: Signal[] = Array(10).fill(null) as Signal[];
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = {
      ...baseConfig,
      slippagePct: 0.01,
      sizing: { mode: 'PCT_EQUITY', pctEquity: 0.05 },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    // Notional $500 / (price × (1+slip)) / multiplier(1) = 500 / 101 ≈ 4.9505
    expect(closedTrades[0].volume).toBeCloseTo(500 / 101, 4);
  });

  it('falls back to FIXED when pctEquity is 0', () => {
    const c = flatCandles(10, 100);
    const signals: Signal[] = Array(10).fill(null) as Signal[];
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = {
      ...baseConfig,
      volume: 2,
      sizing: { mode: 'PCT_EQUITY', pctEquity: 0 },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades[0].volume).toBe(2);
  });
});

describe('SizingConfig: RISK_BASED (PCT stop)', () => {
  it('sizes so loss-at-SL equals riskPerTrade × equity', () => {
    // $10k account, 1% risk = $100 dollar risk. SL = 2% × $100 = $2 stop distance.
    // STOCKS multiplier 1 → volume = $100 / $2 = 50 units.
    const c = flatCandles(10, 100);
    const signals: Signal[] = Array(10).fill(null) as Signal[];
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = {
      ...baseConfig,
      sizing: { mode: 'RISK_BASED', riskPerTrade: 0.01, stopSource: 'PCT' },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(1);
    expect(closedTrades[0].volume).toBeCloseTo(50, 4);
  });

  it('the actual SL loss matches the targeted dollar risk', () => {
    // Build a series where the price drops to exactly the SL on bar 3.
    // riskPerTrade = 2%, stopLossPct = 5% → volume = 4 units.
    // Loss when SL hits = (entry - SL) × volume = ($100 - $95) × 4 = $20.
    // Dollar-risk target = 2% × $10k = $200. Wait — math: stopDistance = $5,
    // dollarRisk = $200, volume = $200 / $5 = 40 units. Loss = $5 × 40 = $200.
    const c: PureCandle[] = [
      { openTime: new Date(Date.UTC(2024, 0, 1)), open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { openTime: new Date(Date.UTC(2024, 0, 2)), open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      // SL trigger: price hits 95
      { openTime: new Date(Date.UTC(2024, 0, 3)), open: 100, high: 100, low: 94, close: 95, volume: 1000 },
    ];
    const signals: Signal[] = ['BUY', null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      stopLossPct: 0.05,
      takeProfitRatio: 100, // ensure TP doesn't trigger
      sizing: { mode: 'RISK_BASED', riskPerTrade: 0.02, stopSource: 'PCT' },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(1);
    expect(closedTrades[0].volume).toBeCloseTo(40, 4);
    // P&L when SL hits = -$200 (the targeted dollar risk).
    expect(closedTrades[0].pnl).toBeCloseTo(-200, 1);
  });

  it('size scales linearly with riskPerTrade', () => {
    const c = flatCandles(10, 100);
    const signals: Signal[] = Array(10).fill(null) as Signal[];
    signals[0] = 'BUY';

    const v1 = runEventLoopPure(c, signals, {
      ...baseConfig,
      sizing: { mode: 'RISK_BASED', riskPerTrade: 0.01, stopSource: 'PCT' },
    }, 'TEST').closedTrades[0].volume;

    const v2 = runEventLoopPure(c, signals, {
      ...baseConfig,
      sizing: { mode: 'RISK_BASED', riskPerTrade: 0.02, stopSource: 'PCT' },
    }, 'TEST').closedTrades[0].volume;

    expect(v2).toBeCloseTo(v1 * 2, 4);
  });
});

describe('SizingConfig: RISK_BASED (ATR stop)', () => {
  it('uses ATR × multiplier as the stop distance', () => {
    // Need 20+ bars for ATR(14) to warm up. Build a series with a known
    // true range so ATR ≈ a predictable value.
    // Strategy: alternating high/low extremes 2 apart → TR averages to ~2.
    const c: PureCandle[] = Array.from({ length: 30 }, (_, i) => ({
      openTime: new Date(Date.UTC(2024, 0, i + 1)),
      open:    100,
      high:    100 + (i % 2 === 0 ? 1 : 0),
      low:     100 - (i % 2 === 0 ? 1 : 0),
      close:   100,
      volume:  1000,
    }));
    const signals: Signal[] = Array(30).fill(null) as Signal[];
    signals[25] = 'BUY'; // enter well past ATR warmup

    const cfg: PureEngineConfig = {
      ...baseConfig,
      sizing: {
        mode:          'RISK_BASED',
        riskPerTrade:  0.01,
        stopSource:    'ATR',
        atrPeriod:     14,
        atrMultiplier: 2,
      },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(1);
    // ATR will be roughly 1 (TR alternates 2/0); 2× ATR ≈ 2; $100 risk / $2 = 50.
    // Loose bound because exact ATR depends on Wilder smoothing warmup.
    expect(closedTrades[0].volume).toBeGreaterThan(10);
    expect(closedTrades[0].volume).toBeLessThan(200);
  });

  it('skips entry when ATR not yet warm', () => {
    // ATR(20) with only one bar pre-signal → no ATR value yet → volume=0 → skip.
    const c = flatCandles(5, 100);
    const signals: Signal[] = [null, 'BUY', null, null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      sizing: {
        mode:         'RISK_BASED',
        riskPerTrade: 0.01,
        stopSource:   'ATR',
        atrPeriod:    20,
      },
    };

    const { closedTrades, diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(0);
    // Signal counted but no entry taken — diagnostic should reflect skip.
    expect(diagnostics.entriesTaken).toBe(0);
    expect(diagnostics.entriesSkipped).toBeGreaterThan(0);
  });
});

describe('SizingConfig: integration with prop-firm rules', () => {
  it('RISK_BASED sizing keeps a single SL loss within the daily-loss limit', () => {
    // $10k account, riskPerTrade 1% ($100), dailyLossLimit 2% ($200).
    // A single SL hit loses $100 — should NOT breach daily limit even on
    // a back-to-back losing day.
    const c: PureCandle[] = [
      { openTime: new Date(Date.UTC(2024, 0, 1)), open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { openTime: new Date(Date.UTC(2024, 0, 2)), open: 100, high: 100, low: 98,  close: 98,  volume: 1000 },
      { openTime: new Date(Date.UTC(2024, 0, 3)), open: 98,  close: 98,  high: 98, low: 98,    volume: 1000 },
    ];
    const signals: Signal[] = ['BUY', null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      stopLossPct: 0.02,
      sizing:        { mode: 'RISK_BASED', riskPerTrade: 0.01, stopSource: 'PCT' },
      propFirmRules: { enabled: true, dailyLossLimitPct: 0.02 },
    };

    const { diagnostics, closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    // SL hit (price 98 ≤ entry 100 × 0.98 = 98): loss ≈ -$100 (1% risk).
    // Daily limit 2% = $200 — should NOT breach.
    expect(diagnostics.challengeResult!.status).not.toBe('FAILED');
    expect(closedTrades[0].pnl).toBeCloseTo(-100, 1);
  });
});

// ── Regression: Bug 1 — MAE/MFE must scale with the trade's ACTUAL volume ────
// Before the fix, maxAdverse/maxFavorable were multiplied by a hoisted
// constant derived from config.volume (the FIXED fallback), so under
// RISK_BASED/PCT_EQUITY sizing the recorded excursion was off by
// (actualVolume / config.volume). Live FOREX run showed maxAdverse=2383 on a
// trade that lost $106. This locks the correct per-trade scaling.
describe('Regression: MAE/MFE scale with per-trade volume (Bug 1)', () => {
  it('RISK_BASED: maxAdverse/maxFavorable use the position volume, not config.volume', () => {
    // STOCKS, mult 1. $10k acct, 1% risk, 2% SL → volume = 100/(100*0.02) = 50.
    // config.volume is left at 1 — the OLD code would have scaled MAE by 1.
    const c: PureCandle[] = [
      { openTime: new Date(Date.UTC(2024, 0, 1)), open: 100, high: 100, low: 100,   close: 100, volume: 1000 }, // signal
      { openTime: new Date(Date.UTC(2024, 0, 2)), open: 100, high: 100, low: 100,   close: 100, volume: 1000 }, // entry @100
      { openTime: new Date(Date.UTC(2024, 0, 3)), open: 100, high: 100, low: 98.5,  close: 99,  volume: 1000 }, // dip (no SL: SL=98)
      { openTime: new Date(Date.UTC(2024, 0, 4)), open: 99,  high: 101, low: 99,    close: 100, volume: 1000 }, // peak 101
      { openTime: new Date(Date.UTC(2024, 0, 5)), open: 100, high: 101, low: 100,   close: 101, volume: 1000 },
      { openTime: new Date(Date.UTC(2024, 0, 6)), open: 101, high: 101, low: 101,   close: 101, volume: 1000 }, // force-close @101
    ];
    const signals: Signal[] = ['BUY', null, null, null, null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      volume:          1,            // FIXED fallback — must NOT be used for MAE scaling
      stopLossPct:     0.02,         // SL=98, low 98.5 never triggers it
      takeProfitRatio: 5,            // TP=110, never triggers
      sizing: { mode: 'RISK_BASED', riskPerTrade: 0.01, stopSource: 'PCT' },
    };

    const { closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(closedTrades.length).toBe(1);
    const t = closedTrades[0];
    expect(t.volume).toBeCloseTo(50, 4);
    // Adverse price excursion = entry(100) − peakLow(98.5) = 1.5 → ×1×50 = 75.
    expect(t.maxAdverse).toBeCloseTo(75, 4);
    // Favourable = peakHigh(101) − entry(100) = 1.0 → ×1×50 = 50.
    expect(t.maxFavorable).toBeCloseTo(50, 4);
    // Sanity: MAE is ~50× the price distance, proving volume (not config.volume=1) was applied.
    expect(t.maxAdverse).toBeGreaterThan(10);
  });
});
