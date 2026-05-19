// Unit tests for walk-forward helpers. The full orchestrator is covered
// implicitly by every existing engine test plus the integration assertion
// below; we focus here on the two pieces of logic unique to WF: picking the
// IS-best parameter and computing the cross-window aggregate.

import { describe, it, expect } from 'vitest';
import {
  pickBest,
  assessSelection,
  computeAggregate,
  type WindowResult,
} from '../walkForwardService';
import type { SweepIterationMetrics } from '../sweepService';

function row(opts: Partial<SweepIterationMetrics> & { paramValue: number }): SweepIterationMetrics {
  return {
    paramValue:      opts.paramValue,
    tradeCount:      opts.tradeCount      ?? 10,
    totalPnl:        opts.totalPnl        ?? 0,
    totalPnlPct:     opts.totalPnlPct     ?? 0,
    winRate:         opts.winRate         ?? 0,
    profitFactor:    opts.profitFactor    ?? 0,
    sharpe:          opts.sharpe          ?? 0,
    maxDrawdown:     opts.maxDrawdown     ?? 0,
    forceClosedPct:  opts.forceClosedPct  ?? 0,
    finalBalance:    opts.finalBalance    ?? 10_000,
    warnings:        opts.warnings        ?? [],
  };
}

describe('pickBest', () => {
  it('picks param with highest Sharpe', () => {
    const r = [
      row({ paramValue: 5,  sharpe: 0.1 }),
      row({ paramValue: 10, sharpe: 0.5 }),
      row({ paramValue: 15, sharpe: 0.3 }),
    ];
    expect(pickBest(r, 'sharpe')).toBe(10);
  });

  it('picks param with highest totalPnl', () => {
    const r = [
      row({ paramValue: 5,  totalPnl:  100 }),
      row({ paramValue: 10, totalPnl: -200 }),
      row({ paramValue: 15, totalPnl:  500 }),
    ];
    expect(pickBest(r, 'totalPnl')).toBe(15);
  });

  it('picks param with highest profitFactor', () => {
    const r = [
      row({ paramValue: 5,  profitFactor: 1.2 }),
      row({ paramValue: 10, profitFactor: 2.5 }),
      row({ paramValue: 15, profitFactor: 0.8 }),
    ];
    expect(pickBest(r, 'profitFactor')).toBe(10);
  });

  it('excludes zero-trade rows from selection', () => {
    // Param 5 has the highest Sharpe but zero trades — should be ignored.
    const r = [
      row({ paramValue: 5,  sharpe: 99,  tradeCount: 0 }),
      row({ paramValue: 10, sharpe: 0.3, tradeCount: 12 }),
      row({ paramValue: 15, sharpe: 0.1, tradeCount: 8  }),
    ];
    expect(pickBest(r, 'sharpe')).toBe(10);
  });

  it('falls back to first param when all rows have zero trades', () => {
    const r = [
      row({ paramValue: 5,  tradeCount: 0 }),
      row({ paramValue: 10, tradeCount: 0 }),
    ];
    expect(pickBest(r, 'sharpe')).toBe(5);
  });
});

describe('assessSelection (SR9 — flags arbitrary IS-best fallbacks)', () => {
  it('flags windows where no parameter produced any IS trades', () => {
    const r = [row({ paramValue: 15, tradeCount: 0 }), row({ paramValue: 23, tradeCount: 0 })];
    const a = assessSelection(r, 'sharpe', pickBest(r, 'sharpe'));
    expect(a.reliable).toBe(false);
    expect(a.eligibleCount).toBe(0);
    expect(a.reason).toMatch(/no parameter produced any in-sample trades/i);
  });

  it('flags an all-tie sweep (every traded param has Sharpe 0) as not metric-driven', () => {
    const r = [
      row({ paramValue: 15, tradeCount: 3, sharpe: 0 }),
      row({ paramValue: 23, tradeCount: 4, sharpe: 0 }),
    ];
    const a = assessSelection(r, 'sharpe', pickBest(r, 'sharpe'));
    expect(a.reliable).toBe(false);
    expect(a.reason).toMatch(/tie on sharpe/i);
  });

  it('flags a winner chosen on too few (<5) in-sample trades', () => {
    const r = [
      row({ paramValue: 15, tradeCount: 1, sharpe: 0.9 }),
      row({ paramValue: 23, tradeCount: 8, sharpe: 0.1 }),
    ];
    // Sharpe picks param 15 (1 trade) — meaningful metric spread but tiny sample.
    const a = assessSelection(r, 'sharpe', pickBest(r, 'sharpe'));
    expect(a.reliable).toBe(false);
    expect(a.bestTradeCount).toBe(1);
    expect(a.reason).toMatch(/only 1 in-sample trade .*<5/i);
  });

  it('marks a genuine metric-driven optimum on a sufficient sample as reliable', () => {
    const r = [
      row({ paramValue: 15, tradeCount: 12, sharpe: 0.2 }),
      row({ paramValue: 23, tradeCount: 9,  sharpe: 0.8 }),
    ];
    const a = assessSelection(r, 'sharpe', pickBest(r, 'sharpe'));
    expect(a.reliable).toBe(true);
    expect(a.reason).toBeNull();
    expect(a.bestTradeCount).toBe(9);
  });
});

// ── Aggregate stats ──────────────────────────────────────────────────────────

function makeWindow(
  idx: number,
  isBest: { param: number; sharpe: number; pnl: number },
  oos:    { sharpe: number; pnl: number },
): WindowResult {
  return {
    windowIndex:  idx,
    isStartDate:  '2024-01-01T00:00:00Z',
    isEndDate:    '2024-02-01T00:00:00Z',
    oosStartDate: '2024-02-01T00:00:00Z',
    oosEndDate:   '2024-03-01T00:00:00Z',
    isResults:    [row({ paramValue: isBest.param, sharpe: isBest.sharpe, totalPnl: isBest.pnl, tradeCount: 10 })],
    isBestParam:  isBest.param,
    oosMetrics:   row({ paramValue: isBest.param, sharpe: oos.sharpe, totalPnl: oos.pnl, tradeCount: 5 }),
  };
}

describe('computeAggregate', () => {
  it('empty windows returns zeros', () => {
    const a = computeAggregate([]);
    expect(a.avgIsSharpe).toBe(0);
    expect(a.avgOosSharpe).toBe(0);
    expect(a.overfitWarning).toBe(false);
  });

  it('strategy with consistent OOS edge has high consistency and low decay', () => {
    // 4 windows, each IS Sharpe 1.0 / OOS Sharpe 0.9. Decay ≈ 0.9.
    const windows: WindowResult[] = [
      makeWindow(0, { param: 10, sharpe: 1.0, pnl: 100 }, { sharpe: 0.9, pnl: 90 }),
      makeWindow(1, { param: 10, sharpe: 1.0, pnl: 100 }, { sharpe: 0.9, pnl: 90 }),
      makeWindow(2, { param: 10, sharpe: 1.0, pnl: 100 }, { sharpe: 0.9, pnl: 90 }),
      makeWindow(3, { param: 10, sharpe: 1.0, pnl: 100 }, { sharpe: 0.9, pnl: 90 }),
    ];
    const a = computeAggregate(windows);
    expect(a.avgIsSharpe).toBeCloseTo(1.0, 2);
    expect(a.avgOosSharpe).toBeCloseTo(0.9, 2);
    expect(a.decayRatio).toBeCloseTo(0.9, 2);
    expect(a.consistencyScore).toBeCloseTo(1.0, 2);
    expect(a.oosWinRate).toBeCloseTo(1.0, 2);
    expect(a.overfitWarning).toBe(false);
  });

  it('overfit strategy: positive IS, negative OOS → overfit flag fires', () => {
    const windows: WindowResult[] = [
      makeWindow(0, { param: 10, sharpe: 1.5, pnl: 100 }, { sharpe: -0.2, pnl: -50 }),
      makeWindow(1, { param: 10, sharpe: 1.5, pnl: 100 }, { sharpe: -0.5, pnl: -80 }),
      makeWindow(2, { param: 10, sharpe: 1.5, pnl: 100 }, { sharpe: -0.1, pnl: -10 }),
    ];
    const a = computeAggregate(windows);
    expect(a.avgIsSharpe).toBeGreaterThan(0.1);
    expect(a.avgOosSharpe).toBeLessThan(0);
    expect(a.decayRatio).toBe(0); // clamped — negative OOS means edge collapsed
    expect(a.consistencyScore).toBe(0);
    expect(a.overfitWarning).toBe(true);
  });

  it('decayRatio = 0 when IS Sharpe is non-positive', () => {
    const windows: WindowResult[] = [
      makeWindow(0, { param: 10, sharpe: -0.1, pnl: -50 }, { sharpe: 0.2, pnl: 10 }),
    ];
    const a = computeAggregate(windows);
    expect(a.decayRatio).toBe(0);
    expect(a.overfitWarning).toBe(false);  // can't overfit if you have no IS edge to begin with
  });

  it('oosWinRate counts strictly-positive OOS PnL', () => {
    const windows: WindowResult[] = [
      makeWindow(0, { param: 10, sharpe: 1, pnl: 100 }, { sharpe: 0.5, pnl:  50 }),
      makeWindow(1, { param: 10, sharpe: 1, pnl: 100 }, { sharpe: 0,   pnl:   0 }),
      makeWindow(2, { param: 10, sharpe: 1, pnl: 100 }, { sharpe: -1,  pnl: -50 }),
      makeWindow(3, { param: 10, sharpe: 1, pnl: 100 }, { sharpe: 0.2, pnl:  10 }),
    ];
    const a = computeAggregate(windows);
    expect(a.oosWinRate).toBeCloseTo(0.5, 2); // 2 of 4 windows positive
  });

  it('aggregate uses IS-best row, not average across all params', () => {
    // Two paramValues in IS results — aggregate should pick the IS-best's
    // Sharpe (10), not average of (10 and -5).
    const w: WindowResult = {
      windowIndex:  0,
      isStartDate:  '2024-01-01T00:00:00Z',
      isEndDate:    '2024-02-01T00:00:00Z',
      oosStartDate: '2024-02-01T00:00:00Z',
      oosEndDate:   '2024-03-01T00:00:00Z',
      isResults: [
        row({ paramValue: 5,  sharpe: -5, totalPnl: -100 }),
        row({ paramValue: 10, sharpe: 10, totalPnl: 1000 }),
      ],
      isBestParam: 10,
      oosMetrics:  row({ paramValue: 10, sharpe: 5, totalPnl: 500 }),
    };
    const a = computeAggregate([w]);
    expect(a.avgIsSharpe).toBeCloseTo(10, 2);
  });
});
