import { describe, it, expect } from 'vitest';
import {
  computeReplayWindow,
  pickDefaultTimeframe,
  toReplayCandle,
} from '../tradeReplayService';

describe('computeReplayWindow', () => {
  it('pads 30 H1 bars on both sides of a CLOSED trade by default', () => {
    const w = computeReplayWindow({
      entryAt: new Date('2026-05-13T10:00:00Z'),
      exitAt: new Date('2026-05-13T14:00:00Z'),
      timeframe: 'H1',
    });
    // 30 bars * 60 min = 1800 min = 30 hours of padding each side.
    expect(w.from.toISOString()).toBe('2026-05-12T04:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-05-14T20:00:00.000Z');
  });

  it('respects a custom contextBars setting', () => {
    const w = computeReplayWindow({
      entryAt: new Date('2026-05-13T10:00:00Z'),
      exitAt: new Date('2026-05-13T11:00:00Z'),
      timeframe: 'M15',
      contextBars: 20,
    });
    // 20 bars * 15 min = 300 min = 5 hours of padding each side.
    expect(w.from.toISOString()).toBe('2026-05-13T05:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-05-13T16:00:00.000Z');
  });

  it('extends the window to "now" when the trade is still OPEN', () => {
    const now = new Date('2026-05-13T20:00:00Z');
    const w = computeReplayWindow({
      entryAt: new Date('2026-05-13T10:00:00Z'),
      exitAt: null,
      timeframe: 'H1',
      now,
    });
    // Exit ms used = max(now, entry + 30h padding) = 2026-05-14T16:00 (entry+30h)
    // since now (20:00) is earlier than entry+30h. Then +30h padding for the
    // right edge gives 2026-05-15T22:00.
    expect(w.from.toISOString()).toBe('2026-05-12T04:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-05-15T22:00:00.000Z');
  });

  it('does not collapse the window when a freshly-opened trade has exitAt=null', () => {
    // Without the min-span guard, a trade opened 5 minutes ago would render
    // as a single candle at the right edge — uninformative for replay.
    const now = new Date('2026-05-13T10:05:00Z');
    const w = computeReplayWindow({
      entryAt: new Date('2026-05-13T10:00:00Z'),
      exitAt: null,
      timeframe: 'H1',
      now,
    });
    // (to - from) should be at least 2 * padding = 60h.
    expect(w.to.getTime() - w.from.getTime()).toBeGreaterThanOrEqual(60 * 60 * 60 * 1000);
  });

  it('rejects unsupported timeframes', () => {
    expect(() =>
      computeReplayWindow({
        entryAt: new Date(),
        exitAt: null,
        timeframe: 'M5',
      }),
    ).toThrow(/timeframe/i);
  });
});

describe('pickDefaultTimeframe', () => {
  it('uses M15 for scalps under 4 hours', () => {
    expect(pickDefaultTimeframe(30 * 60 * 1000)).toBe('M15'); // 30 min
    expect(pickDefaultTimeframe(3 * 60 * 60 * 1000)).toBe('M15'); // 3 h
  });

  it('uses H1 for intraday-to-swing trades', () => {
    expect(pickDefaultTimeframe(5 * 60 * 60 * 1000)).toBe('H1');
    expect(pickDefaultTimeframe(48 * 60 * 60 * 1000)).toBe('H1');
  });

  it('uses D1 for multi-week holds', () => {
    expect(pickDefaultTimeframe(30 * 24 * 60 * 60 * 1000)).toBe('D1');
  });
});

describe('toReplayCandle', () => {
  it('converts ISO timestamps to unix seconds for lightweight-charts', () => {
    const c = toReplayCandle({
      time: '2026-05-13T10:00:00Z',
      open: 1.1,
      high: 1.11,
      low: 1.09,
      close: 1.105,
      volume: 1234,
    });
    expect(c.time).toBe(Math.floor(new Date('2026-05-13T10:00:00Z').getTime() / 1000));
    expect(c.open).toBe(1.1);
    expect(c.volume).toBe(1234);
  });

  it('preserves a null volume (Yahoo returns null for some forex candles)', () => {
    const c = toReplayCandle({
      time: new Date('2026-05-13T10:00:00Z'),
      open: 1.1,
      high: 1.11,
      low: 1.09,
      close: 1.105,
      volume: null,
    });
    expect(c.volume).toBeNull();
  });
});
