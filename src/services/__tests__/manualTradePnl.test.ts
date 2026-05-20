// Regression tests for the manual-trade P&L fix.
//
// Manual trades (addTrade/updateTrade/bulkAddTrades in backtestService) used
// to compute P&L with a hand-rolled `priceDiff * volume * 100000 * 10 / 100000`
// (= ×10) that ignored session.instrumentType, so a FOREX SELL of 0.1 lot
// rounded to $0.00. They now delegate to the engine's instrument-aware
// calcRawPnl — the single source of truth. These cases pin the exact
// QA-reported scenarios plus the instrument matrix and SELL sign.

import { describe, it, expect } from 'vitest';
import { calcRawPnl, getContractMultiplier } from '../backtestEngineCore';

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

describe('symbol-aware multiplier — non-FX instruments under the FOREX tab', () => {
  it('QA bug row62: XAU/USD BUY 3385 → 3392 @ 0.01 lot = ~+$7, NOT +$7000', () => {
    // Tester reported +$7000 (1000x inflation) because the wizard hardcodes
    // instrumentType:'FOREX' and the engine applied the FX 100,000x multiplier
    // to gold. Gold's contract is 100 oz/lot, so 7 points × 0.01 × 100 = $7.
    const pnl = calcRawPnl('BUY', 3385, 3392, 0.01, 'FOREX', 'XAU/USD');
    expect(r2(pnl)).toBe(7);
  });

  it('XAG/USD uses 5000 contract size', () => {
    // 1 point × 0.1 lot × 5000 = $500
    expect(calcRawPnl('BUY', 30.00, 31.00, 0.1, 'FOREX', 'XAG/USD')).toBeCloseTo(500, 6);
  });

  it('FX majors are unaffected by symbol override (still ×100,000)', () => {
    expect(calcRawPnl('BUY', 1.0850, 1.0860, 0.1, 'FOREX', 'EUR/USD')).toBeCloseTo(10, 6);
    expect(calcRawPnl('BUY', 1.0850, 1.0860, 0.1, 'FOREX', 'GBP/USD')).toBeCloseTo(10, 6);
  });

  it('getContractMultiplier accepts symbol in multiple shapes', () => {
    expect(getContractMultiplier('XAU/USD',  'FOREX')).toBe(100);
    expect(getContractMultiplier('XAUUSD',   'FOREX')).toBe(100);
    expect(getContractMultiplier('XAU-USD',  'FOREX')).toBe(100);
    expect(getContractMultiplier('XAUUSD=X', 'FOREX')).toBe(100);
    expect(getContractMultiplier('xauusd',   'FOREX')).toBe(100);
    expect(getContractMultiplier('EUR/USD',  'FOREX')).toBe(100_000);
    expect(getContractMultiplier(null,       'FOREX')).toBe(100_000);
    expect(getContractMultiplier('AAPL',     'STOCKS')).toBe(1);
  });
});
