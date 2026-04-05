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

// ── Trade templates ────────────────────────────────────────────────────────────
// Each entry tagged as 'win' | 'loss' so we can filter by mode.
// "big_loss" is always a loss (tagged for logging only, still filtered as loss).

type Tag = 'win' | 'loss';

interface Template {
  tag: Tag;
  data: Omit<MockTradeData, 'externalId' | 'entryAt' | 'exitAt'>;
  daysBack: number;   // entry n days ago
  durationHours: number;
}

const TEMPLATES: Template[] = [
  // ── EURUSD ──────────────────────────────────────────────────────────────────
  {
    tag: 'win',
    daysBack: 28, durationHours: 6,
    data: {
      symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY,
      entryPrice: 1.0823, exitPrice: 1.0891, volume: 0.2,
      pnl: 136.0, commission: -3.5, swap: -1.2,
      stopLoss: 1.0778, takeProfit: 1.0920,
      setup: 'Break & Retest', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 22, durationHours: 4,
    data: {
      symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.SELL,
      entryPrice: 1.0945, exitPrice: 1.0868, volume: 0.3,
      pnl: 231.0, commission: -4.2, swap: -0.8,
      stopLoss: 1.0985, takeProfit: 1.0840,
      setup: 'Fair Value Gap', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'loss',
    daysBack: 17, durationHours: 3,
    data: {
      symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY,
      entryPrice: 1.0902, exitPrice: 1.0857, volume: 0.2,
      pnl: -90.0, commission: -3.5, swap: -0.5,
      stopLoss: 1.0855, takeProfit: 1.0975,
      setup: 'Order Block', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 12, durationHours: 5,
    data: {
      symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.SELL,
      entryPrice: 1.0988, exitPrice: 1.0893, volume: 0.25,
      pnl: 237.5, commission: -3.8, swap: -1.1,
      stopLoss: 1.1030, takeProfit: 1.0870,
      setup: 'Break & Retest', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 6, durationHours: 2,
    data: {
      symbol: 'EURUSD', instrumentType: InstrumentType.FOREX, side: TradeSide.BUY,
      entryPrice: 1.0741, exitPrice: 1.0798, volume: 0.2,
      pnl: 114.0, commission: -3.5, swap: 0.0,
      stopLoss: 1.0710, takeProfit: 1.0820,
      setup: 'Fair Value Gap', status: TradeStatus.CLOSED,
    },
  },

  // ── XAUUSD ──────────────────────────────────────────────────────────────────
  {
    tag: 'win',
    daysBack: 26, durationHours: 8,
    data: {
      symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY,
      entryPrice: 2012.50, exitPrice: 2035.80, volume: 0.1,
      pnl: 233.0, commission: -5.0, swap: -2.1,
      stopLoss: 1998.00, takeProfit: 2050.00,
      setup: 'Break & Retest', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'loss',
    daysBack: 21, durationHours: 12,
    data: {
      symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.SELL,
      entryPrice: 2045.00, exitPrice: 2190.00, volume: 0.5,
      pnl: -1450.0, commission: -12.5, swap: -8.4,
      stopLoss: 2100.00, takeProfit: 1980.00,
      setup: 'Fair Value Gap', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 15, durationHours: 6,
    data: {
      symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY,
      entryPrice: 1978.30, exitPrice: 2001.70, volume: 0.1,
      pnl: 234.0, commission: -5.0, swap: -1.8,
      stopLoss: 1962.00, takeProfit: 2020.00,
      setup: 'Order Block', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 10, durationHours: 9,
    data: {
      symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.BUY,
      entryPrice: 2023.10, exitPrice: 2049.80, volume: 0.1,
      pnl: 267.0, commission: -5.0, swap: -2.0,
      stopLoss: 2005.00, takeProfit: 2060.00,
      setup: 'Break & Retest', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'loss',
    daysBack: 4, durationHours: 5,
    data: {
      symbol: 'XAUUSD', instrumentType: InstrumentType.CFD, side: TradeSide.SELL,
      entryPrice: 2058.00, exitPrice: 2081.00, volume: 0.1,
      pnl: -230.0, commission: -5.0, swap: -1.5,
      stopLoss: 2080.00, takeProfit: 2010.00,
      setup: 'Fair Value Gap', status: TradeStatus.CLOSED,
    },
  },

  // ── BTCUSD ──────────────────────────────────────────────────────────────────
  {
    tag: 'loss',
    daysBack: 24, durationHours: 10,
    data: {
      symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.SELL,
      entryPrice: 43200.0, exitPrice: 44050.0, volume: 0.01,
      pnl: -85.0, commission: -4.3, swap: -3.2,
      stopLoss: 44500.0, takeProfit: 41000.0,
      setup: 'Order Block', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 19, durationHours: 14,
    data: {
      symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY,
      entryPrice: 42500.0, exitPrice: 45620.0, volume: 0.01,
      pnl: 312.0, commission: -4.2, swap: -5.1,
      stopLoss: 41000.0, takeProfit: 46000.0,
      setup: 'Break & Retest', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'loss',
    daysBack: 14, durationHours: 8,
    data: {
      symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.SELL,
      entryPrice: 46300.0, exitPrice: 47530.0, volume: 0.01,
      pnl: -123.0, commission: -4.6, swap: -4.0,
      stopLoss: 48000.0, takeProfit: 43500.0,
      setup: 'Fair Value Gap', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'loss',
    daysBack: 8, durationHours: 6,
    data: {
      symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY,
      entryPrice: 44800.0, exitPrice: 44130.0, volume: 0.01,
      pnl: -67.0, commission: -4.5, swap: -2.8,
      stopLoss: 44000.0, takeProfit: 47000.0,
      setup: 'Order Block', status: TradeStatus.CLOSED,
    },
  },
  {
    tag: 'win',
    daysBack: 2, durationHours: 16,
    data: {
      symbol: 'BTCUSD', instrumentType: InstrumentType.CRYPTO, side: TradeSide.BUY,
      entryPrice: 43100.0, exitPrice: 47550.0, volume: 0.01,
      pnl: 445.0, commission: -4.3, swap: -6.2,
      stopLoss: 41500.0, takeProfit: 48000.0,
      setup: 'Break & Retest', status: TradeStatus.CLOSED,
    },
  },
];

// ── Filter by mode ─────────────────────────────────────────────────────────────

function selectTemplates(mode: SyncMode): Template[] {
  if (mode === 'profitable') return TEMPLATES.filter((t) => t.tag === 'win');
  if (mode === 'losing') return TEMPLATES.filter((t) => t.tag === 'loss');
  return TEMPLATES; // random = all
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function generateMockTrades(mode: SyncMode = 'random'): MockTradeData[] {
  const selected = selectTemplates(mode);

  return selected.map((tpl, idx) => {
    const entryAt = daysAgo(tpl.daysBack);
    const exitAt = hoursLater(entryAt, tpl.durationHours);

    return {
      ...tpl.data,
      entryAt,
      exitAt,
      externalId: `demo-${idx + 1}-${tpl.data.symbol}-${tpl.daysBack}d`,
    };
  });
}
