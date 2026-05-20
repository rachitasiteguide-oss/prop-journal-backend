import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { getCandles, SUPPORTED_TIMEFRAMES } from './candleService';

// ── Window selection (pure, exported for tests) ──────────────────────────────
// Decides how many bars of "context" to show before the entry and after the
// exit on the replay chart. Industry convention (TradeZella, TradingView) is
// ~20-50 bars of context — enough to see the structure that set the trade up
// without overwhelming intraday detail.

export interface ReplayWindowInput {
  entryAt: Date;
  exitAt: Date | null;
  timeframe: string;
  /** How many bars of pre-entry context to include. Default 30. */
  contextBars?: number;
  /** Treated as "now" when the trade is still OPEN. Injected for tests. */
  now?: Date;
}

export interface ReplayWindow {
  from: Date;
  to: Date;
  /** Marker timestamps the frontend uses to align entry/exit on the chart. */
  entryAt: Date;
  exitAt: Date | null;
}

const TIMEFRAME_MINUTES: Record<string, number> = {
  M15: 15,
  M30: 30,
  H1: 60,
  D1: 60 * 24,
  W1: 60 * 24 * 7,
};

export function computeReplayWindow(input: ReplayWindowInput): ReplayWindow {
  const minutesPerBar = TIMEFRAME_MINUTES[input.timeframe];
  if (!minutesPerBar) {
    throw new AppError(`Unsupported timeframe: ${input.timeframe}`, 400);
  }
  const contextBars = input.contextBars ?? 30;
  const padMs = contextBars * minutesPerBar * 60 * 1000;

  const entryMs = input.entryAt.getTime();
  let exitMs: number;
  if (input.exitAt) {
    // CLOSED trade — use the real exit time. Do NOT extend; a 1-minute scalp
    // should render as a 1-minute scalp with padding around it.
    exitMs = input.exitAt.getTime();
  } else {
    // OPEN trade — extend to "now", but never less than `padMs` past entry so
    // a freshly-opened trade still renders a usable chart instead of a single
    // candle hugging the right edge.
    const nowMs = (input.now ?? new Date()).getTime();
    exitMs = Math.max(nowMs, entryMs + padMs);
  }

  return {
    from: new Date(entryMs - padMs),
    to: new Date(exitMs + padMs),
    entryAt: input.entryAt,
    exitAt: input.exitAt,
  };
}

// ── Default timeframe heuristic ──────────────────────────────────────────────
// Pick a timeframe automatically when the client doesn't specify one, based on
// the trade's actual duration. Mirrors what a trader would manually click —
// scalps → M15, intraday → H1, swings → D1.

export function pickDefaultTimeframe(durationMs: number): string {
  const hours = durationMs / (60 * 60 * 1000);
  if (hours < 4) return 'M15';
  if (hours < 24) return 'H1';
  if (hours < 24 * 14) return 'H1';
  return 'D1';
}

// ── Replay payload ───────────────────────────────────────────────────────────

export interface ReplayMarker {
  time: number; // unix seconds — lightweight-charts native format
  type: 'ENTRY' | 'EXIT';
  side: 'BUY' | 'SELL';
  price: number;
}

export interface ReplayPriceLine {
  type: 'STOP_LOSS' | 'TAKE_PROFIT';
  price: number;
}

export interface ReplayCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface ReplayPayload {
  tradeId: string;
  symbol: string;
  timeframe: string;
  side: 'BUY' | 'SELL';
  status: 'OPEN' | 'CLOSED';
  window: { from: string; to: string };
  candles: ReplayCandle[];
  markers: ReplayMarker[];
  priceLines: ReplayPriceLine[];
}

// candleService.getCandles() returns rows with `openTime` (DB column name);
// raw test fixtures often use `time`. Accept either to keep this function
// usable as a pure utility.
interface RawCandle {
  openTime?: Date | string;
  time?: Date | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export function toReplayCandle(c: RawCandle): ReplayCandle {
  const stamp = c.openTime ?? c.time;
  if (!stamp) throw new Error('Candle is missing openTime / time');
  return {
    time: Math.floor(new Date(stamp).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

export interface GetReplayOptions {
  userId: string;
  tradeId: string;
  timeframe?: string;
  contextBars?: number;
}

export async function getTradeReplay(opts: GetReplayOptions): Promise<ReplayPayload> {
  const trade = await prisma.trade.findFirst({
    where: { id: opts.tradeId, account: { userId: opts.userId } },
    select: {
      id: true,
      symbol: true,
      instrumentType: true,
      side: true,
      status: true,
      entryPrice: true,
      exitPrice: true,
      stopLoss: true,
      takeProfit: true,
      entryAt: true,
      exitAt: true,
    },
  });
  if (!trade) throw new AppError('Trade not found', 404);

  const duration =
    (trade.exitAt ?? new Date()).getTime() - trade.entryAt.getTime();
  const timeframe = opts.timeframe ?? pickDefaultTimeframe(duration);
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new AppError(`Unsupported timeframe: ${timeframe}`, 400);
  }

  const window = computeReplayWindow({
    entryAt: trade.entryAt,
    exitAt: trade.exitAt,
    timeframe,
    contextBars: opts.contextBars,
  });

  const candles = await getCandles(
    trade.symbol,
    trade.instrumentType,
    timeframe,
    window.from,
    window.to,
  );

  const markers: ReplayMarker[] = [
    {
      time: Math.floor(trade.entryAt.getTime() / 1000),
      type: 'ENTRY',
      side: trade.side as 'BUY' | 'SELL',
      price: trade.entryPrice,
    },
  ];
  if (trade.exitAt && trade.exitPrice != null) {
    markers.push({
      time: Math.floor(trade.exitAt.getTime() / 1000),
      type: 'EXIT',
      side: trade.side as 'BUY' | 'SELL',
      price: trade.exitPrice,
    });
  }

  const priceLines: ReplayPriceLine[] = [];
  if (trade.stopLoss != null) priceLines.push({ type: 'STOP_LOSS', price: trade.stopLoss });
  if (trade.takeProfit != null) priceLines.push({ type: 'TAKE_PROFIT', price: trade.takeProfit });

  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    timeframe,
    side: trade.side as 'BUY' | 'SELL',
    status: trade.status as 'OPEN' | 'CLOSED',
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    candles: candles.map(toReplayCandle),
    markers,
    priceLines,
  };
}
