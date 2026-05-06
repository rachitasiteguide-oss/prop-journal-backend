import YahooFinance from 'yahoo-finance2';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';

// Minimal type for the candle rows returned by yf.chart() with return:'array'.
// Mirrors ChartResultArrayQuote from yahoo-finance2 without a deep module import.
interface YFQuote {
  date:     Date;
  open:     number | null;
  high:     number | null;
  low:      number | null;
  close:    number | null;
  volume:   number | null;
  adjclose?: number | null;
}

// Narrowed type after the null-filter guard below.
type ValidYFQuote = YFQuote & { open: number; high: number; low: number; close: number };

// ── Singleton Yahoo Finance client ────────────────────────────────────────────
// Suppress the ripHistorical notice — we use chart() directly.
const yf = new YahooFinance({ suppressNotices: ['ripHistorical'] });

// ── Timeframe → Yahoo Finance interval mapping ────────────────────────────────
// Yahoo Finance v3 chart() supports these intervals.
// Note: intraday data availability is limited:
//   H1 (60m)  → up to ~730 days of history
//   M30 (30m) → up to ~60 days of history
//   M15 (15m) → up to ~60 days of history

const YF_INTERVAL_MAP: Record<string, '1d' | '1wk' | '60m' | '30m' | '15m'> = {
  D1:  '1d',
  W1:  '1wk',
  H1:  '60m',
  M30: '30m',
  M15: '15m',
};

// Maximum lookback in days Yahoo Finance reliably provides for each timeframe.
const TIMEFRAME_MAX_DAYS: Record<string, number> = {
  D1:  36500, // ~100 years — effectively unlimited for most symbols
  W1:  36500,
  H1:  730,
  M30: 60,
  M15: 60,
};

export const SUPPORTED_TIMEFRAMES = Object.keys(YF_INTERVAL_MAP);

// ── Symbol normalization ──────────────────────────────────────────────────────
// Convert the user-facing symbol (as stored on the session) to the format
// Yahoo Finance expects.
//
// Examples:
//   FOREX  : "EURUSD"  → "EURUSD=X"   (Yahoo Finance forex suffix)
//   CRYPTO : "BTC"     → "BTC-USD"    (assumes USD quote currency)
//   CRYPTO : "BTC-USD" → "BTC-USD"    (already correct)
//   STOCKS : "AAPL"    → "AAPL"       (no change)

export function normalizeYFSymbol(symbol: string, instrumentType: string): string {
  const s = symbol.toUpperCase().replace(/\s+/g, '');
  switch (instrumentType) {
    case 'FOREX':
      // Strip any broker suffixes (e.g. "EURUSDm" → "EURUSD"), then append =X
      return s.replace(/[^A-Z]/g, '').slice(0, 6) + '=X';
    case 'CRYPTO':
      return s.includes('-') ? s : `${s}-USD`;
    default:
      // STOCKS, FUTURES, CFD, OPTIONS — use symbol as-is
      return s;
  }
}

// ── Cache hit heuristic ───────────────────────────────────────────────────────
// Estimate the minimum number of candles that should exist in the DB for the
// requested range before we consider the cache "warm enough" to skip a fetch.
// We deliberately underestimate (0.4 multiplier) to account for weekends,
// holidays, and market closures.

function expectedCandleFloor(timeframe: string, from: Date, to: Date): number {
  const days = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  const candlesPerDay: Record<string, number> = {
    D1: 1, W1: 0.2, H1: 8, M30: 16, M15: 32,
  };
  const rate = candlesPerDay[timeframe] ?? 1;
  return Math.max(1, Math.floor(days * rate * 0.4));
}

// ── Candle upsert helper ──────────────────────────────────────────────────────
// Upserts in Prisma with $transaction have a per-batch parameter limit.
// Chunking at 300 keeps us well under PostgreSQL's ~65535 parameter limit
// even with 9 columns per row.
const UPSERT_CHUNK_SIZE = 300;

// ── Core fetch-and-cache function ─────────────────────────────────────────────
//
// 1. Check whether the DB already has enough candles for the range.
// 2. If not, fetch from Yahoo Finance and upsert everything.
// 3. Throw an AppError if the symbol is unrecognisable or data is unavailable.
//
// Idempotent — safe to call multiple times for the same range.

export async function fetchAndCacheCandles(
  symbol: string,
  instrumentType: string,
  timeframe: string,
  from: Date,
  to: Date,
): Promise<void> {
  const interval = YF_INTERVAL_MAP[timeframe];
  if (!interval) {
    throw new AppError(
      `Timeframe "${timeframe}" is not supported. Choose one of: ${SUPPORTED_TIMEFRAMES.join(', ')}.`,
      400,
    );
  }

  if (from >= to) {
    throw new AppError('Start date must be before end date.', 400);
  }

  if (to > new Date()) {
    throw new AppError(
      'End date cannot be in the future. Use a historical date range for backtesting.',
      400,
    );
  }

  // Guard intraday range limits
  const maxDays = TIMEFRAME_MAX_DAYS[timeframe] ?? 730;
  const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > maxDays) {
    throw new AppError(
      `${timeframe} data is limited to ${maxDays} days of history. ` +
        `Shorten the date range or switch to D1.`,
      400,
    );
  }

  // Check cache
  const existing = await prisma.candle.count({
    where: { symbol, timeframe, openTime: { gte: from, lte: to } },
  });
  const floor = expectedCandleFloor(timeframe, from, to);

  if (existing >= floor) {
    logger.info(`Candle cache hit: ${symbol}/${timeframe} (${existing} candles, need ≥${floor})`);
    return;
  }

  logger.info(
    `Cache miss for ${symbol}/${timeframe} (${existing}/${floor}). Fetching from Yahoo Finance…`,
  );

  const yfSymbol = normalizeYFSymbol(symbol, instrumentType);

  // Fetch from Yahoo Finance — pass return:'array' so the result has a `.quotes`
  // field. We cast through unknown because yahoo-finance2 v3 ships overloaded
  // signatures that TypeScript doesn't always resolve correctly via commonjs.
  let quotes: YFQuote[];
  try {
    const result = (await yf.chart(yfSymbol, {
      period1: from,
      period2: to,
      interval,
      return: 'array',
    } as Parameters<typeof yf.chart>[1])) as unknown as { quotes: YFQuote[] };
    quotes = result.quotes ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Yahoo Finance fetch failed for "${yfSymbol}": ${msg}`);
    throw new AppError(
      `Could not fetch market data for "${symbol}". ` +
        `Verify the symbol is correct for your instrument type.`,
      502,
    );
  }

  if (quotes.length === 0) {
    throw new AppError(
      `No market data returned for "${symbol}" in the selected date range. ` +
        `The symbol may be delisted or the range may be before the instrument listed.`,
      404,
    );
  }

  // Filter out candles with null OHLC — can occur on partial/halted trading days.
  const valid = quotes.filter(
    (q): q is ValidYFQuote =>
      q.open != null && q.high != null && q.low != null && q.close != null,
  );

  logger.info(`Upserting ${valid.length} candles for ${symbol}/${timeframe}…`);

  // Upsert in chunks to stay under DB parameter limits
  for (let i = 0; i < valid.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = valid.slice(i, i + UPSERT_CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((q) =>
        prisma.candle.upsert({
          where: {
            symbol_timeframe_openTime: {
              symbol,
              timeframe,
              openTime: q.date,
            },
          },
          create: {
            symbol,
            timeframe,
            openTime: q.date,
            open:   q.open!,
            high:   q.high!,
            low:    q.low!,
            close:  q.close!,
            volume: q.volume ?? 0,
          },
          update: {
            open:   q.open!,
            high:   q.high!,
            low:    q.low!,
            close:  q.close!,
            volume: q.volume ?? 0,
          },
        }),
      ),
    );
  }

  logger.info(`Candle cache populated: ${valid.length} rows for ${symbol}/${timeframe}`);
}

// ── Read candles from the local cache ────────────────────────────────────────
// Returns candles in chronological order. Caller must have run
// fetchAndCacheCandles() first to ensure the range is populated.

export async function getCachedCandles(
  symbol: string,
  timeframe: string,
  from: Date,
  to: Date,
) {
  return prisma.candle.findMany({
    where: { symbol, timeframe, openTime: { gte: from, lte: to } },
    orderBy: { openTime: 'asc' },
  });
}

// ── Convenience: fetch then return ───────────────────────────────────────────
// Single call that ensures candles are cached and returns them.
// Used by the backtest engine.

export async function getCandles(
  symbol: string,
  instrumentType: string,
  timeframe: string,
  from: Date,
  to: Date,
) {
  await fetchAndCacheCandles(symbol, instrumentType, timeframe, from, to);
  return getCachedCandles(symbol, timeframe, from, to);
}
