import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runAutomatedBacktest, type EngineConfig } from '../backtestEngine';
import { clearSignalCache } from '../signalCache';

vi.mock('../../config/db', () => ({
  prisma: {
    backtestSession: {
      findFirst: vi.fn(),
      update:    vi.fn(),
    },
    backtestTrade: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

vi.mock('../candleService', () => ({
  getCandles: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { prisma } from '../../config/db';
import { getCandles } from '../candleService';

// ── Candle factory ────────────────────────────────────────────────────────────

interface TestCandle {
  id: string; symbol: string; timeframe: string; openTime: Date;
  open: number; high: number; low: number; close: number; volume: number;
}

function makeCandle(i: number, close: number, overrides?: Partial<TestCandle>): TestCandle {
  return {
    id: `c${i}`, symbol: 'TEST', timeframe: 'D1',
    openTime: new Date(Date.UTC(2023, 0, i + 1)),
    open: close, high: close * 1.05, low: close * 0.95,
    close, volume: 1000,
    ...overrides,
  };
}

// 20 candles with a single BUY MA_CROSS (SMA-3/SMA-5) signal at index 5.
// Verified: SMA3[5]=103.33 > SMA5[5]=102, while SMA3[4]=SMA5[4]=100.
// Entry fires at candle[6].open.
function buildBuyCrossoverCandles(): TestCandle[] {
  return Array.from({ length: 20 }, (_, i) => makeCandle(i, i < 5 ? 100 : 110));
}

// 20 candles with a SELL crossover at index 5.
// SMA3[5]=106.67 < SMA5[5]=108, while SMA3[4]=SMA5[4]=110.
function buildSellCrossoverCandles(): TestCandle[] {
  return Array.from({ length: 20 }, (_, i) => makeCandle(i, i < 5 ? 110 : 100));
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SESSION = {
  id: 'session1', userId: 'user1', symbol: 'TEST', timeframe: 'D1',
  startDate: new Date('2023-01-01'), endDate: new Date('2023-12-31'),
  startingBalance: 10000,
};

const BASE_CONFIG: EngineConfig = {
  strategyType:     'MA_CROSS',
  strategyConfig:   { fastPeriod: 3, slowPeriod: 5, maType: 'SMA' },
  startingBalance:  10000,
  volume:           1,
  stopLossPct:      0.9,  // wide enough that SL/TP never hit in synthetic data
  takeProfitRatio:  2,
  slippagePct:      0,
  commission:       0,
  maxOpenPositions: 1,
  instrumentType:   'STOCKS',
};

function setupMocks() {
  vi.mocked(prisma.backtestSession.findFirst).mockResolvedValue(SESSION as never);
  vi.mocked(prisma.backtestSession.update).mockResolvedValue({} as never);
  vi.mocked(prisma.backtestTrade.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.backtestTrade.createMany).mockResolvedValue({ count: 0 } as never);
}

function getCreatedTrades() {
  const calls = vi.mocked(prisma.backtestTrade.createMany).mock.calls;
  return (calls[0][0] as { data: Record<string, unknown>[] }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
  // Wipe the in-memory signal cache so a previous test's signals can't be
  // reused when the next test mocks getCandles to return different data
  // for the same (symbol, timeframe, range, strategy, params) tuple.
  clearSignalCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('backtestEngine', () => {
  it('Rule 1 — entry price is next-bar open, not signal-candle close', async () => {
    const candles = buildBuyCrossoverCandles();
    vi.mocked(getCandles).mockResolvedValue(candles as never);

    await runAutomatedBacktest('user1', 'session1', BASE_CONFIG);

    const trades = getCreatedTrades();
    expect(trades.length).toBeGreaterThan(0);
    const trade = trades[0];
    // Signal fires at index 5; entry must be at candles[6].open (next bar).
    expect(trade.entryPrice).toBe(candles[6].open);
    expect(trade.entryAt).toEqual(candles[6].openTime);
  });

  it('Rule 2 — SL wins when both SL and TP are crossed on the same candle', async () => {
    const candles = buildBuyCrossoverCandles();
    // Entry candle[6]: open=100 → SL=98, TP=104
    candles[6] = makeCandle(6, 100, { open: 100, high: 101, low: 99 });
    // candles[7]: low=97 (≤SL=98) AND high=105 (≥TP=104) → ambiguous
    candles[7] = makeCandle(7, 101, { open: 100, high: 105, low: 97 });
    vi.mocked(getCandles).mockResolvedValue(candles as never);

    const config: EngineConfig = {
      ...BASE_CONFIG,
      stopLossPct:     0.02,  // SL = 100 × 0.98 = 98
      takeProfitRatio: 2,     // TP = 100 × 1.04 = 104
      slippagePct:     0,
      commission:      0,
    };
    await runAutomatedBacktest('user1', 'session1', config);

    const trade = getCreatedTrades()[0];
    expect(trade.ambiguous).toBe(true);
    expect(Number(trade.exitPrice)).toBeCloseTo(98);  // SL, not TP
    expect(Number(trade.pnl)).toBeLessThan(0);
  });

  it('Rule 3 — slippage applied at entry: BUY inflates price, SELL deflates it', async () => {
    // BUY: entryPrice = rawOpen × (1 + slippagePct)
    const buyCandles = buildBuyCrossoverCandles();
    vi.mocked(getCandles).mockResolvedValue(buyCandles as never);
    const rawBuyOpen = buyCandles[6].open;

    await runAutomatedBacktest('user1', 'session1', { ...BASE_CONFIG, slippagePct: 0.001 });

    const buyTrade = getCreatedTrades()[0];
    expect(Number(buyTrade.entryPrice)).toBeCloseTo(rawBuyOpen * 1.001, 6);

    // Reset for SELL test — also clear the signal cache, since the cache
    // key (symbol, timeframe, range, strategy, params) is identical between
    // the two scenarios but the candle data differs (BUY vs SELL crossover).
    vi.clearAllMocks();
    setupMocks();
    clearSignalCache();

    // SELL: entryPrice = rawOpen × (1 - slippagePct)
    const sellCandles = buildSellCrossoverCandles();
    vi.mocked(getCandles).mockResolvedValue(sellCandles as never);
    const rawSellOpen = sellCandles[6].open;

    await runAutomatedBacktest('user1', 'session1', { ...BASE_CONFIG, slippagePct: 0.001 });

    const sellTrade = getCreatedTrades()[0];
    expect(Number(sellTrade.entryPrice)).toBeCloseTo(rawSellOpen * 0.999, 6);
  });

  it('Rule 4 — commission charged per leg: total = 2 × config.commission', async () => {
    const candles = buildBuyCrossoverCandles();
    // Flatten all candles from entry onward to the same price so rawPnl=0.
    const entryOpen = 110;
    for (let i = 6; i < 20; i++) {
      candles[i] = makeCandle(i, entryOpen, { open: entryOpen });
    }
    vi.mocked(getCandles).mockResolvedValue(candles as never);

    await runAutomatedBacktest('user1', 'session1', { ...BASE_CONFIG, commission: 5 });

    const trade = getCreatedTrades()[0];
    // Per-leg semantics: 5 on entry + 5 on exit = 10 round-trip.
    expect(Number(trade.commission)).toBe(10);
    expect(Number(trade.pnl)).toBeCloseTo(-10);  // rawPnl=0, finalPnl=0−10=−10
  });

  it('Rule 5 — last-candle force-close exits at final candle close', async () => {
    const candles = buildBuyCrossoverCandles();
    // Wide SL/TP (BASE_CONFIG) means no exit mid-run; use a distinct close to confirm.
    candles[19] = makeCandle(19, 115, { close: 115 });
    vi.mocked(getCandles).mockResolvedValue(candles as never);

    await runAutomatedBacktest('user1', 'session1', BASE_CONFIG);

    const trade = getCreatedTrades()[0];
    expect(Number(trade.exitPrice)).toBe(115);
  });

  it('Rule 6 — P&L formula: FOREX lot × 100 000, STOCKS price-diff × volume', async () => {
    // ── FOREX: BUY 1 lot, entry 1.1000 → force-close 1.1010 → +$100 ──────────
    // Crossover: closes[0-4]=1.0990, closes[5]=1.1010 → SMA3 > SMA5 at i=5.
    const forexCandles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(i, i < 5 ? 1.0990 : 1.1010),
    );
    forexCandles[6]  = makeCandle(6,  1.1000, { open: 1.1000 });
    forexCandles[19] = makeCandle(19, 1.1010, { close: 1.1010 });
    vi.mocked(getCandles).mockResolvedValue(forexCandles as never);

    await runAutomatedBacktest('user1', 'session1', {
      ...BASE_CONFIG, volume: 1, instrumentType: 'FOREX', slippagePct: 0, commission: 0,
    });

    // (1.1010 − 1.1000) × 1 × 100 000 = 100
    expect(Number(getCreatedTrades()[0].pnl)).toBeCloseTo(100, 1);

    vi.clearAllMocks();
    setupMocks();
    clearSignalCache();

    // ── STOCKS: BUY 10 shares, entry 100 → force-close 105 → +$50 ────────────
    const stockCandles = buildBuyCrossoverCandles();
    stockCandles[6]  = makeCandle(6,  100, { open: 100 });
    stockCandles[19] = makeCandle(19, 105, { close: 105 });
    vi.mocked(getCandles).mockResolvedValue(stockCandles as never);

    await runAutomatedBacktest('user1', 'session1', {
      ...BASE_CONFIG, volume: 10, instrumentType: 'STOCKS', slippagePct: 0, commission: 0,
    });

    // (105 − 100) × 10 = 50
    expect(Number(getCreatedTrades()[0].pnl)).toBeCloseTo(50, 1);
  });
});
