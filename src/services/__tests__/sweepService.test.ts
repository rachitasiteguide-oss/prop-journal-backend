// Unit tests for the sweep summarisation logic. The full sweep orchestrator
// is tested implicitly by all the existing engine tests + the integration
// test below. We focus here on summariseIteration since it's the bit that
// would be wrong silently — e.g. computing Sharpe from the wrong base.

import { describe, it, expect } from 'vitest';
import { summariseIteration } from '../sweepService';
import type { PureTradeResult, RunDiagnostics } from '../backtestEngineCore';

function trade(pnl: number, opts: Partial<PureTradeResult> = {}): PureTradeResult {
  return {
    symbol:        'TEST',
    side:          pnl >= 0 ? 'BUY' : 'SELL',
    entryPrice:    100,
    exitPrice:     100 + pnl,
    volume:        1,
    stopLoss:      95,
    takeProfit:    110,
    pnl,
    pnlPct:        (pnl / 10000) * 100,
    commission:    0,
    slippage:      0,
    ambiguous:     false,
    forceClosed:   false,
    maxAdverse:    Math.max(0, -pnl),
    maxFavorable:  Math.max(0,  pnl),
    entryAt:       new Date(),
    exitAt:        new Date(),
    ...opts,
  };
}

const emptyDiag: RunDiagnostics = {
  candleCount: 100, signalCount: 0, buySignals: 0, sellSignals: 0,
  entryAttempts: 0, entriesTaken: 0, entriesSkipped: 0, forceClosed: 0,
};

describe('summariseIteration', () => {
  it('zero trades produces an empty summary with a "No trades" warning', () => {
    const m = summariseIteration(10, [], 10_000, 10_000, emptyDiag);
    expect(m.tradeCount).toBe(0);
    expect(m.totalPnl).toBe(0);
    expect(m.profitFactor).toBe(0);
    expect(m.warnings).toContain('No trades');
  });

  it('flags low-sample-size when 1-4 trades', () => {
    const m = summariseIteration(10, [trade(50), trade(-30)], 10_000, 10_020, emptyDiag);
    expect(m.tradeCount).toBe(2);
    expect(m.warnings).toContain('Sample size <5 trades');
  });

  it('does not flag low-sample when ≥5 trades', () => {
    const trades = Array.from({ length: 6 }, (_, i) => trade(i % 2 === 0 ? 100 : -50));
    const m = summariseIteration(10, trades, 10_000, 10_300, emptyDiag);
    expect(m.warnings).not.toContain('Sample size <5 trades');
  });

  it('profit factor = gross win / |gross loss|', () => {
    // 3 winners of $100 = 300; 2 losers of -$50 = -100; PF = 3.0
    const trades = [trade(100), trade(100), trade(100), trade(-50), trade(-50)];
    const m = summariseIteration(10, trades, 10_000, 10_200, emptyDiag);
    expect(m.profitFactor).toBeCloseTo(3.0, 2);
  });

  it('win rate counts strictly-positive PnL as wins', () => {
    const trades = [trade(100), trade(0), trade(-50)]; // 1 win / 3 = 33.33%
    const m = summariseIteration(10, trades, 10_000, 10_050, emptyDiag);
    expect(m.winRate).toBeCloseTo(33.33, 1);
  });

  it('totalPnlPct is denominated against startingBalance, not final', () => {
    const trades = [trade(500), trade(500)];
    const m = summariseIteration(10, trades, 10_000, 11_000, emptyDiag);
    expect(m.totalPnlPct).toBeCloseTo(10, 2);
  });

  it('maxDrawdown reflects intra-trade troughs (uses maxAdverse)', () => {
    // One trade that drew down $1000 mid-trade but closed at +$50. Without
    // intra-trade awareness MDD would be 0%; with it, MDD = 10%.
    const t = trade(50, { maxAdverse: 1000 });
    const m = summariseIteration(10, [t], 10_000, 10_050, emptyDiag);
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(9.9);
  });

  it('forceClosedPct flags ≥20% as a warning', () => {
    const trades = [
      trade(50, { forceClosed: true }),
      trade(50, { forceClosed: true }),
      trade(50, { forceClosed: false }),
      trade(50, { forceClosed: false }),
      trade(50, { forceClosed: false }),
    ];
    const m = summariseIteration(10, trades, 10_000, 10_250, emptyDiag);
    expect(m.forceClosedPct).toBeCloseTo(40, 1);
    expect(m.warnings.some(w => w.includes('40% force-closed'))).toBe(true);
  });

  it('propagates challenge status when present in diagnostics', () => {
    const diag: RunDiagnostics = {
      ...emptyDiag,
      challengeResult: {
        enabled: true,
        status: 'FAILED',
        breachedRule: 'DAILY_LOSS',
        tradingDaysCount: 3,
        highWaterMark: 10_100,
        lowestEquity: 9_300,
        maxDailyLossPct: 7,
        maxDrawdownFromHWMPct: 8,
      },
    };
    const m = summariseIteration(10, [trade(-100)], 10_000, 9_900, diag);
    expect(m.challengeStatus).toBe('FAILED');
    expect(m.breachedRule).toBe('DAILY_LOSS');
  });

  it('rounds metrics to 2/3 decimal places to keep result JSON compact', () => {
    const trades = [trade(123.456789), trade(-87.654321)];
    const m = summariseIteration(10, trades, 10_000, 10_036, emptyDiag);
    // No 6+ decimal artifacts in the persisted form.
    const formatted = JSON.stringify(m);
    expect(formatted).not.toMatch(/\.\d{6}/);
  });
});
