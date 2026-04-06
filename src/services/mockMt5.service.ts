import { InstrumentType, TradeSide, TradeStatus } from '@prisma/client';

export type SyncMode = 'profitable' | 'losing' | 'random';

export interface MockTradeData {
  symbol: string;
  instrumentType: InstrumentType;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  volume: number;
  pnl: number;
  commission: number;
  swap: number;
  stopLoss: number;
  takeProfit: number;
  setup: string;
  status: TradeStatus;
  entryAt: Date;
  exitAt: Date;
  externalId: string;
}

function daysAgo(n: number, hourOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(8 + hourOffset, 30, 0, 0);
  return d;
}

function hoursLater(base: Date, h: number): Date {
  return new Date(base.getTime() + h * 60 * 60 * 1000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle — returns a new array */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Inclusive random integer */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Trade template pool (28 trades across 3 instruments, tagged win/loss) ────
//
// externalId keys are STABLE across syncs so (accountId, externalId) dedup
// works correctly — subsequent syncs skip already-imported trades.

type Tag = 'win' | 'loss';

interface Template {
  tag: Tag;
  /** stable unique key — used as the externalId suffix */
  key: string;
  daysBack: number;
  durationHours: number;
  data: Omit<MockTradeData, 'externalId' | 'entryAt' | 'exitAt'>;
}

const POOL: Template[] = [
  // ── EURUSD (10 trades) ────────────────────────────────────────────────────
  {
    tag: 'win', key: 'EUR-1', daysBack: 30, durationHours: 6,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY, entryPrice: 1.0823, exitPrice: 1.0891, volume: 0.20, pnl: 136.0, commission: -3.5, swap: -1.2, stopLoss: 1.0778, takeProfit: 1.0920, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'EUR-2', daysBack: 27, durationHours: 4,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.SELL, entryPrice: 1.0945, exitPrice: 1.0868, volume: 0.30, pnl: 231.0, commission: -4.2, swap: -0.8, stopLoss: 1.0985, takeProfit: 1.0840, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'EUR-3', daysBack: 24, durationHours: 3,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY, entryPrice: 1.0902, exitPrice: 1.0857, volume: 0.20, pnl: -90.0, commission: -3.5, swap: -0.5, stopLoss: 1.0855, takeProfit: 1.0975, setup: 'Order Block', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'EUR-4', daysBack: 21, durationHours: 5,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.SELL, entryPrice: 1.0988, exitPrice: 1.0893, volume: 0.25, pnl: 237.5, commission: -3.8, swap: -1.1, stopLoss: 1.1030, takeProfit: 1.0870, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'EUR-5', daysBack: 18, durationHours: 2,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY, entryPrice: 1.0760, exitPrice: 1.0729, volume: 0.30, pnl: -93.0, commission: -4.2, swap: -0.4, stopLoss: 1.0725, takeProfit: 1.0840, setup: 'Liquidity Sweep', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'EUR-6', daysBack: 15, durationHours: 7,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY, entryPrice: 1.0741, exitPrice: 1.0798, volume: 0.20, pnl: 114.0, commission: -3.5, swap: 0.0, stopLoss: 1.0710, takeProfit: 1.0820, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'EUR-7', daysBack: 12, durationHours: 3,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.SELL, entryPrice: 1.1012, exitPrice: 1.0959, volume: 0.20, pnl: 106.0, commission: -3.5, swap: -0.6, stopLoss: 1.1050, takeProfit: 1.0940, setup: 'Order Block', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'EUR-8', daysBack: 9, durationHours: 4,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.SELL, entryPrice: 1.0874, exitPrice: 1.0921, volume: 0.25, pnl: -117.5, commission: -3.8, swap: -0.9, stopLoss: 1.0930, takeProfit: 1.0800, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'EUR-9', daysBack: 5, durationHours: 5,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY, entryPrice: 1.0795, exitPrice: 1.0852, volume: 0.30, pnl: 171.0, commission: -4.2, swap: -0.8, stopLoss: 1.0760, takeProfit: 1.0870, setup: 'Liquidity Sweep', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'EUR-10', daysBack: 2, durationHours: 2,
    data: { symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY, entryPrice: 1.0910, exitPrice: 1.0877, volume: 0.20, pnl: -66.0, commission: -3.5, swap: 0.0, stopLoss: 1.0875, takeProfit: 1.0970, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },

  // ── XAUUSD (10 trades) ────────────────────────────────────────────────────
  {
    tag: 'win', key: 'XAU-1', daysBack: 29, durationHours: 8,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 2012.50, exitPrice: 2035.80, volume: 0.10, pnl: 233.0, commission: -5.0, swap: -2.1, stopLoss: 1998.00, takeProfit: 2050.00, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'XAU-2', daysBack: 26, durationHours: 12,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.SELL, entryPrice: 2045.00, exitPrice: 2190.00, volume: 0.50, pnl: -1450.0, commission: -12.5, swap: -8.4, stopLoss: 2100.00, takeProfit: 1980.00, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'XAU-3', daysBack: 23, durationHours: 6,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 1978.30, exitPrice: 2001.70, volume: 0.10, pnl: 234.0, commission: -5.0, swap: -1.8, stopLoss: 1962.00, takeProfit: 2020.00, setup: 'Order Block', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'XAU-4', daysBack: 20, durationHours: 4,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 2031.00, exitPrice: 2016.50, volume: 0.10, pnl: -145.0, commission: -5.0, swap: -1.2, stopLoss: 2015.00, takeProfit: 2060.00, setup: 'Liquidity Sweep', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'XAU-5', daysBack: 17, durationHours: 9,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 2023.10, exitPrice: 2049.80, volume: 0.10, pnl: 267.0, commission: -5.0, swap: -2.0, stopLoss: 2005.00, takeProfit: 2060.00, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'XAU-6', daysBack: 14, durationHours: 5,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.SELL, entryPrice: 2068.00, exitPrice: 2041.30, volume: 0.10, pnl: 267.0, commission: -5.0, swap: -1.5, stopLoss: 2085.00, takeProfit: 2030.00, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'XAU-7', daysBack: 11, durationHours: 3,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.SELL, entryPrice: 2058.00, exitPrice: 2081.00, volume: 0.10, pnl: -230.0, commission: -5.0, swap: -1.5, stopLoss: 2080.00, takeProfit: 2010.00, setup: 'Order Block', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'XAU-8', daysBack: 8, durationHours: 7,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 2038.50, exitPrice: 2061.00, volume: 0.10, pnl: 225.0, commission: -5.0, swap: -1.8, stopLoss: 2022.00, takeProfit: 2070.00, setup: 'Liquidity Sweep', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'XAU-9', daysBack: 5, durationHours: 5,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 2044.00, exitPrice: 2028.50, volume: 0.10, pnl: -155.0, commission: -5.0, swap: -1.1, stopLoss: 2027.00, takeProfit: 2072.00, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'XAU-10', daysBack: 2, durationHours: 4,
    data: { symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY, entryPrice: 2052.00, exitPrice: 2073.40, volume: 0.10, pnl: 214.0, commission: -5.0, swap: -0.9, stopLoss: 2036.00, takeProfit: 2080.00, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },

  // ── BTCUSD (8 trades) ─────────────────────────────────────────────────────
  {
    tag: 'loss', key: 'BTC-1', daysBack: 28, durationHours: 10,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.SELL, entryPrice: 43200.0, exitPrice: 44050.0, volume: 0.01, pnl: -85.0, commission: -4.3, swap: -3.2, stopLoss: 44500.0, takeProfit: 41000.0, setup: 'Order Block', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'BTC-2', daysBack: 25, durationHours: 14,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY, entryPrice: 42500.0, exitPrice: 45620.0, volume: 0.01, pnl: 312.0, commission: -4.2, swap: -5.1, stopLoss: 41000.0, takeProfit: 46000.0, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'BTC-3', daysBack: 22, durationHours: 8,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.SELL, entryPrice: 46300.0, exitPrice: 47530.0, volume: 0.01, pnl: -123.0, commission: -4.6, swap: -4.0, stopLoss: 48000.0, takeProfit: 43500.0, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'BTC-4', daysBack: 19, durationHours: 16,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY, entryPrice: 44100.0, exitPrice: 47300.0, volume: 0.01, pnl: 320.0, commission: -4.4, swap: -5.8, stopLoss: 42500.0, takeProfit: 48000.0, setup: 'Liquidity Sweep', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'BTC-5', daysBack: 13, durationHours: 6,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY, entryPrice: 44800.0, exitPrice: 44130.0, volume: 0.01, pnl: -67.0, commission: -4.5, swap: -2.8, stopLoss: 44000.0, takeProfit: 47000.0, setup: 'Order Block', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'BTC-6', daysBack: 10, durationHours: 12,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY, entryPrice: 43800.0, exitPrice: 46550.0, volume: 0.01, pnl: 275.0, commission: -4.4, swap: -4.9, stopLoss: 42300.0, takeProfit: 47000.0, setup: 'Fair Value Gap', status: TradeStatus.CLOSED },
  },
  {
    tag: 'loss', key: 'BTC-7', daysBack: 6, durationHours: 8,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.SELL, entryPrice: 46900.0, exitPrice: 47800.0, volume: 0.01, pnl: -90.0, commission: -4.7, swap: -3.5, stopLoss: 48200.0, takeProfit: 44000.0, setup: 'Liquidity Sweep', status: TradeStatus.CLOSED },
  },
  {
    tag: 'win', key: 'BTC-8', daysBack: 3, durationHours: 18,
    data: { symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY, entryPrice: 43100.0, exitPrice: 47550.0, volume: 0.01, pnl: 445.0, commission: -4.3, swap: -6.2, stopLoss: 41500.0, takeProfit: 48000.0, setup: 'Break & Retest', status: TradeStatus.CLOSED },
  },
];

// ── Filter by mode ─────────────────────────────────────────────────────────────

function filterByMode(mode: SyncMode): Template[] {
  if (mode === 'profitable') return POOL.filter((t) => t.tag === 'win');
  if (mode === 'losing')     return POOL.filter((t) => t.tag === 'loss');
  return POOL; // random = full pool
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function generateMockTrades(mode: SyncMode = 'random'): MockTradeData[] {
  const pool = filterByMode(mode);

  // ── Randomise batch size to feel like a real broker sync ──────────────────
  // Pool sizes: random=28, profitable=18, losing=10
  // We pick a random slice: roughly 40%–85% of the available pool.
  const minPick = Math.max(3, Math.floor(pool.length * 0.4));
  const maxPick = Math.floor(pool.length * 0.85);
  const count   = randInt(minPick, maxPick);

  // Shuffle, take `count`, then re-sort chronologically (oldest first)
  const selected = shuffle(pool).slice(0, count);
  selected.sort((a, b) => b.daysBack - a.daysBack);

  return selected.map((tpl) => {
    const entryAt = daysAgo(tpl.daysBack);
    const exitAt  = hoursLater(entryAt, tpl.durationHours);

    return {
      ...tpl.data,
      entryAt,
      exitAt,
      // Stable key → correct (accountId, externalId) dedup on re-sync
      externalId: `mt5-demo-${tpl.key}`,
    };
  });
}
