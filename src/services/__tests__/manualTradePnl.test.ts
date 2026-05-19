// Regression tests for the manual-trade P&L fix.
//
// Manual trades (addTrade/updateTrade/bulkAddTrades in backtestService) used
// to compute P&L with a hand-rolled `priceDiff * volume * 100000 * 10 / 100000`
// (= ×10) that ignored session.instrumentType, so a FOREX SELL of 0.1 lot
// rounded to $0.00. They now delegate to the engine's instrument-aware
// calcRawPnl — the single source of truth. These cases pin the exact
// QA-reported scenarios plus the instrument matrix and SELL sign.

import { describe, it, expect } from 'vitest';
import { calcRawPnl } from '../backtestEngineCore';

const r2 = (n: number) => parseFloat(n.toFixed(2));

describe('calcRawPnl — manual-trade P&L', () => {
  it('QA bug: FOREX SELL 1.093 → 1.088, 0.1 lot is a profit, not $0.00', () => {
    const pnl = calcRawPnl('SELL', 1.093, 1.088, 0.1, 'FOREX');
    expect(r2(pnl)).toBe(50); // 0.005 × 0.1 × 100000, in quote currency
    expect(pnl).toBeGreaterThan(0);
  });

  it('QA bug: FOREX BUY 1.085 → 1.092, 0.1 lot is +70, not +$0.01', () => {
    expect(r2(calcRawPnl('BUY', 1.085, 1.092, 0.1, 'FOREX'))).toBe(70);
  });

  it('SELL sign: profits when price falls, loses when price rises', () => {
    expect(calcRawPnl('SELL', 1.10, 1.09, 1, 'FOREX')).toBeGreaterThan(0);
    expect(calcRawPnl('SELL', 1.10, 1.11, 1, 'FOREX')).toBeLessThan(0);
  });

  it('BUY sign: profits when price rises, loses when price falls', () => {
    expect(calcRawPnl('BUY', 1.10, 1.11, 1, 'FOREX')).toBeGreaterThan(0);
    expect(calcRawPnl('BUY', 1.10, 1.09, 1, 'FOREX')).toBeLessThan(0);
  });

  it('instrument matrix: FOREX uses ×100000, others use ×1', () => {
    expect(calcRawPnl('BUY', 1.1000, 1.1010, 1, 'FOREX')).toBeCloseTo(100, 6);
    expect(calcRawPnl('BUY', 100, 105, 10, 'STOCKS')).toBeCloseTo(50, 6);
    expect(calcRawPnl('BUY', 100, 105, 10, 'FUTURES')).toBeCloseTo(50, 6);
    expect(calcRawPnl('BUY', 20000, 21000, 0.5, 'CRYPTO')).toBeCloseTo(500, 6);
    expect(calcRawPnl('BUY', 100, 105, 10, 'CFD')).toBeCloseTo(50, 6);
  });

  it('edge: break-even exit (exit == entry) is 0 (±0)', () => {
    expect(calcRawPnl('BUY', 1.1, 1.1, 1, 'FOREX')).toBeCloseTo(0, 10);
    expect(calcRawPnl('SELL', 1.1, 1.1, 1, 'FOREX')).toBeCloseTo(0, 10);
  });

  it('edge: unknown instrumentType throws instead of silently mis-scaling', () => {
    expect(() => calcRawPnl('BUY', 1, 2, 1, 'STOCK')).toThrow(/Unsupported instrumentType/);
  });
});
