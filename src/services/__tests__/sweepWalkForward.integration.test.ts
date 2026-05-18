// Integration tests for the sweep + walk-forward ORCHESTRATORS.
//
// The pure helpers (pickBest, computeAggregate, summariseIteration) are
// unit-tested elsewhere. This file exercises the fire-and-forget pipelines
// end-to-end with a real engine (runEngineInline runs for real — only Prisma
// and the Yahoo fetch are mocked):
//   createSweep        → runSweep        → per-value engine runs → persisted results
//   createWalkForward  → runWalkForward  → window slicing → IS sweep → OOS validation → aggregate
//
// Prisma is mocked with a tiny in-memory store so we can read back exactly
// what the orchestrator persisted. getCandles returns a deterministic
// oscillating series so MA_CROSS genuinely produces different trades for
// different fastPeriod values (otherwise a sweep would be a no-op test).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory store ──────────────────────────────────────────────────────────

interface Store {
  session: Record<string, unknown> | null;
  sweeps:  Map<string, Record<string, unknown>>;
  wfs:     Map<string, Record<string, unknown>>;
  seq:     number;
}
const store: Store = { session: null, sweeps: new Map(), wfs: new Map(), seq: 0 };

vi.mock('../../config/db', () => ({
  prisma: {
    backtestSession: {
      findFirst:  vi.fn(async () => store.session),
      findUnique: vi.fn(async () => store.session),
    },
    backtestSweep: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `sweep${++store.seq}`;
        const row = { id, results: null, runError: null, startedAt: null, completedAt: null, createdAt: new Date(), ...data };
        store.sweeps.set(id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.sweeps.get(where.id) ?? null),
      findFirst:  vi.fn(async ({ where }: { where: { id: string } }) => store.sweeps.get(where.id) ?? null),
      findMany:   vi.fn(async () => [...store.sweeps.values()]),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.sweeps.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    backtestWalkForward: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `wf${++store.seq}`;
        const row = { id, results: null, aggregate: null, runError: null, startedAt: null, completedAt: null, createdAt: new Date(), ...data };
        store.wfs.set(id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.wfs.get(where.id) ?? null),
      findFirst:  vi.fn(async ({ where }: { where: { id: string } }) => store.wfs.get(where.id) ?? null),
      findMany:   vi.fn(async () => [...store.wfs.values()]),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.wfs.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  },
}));

vi.mock('../candleService', () => ({ getCandles: vi.fn() }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getCandles } from '../candleService';
import { clearSignalCache } from '../signalCache';
import { createSweep, getSweep } from '../sweepService';
import { createWalkForward, getWalkForward } from '../walkForwardService';

// ── Synthetic candles ────────────────────────────────────────────────────────
// Oscillating series → repeated SMA crossovers. Different fastPeriods produce
// genuinely different signal sets, so the sweep is a meaningful test.

function oscillatingCandles(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const price = 100 + 18 * Math.sin(i / 6) + 4 * Math.sin(i / 2.3);
    return {
      id: `c${i}`, symbol: 'TEST', timeframe: 'D1',
      openTime: new Date(Date.UTC(2022, 0, 1) + i * 86_400_000),
      open: price,
      high: price * 1.01,
      low:  price * 0.99,
      close: price,
      volume: 1000,
    };
  });
}

const SESSION = {
  id: 'sess1', userId: 'u1', symbol: 'TEST', instrumentType: 'STOCKS',
  timeframe: 'D1', mode: 'AUTO',
  startDate: new Date('2022-01-01'), endDate: new Date('2022-12-31'),
  startingBalance: 10_000,
};

const BASE_CONFIG = {
  strategyType:   'MA_CROSS',
  strategyConfig: { fastPeriod: 3, slowPeriod: 8, maType: 'SMA' },
  volume:         100,
  stopLossPct:    0.05,
  takeProfitRatio: 2,
  slippagePct:    0,
  commission:     0,
  maxOpenPositions: 1,
};

async function waitFor(get: () => string | undefined, want: string[], timeoutMs = 8000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = get();
    if (s && want.includes(s)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout; last status=${s}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSignalCache();
  store.session = { ...SESSION };
  store.sweeps.clear();
  store.wfs.clear();
  store.seq = 0;
  vi.mocked(getCandles).mockResolvedValue(oscillatingCandles(180) as never);
});

// ── Sweep orchestration ──────────────────────────────────────────────────────

describe('createSweep → runSweep (integration)', () => {
  it('runs every axis value and persists a result row per value', async () => {
    const created = await createSweep('u1', 'sess1', {
      axis:       { paramKey: 'fastPeriod', values: [2, 3, 5, 8] },
      baseConfig: BASE_CONFIG,
    });
    expect(created.status).toBe('PENDING');

    await waitFor(() => store.sweeps.get(created.id)?.status as string, ['COMPLETED', 'FAILED']);

    const done = await getSweep('u1', created.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.progress).toBe(100);
    expect(done.results).toHaveLength(4);

    const params = done.results!.map(r => r.paramValue).sort((a, b) => a - b);
    expect(params).toEqual([2, 3, 5, 8]);

    for (const r of done.results!) {
      expect(Number.isFinite(r.totalPnl)).toBe(true);
      expect(Number.isFinite(r.sharpe)).toBe(true);
      expect(r.finalBalance).toBeGreaterThan(0);
      expect(r.tradeCount).toBeGreaterThanOrEqual(0);
    }
    // Different fastPeriods must not all be identical — proves the axis param
    // is actually threaded into the engine config.
    const distinctTradeCounts = new Set(done.results!.map(r => r.tradeCount));
    expect(distinctTradeCounts.size).toBeGreaterThan(1);
  });

  it('one failing iteration does not abort the sweep', async () => {
    // fastPeriod 0 is invalid for SMA → that iteration records a warning row,
    // the rest still complete.
    const created = await createSweep('u1', 'sess1', {
      axis:       { paramKey: 'fastPeriod', values: [0, 3, 5] },
      baseConfig: BASE_CONFIG,
    });
    await waitFor(() => store.sweeps.get(created.id)?.status as string, ['COMPLETED', 'FAILED']);
    const done = await getSweep('u1', created.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.results).toHaveLength(3);
  });

  it('rejects sweep on a non-AUTO session', async () => {
    store.session = { ...SESSION, mode: 'MANUAL' };
    await expect(createSweep('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [2, 3] }, baseConfig: BASE_CONFIG,
    })).rejects.toThrow(/AUTO/);
  });

  it('rejects an over-long axis (>50 values)', async () => {
    await expect(createSweep('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: Array.from({ length: 51 }, (_, i) => i + 1) },
      baseConfig: BASE_CONFIG,
    })).rejects.toThrow(/50/);
  });

  it('marks FAILED when the candle fetch throws', async () => {
    vi.mocked(getCandles).mockRejectedValueOnce(new Error('yahoo 502'));
    const created = await createSweep('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [2, 3] }, baseConfig: BASE_CONFIG,
    });
    await waitFor(() => store.sweeps.get(created.id)?.status as string, ['COMPLETED', 'FAILED']);
    const done = await getSweep('u1', created.id);
    expect(done.status).toBe('FAILED');
    expect(done.runError).toMatch(/yahoo 502/);
  });
});

// ── Walk-forward orchestration ───────────────────────────────────────────────

describe('createWalkForward → runWalkForward (integration)', () => {
  it('produces one window result per window with IS sweep + OOS validation + aggregate', async () => {
    const created = await createWalkForward('u1', 'sess1', {
      axis:          { paramKey: 'fastPeriod', values: [2, 3, 5] },
      baseConfig:    BASE_CONFIG,
      windowsConfig: { windows: 3, isRatio: 0.6, selectionMetric: 'sharpe' },
    });
    expect(created.status).toBe('PENDING');

    await waitFor(() => store.wfs.get(created.id)?.status as string, ['COMPLETED', 'FAILED']);

    const done = await getWalkForward('u1', created.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.progress).toBe(100);
    expect(done.results).toHaveLength(3);

    for (const w of done.results!) {
      // Every axis value evaluated on IS.
      expect(w.isResults).toHaveLength(3);
      // IS-best must be one of the axis values.
      expect([2, 3, 5]).toContain(w.isBestParam);
      // OOS metrics carry the IS-best param.
      expect(w.oosMetrics.paramValue).toBe(w.isBestParam);
      // Windows are chronological and non-overlapping.
      expect(new Date(w.isStartDate).getTime()).toBeLessThan(new Date(w.isEndDate).getTime());
      expect(new Date(w.isEndDate).getTime()).toBeLessThanOrEqual(new Date(w.oosStartDate).getTime());
      expect(new Date(w.oosStartDate).getTime()).toBeLessThan(new Date(w.oosEndDate).getTime());
    }

    // Windows progress forward in time.
    const w0End = new Date(done.results![0].oosEndDate).getTime();
    const w1Start = new Date(done.results![1].isStartDate).getTime();
    expect(w1Start).toBeGreaterThanOrEqual(w0End - 86_400_000); // allow boundary bar

    expect(done.aggregate).not.toBeNull();
    const a = done.aggregate!;
    for (const k of ['avgIsSharpe', 'avgOosSharpe', 'decayRatio', 'oosWinRate', 'consistencyScore'] as const) {
      expect(Number.isFinite(a[k])).toBe(true);
    }
    expect(typeof a.overfitWarning).toBe('boolean');
    expect(a.oosWinRate).toBeGreaterThanOrEqual(0);
    expect(a.oosWinRate).toBeLessThanOrEqual(1);
  });

  it('rejects fewer than 2 axis values', async () => {
    await expect(createWalkForward('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [3] },
      baseConfig: BASE_CONFIG,
      windowsConfig: { windows: 3, isRatio: 0.6, selectionMetric: 'sharpe' },
    })).rejects.toThrow(/2 parameter values/);
  });

  it('rejects windows outside 2..12', async () => {
    await expect(createWalkForward('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [2, 3] },
      baseConfig: BASE_CONFIG,
      windowsConfig: { windows: 1, isRatio: 0.6, selectionMetric: 'sharpe' },
    })).rejects.toThrow(/between 2 and 12/);
  });

  it('rejects isRatio outside 0.3..0.9', async () => {
    await expect(createWalkForward('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [2, 3] },
      baseConfig: BASE_CONFIG,
      windowsConfig: { windows: 3, isRatio: 0.95, selectionMetric: 'sharpe' },
    })).rejects.toThrow(/IS ratio/);
  });

  it('marks FAILED when there are too few candles for the requested windows', async () => {
    vi.mocked(getCandles).mockResolvedValue(oscillatingCandles(40) as never);
    const created = await createWalkForward('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [2, 3] },
      baseConfig: BASE_CONFIG,
      windowsConfig: { windows: 12, isRatio: 0.6, selectionMetric: 'sharpe' },
    });
    await waitFor(() => store.wfs.get(created.id)?.status as string, ['COMPLETED', 'FAILED']);
    const done = await getWalkForward('u1', created.id);
    expect(done.status).toBe('FAILED');
    expect(done.runError).toMatch(/candles|window/i);
  });

  it('selectionMetric=totalPnl picks the highest-PnL IS param', async () => {
    const created = await createWalkForward('u1', 'sess1', {
      axis: { paramKey: 'fastPeriod', values: [2, 4, 6] },
      baseConfig: BASE_CONFIG,
      windowsConfig: { windows: 3, isRatio: 0.6, selectionMetric: 'totalPnl' },
    });
    await waitFor(() => store.wfs.get(created.id)?.status as string, ['COMPLETED', 'FAILED']);
    const done = await getWalkForward('u1', created.id);
    expect(done.status).toBe('COMPLETED');
    for (const w of done.results!) {
      const best = w.isResults.find(r => r.paramValue === w.isBestParam)!;
      const maxPnl = Math.max(...w.isResults.filter(r => r.tradeCount > 0).map(r => r.totalPnl));
      // isBest's PnL is the max among traded rows (or it fell back to first
      // when no row traded — then all are 0 and this still holds).
      if (w.isResults.some(r => r.tradeCount > 0)) {
        expect(best.totalPnl).toBe(maxPnl);
      }
    }
  });
});
