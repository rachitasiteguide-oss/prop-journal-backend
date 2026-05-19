import { describe, it, expect } from 'vitest';
import {
  netPnl,
  dayKey,
  computeEquityCurve,
  computeDailyHeatmap,
  type TradeForAnalytics,
} from '../analyticsService';

function trade(p: Partial<TradeForAnalytics>): TradeForAnalytics {
  return {
    status: 'CLOSED',
    pnl: 0,
    commission: 0,
    swap: 0,
    entryAt: '2024-03-01T10:00:00.000Z',
    exitAt: '2024-03-01T12:00:00.000Z',
    ...p,
  };
}

describe('netPnl', () => {
  it('subtracts commission and swap from gross pnl', () => {
    expect(netPnl(trade({ pnl: 100, commission: 7, swap: 3 }))).toBe(90);
  });
  it('treats nulls as zero', () => {
    expect(netPnl(trade({ pnl: null, commission: null, swap: null }))).toBe(0);
  });
});

describe('dayKey', () => {
  it('uses UTC when no timezone is given', () => {
    expect(dayKey('2024-03-01T23:30:00.000Z')).toBe('2024-03-01');
  });
  it('shifts the day boundary into the requested timezone', () => {
    // 23:30 UTC is already 19:30 the same day in New York (UTC-4 in March DST)
    expect(dayKey('2024-03-10T23:30:00.000Z', 'America/New_York')).toBe('2024-03-10');
    // 02:30 UTC is the previous evening (21:30) in New York
    expect(dayKey('2024-03-11T02:30:00.000Z', 'America/New_York')).toBe('2024-03-10');
  });
});

describe('computeEquityCurve', () => {
  it('returns an empty curve for no trades', () => {
    const c = computeEquityCurve([], 1000);
    expect(c.points).toEqual([]);
    expect(c.summary.tradingDays).toBe(0);
    expect(c.summary.finalEquity).toBe(1000);
  });

  it('ignores open trades', () => {
    const c = computeEquityCurve(
      [trade({ status: 'OPEN', pnl: 999 }), trade({ pnl: 50 })],
      0,
    );
    expect(c.summary.netPnL).toBe(50);
  });

  it('accumulates net P&L per day and tracks drawdown from the peak', () => {
    const c = computeEquityCurve(
      [
        trade({ pnl: 100, exitAt: '2024-03-01T12:00:00.000Z' }),
        trade({ pnl: 50, exitAt: '2024-03-02T12:00:00.000Z' }),
        trade({ pnl: -80, exitAt: '2024-03-03T12:00:00.000Z' }),
      ],
      1000,
    );
    expect(c.points.map((p) => p.equity)).toEqual([1100, 1150, 1070]);
    expect(c.points[2].drawdown).toBe(80); // peak 1150 -> 1070
    expect(c.summary.maxDrawdown).toBe(80);
    expect(c.summary.finalEquity).toBe(1070);
    expect(c.summary.tradingDays).toBe(3);
  });

  it('groups multiple trades on the same day into one point', () => {
    const c = computeEquityCurve(
      [
        trade({ pnl: 30, exitAt: '2024-03-01T09:00:00.000Z' }),
        trade({ pnl: -10, exitAt: '2024-03-01T15:00:00.000Z' }),
      ],
      0,
    );
    expect(c.points).toHaveLength(1);
    expect(c.points[0].pnl).toBe(20);
  });
});

describe('computeDailyHeatmap', () => {
  it('returns only days with closed trades, sorted ascending', () => {
    const days = computeDailyHeatmap([
      trade({ pnl: 40, exitAt: '2024-03-02T12:00:00.000Z' }),
      trade({ pnl: -15, exitAt: '2024-03-01T12:00:00.000Z' }),
      trade({ pnl: 5, exitAt: '2024-03-01T18:00:00.000Z' }),
      trade({ status: 'OPEN', pnl: 1000, exitAt: null }),
    ]);
    expect(days).toEqual([
      { date: '2024-03-01', pnl: -10, tradeCount: 2 },
      { date: '2024-03-02', pnl: 40, tradeCount: 1 },
    ]);
  });

  it('respects the timezone for day bucketing', () => {
    const days = computeDailyHeatmap(
      [trade({ pnl: 10, exitAt: '2024-03-11T02:30:00.000Z' })],
      'America/New_York',
    );
    expect(days[0].date).toBe('2024-03-10');
  });
});
