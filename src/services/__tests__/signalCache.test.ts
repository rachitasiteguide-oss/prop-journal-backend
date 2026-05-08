import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedSignals, setCachedSignals, signalCacheStats, clearSignalCache,
} from '../signalCache';

const baseKey = {
  symbol:         'EURUSD',
  timeframe:      'D1',
  startMs:        1_700_000_000_000,
  endMs:          1_705_000_000_000,
  candleCount:    100,
  strategyType:   'MA_CROSS',
  strategyConfig: { fastPeriod: 10, slowPeriod: 30, maType: 'EMA' as const },
};

beforeEach(() => {
  // Force real timers — defends against fake-timer state bleeding from a
  // previous test that forgot to restore them.
  vi.useRealTimers();
  clearSignalCache();
});

describe('signalCache', () => {
  it('returns null on miss and increments miss counter', () => {
    expect(getCachedSignals(baseKey)).toBeNull();
    expect(signalCacheStats().misses).toBe(1);
    expect(signalCacheStats().hits).toBe(0);
  });

  it('returns the same array on hit and increments hit counter', () => {
    const signals = ['BUY', null, 'SELL', null] as ('BUY' | 'SELL' | null)[];
    setCachedSignals(baseKey, signals);
    expect(getCachedSignals(baseKey)).toEqual(signals);
    expect(signalCacheStats().hits).toBe(1);
  });

  it('treats different strategyConfig as different keys', () => {
    setCachedSignals(baseKey, ['BUY']);
    const altered = { ...baseKey, strategyConfig: { ...baseKey.strategyConfig, fastPeriod: 11 } };
    expect(getCachedSignals(altered)).toBeNull();
  });

  it('treats different date ranges as different keys', () => {
    setCachedSignals(baseKey, ['BUY']);
    const altered = { ...baseKey, endMs: baseKey.endMs + 86_400_000 };
    expect(getCachedSignals(altered)).toBeNull();
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    setCachedSignals(baseKey, ['BUY']);
    expect(getCachedSignals(baseKey)).toEqual(['BUY']);
    // TTL is 1 hour; jump 61 minutes ahead.
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(getCachedSignals(baseKey)).toBeNull();
    vi.useRealTimers();
  });

  it('evicts the oldest entry when at capacity', () => {
    // Fill to capacity (256). The first inserted (cc=0) is now oldest.
    for (let i = 0; i < 256; i++) {
      setCachedSignals({ ...baseKey, candleCount: i }, ['BUY']);
    }
    // All originals still present.
    expect(getCachedSignals({ ...baseKey, candleCount: 0 })).toEqual(['BUY']);
    // The get above just touched cc=0 — it now sits at the most-recent
    // slot and cc=1 is the new oldest. Add up to 255 fresh items so
    // exactly one round of eviction sweeps cc=1 but never reaches cc=0.
    for (let i = 256; i < 256 + 255; i++) {
      setCachedSignals({ ...baseKey, candleCount: i }, ['BUY']);
    }
    expect(getCachedSignals({ ...baseKey, candleCount: 0 })).toEqual(['BUY']);   // still there (touched)
    expect(getCachedSignals({ ...baseKey, candleCount: 1 })).toBeNull();          // evicted (was new oldest)
  });
});
