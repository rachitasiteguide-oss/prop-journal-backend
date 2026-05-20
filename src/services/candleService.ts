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

// Yahoo Finance has no spot-metal feed: XAUUSD=X, XAGUSD=X, XPTUSD=X, XPDUSD=X
// all return "No data found, symbol may be delisted". The user-facing symbols
// (XAU/USD etc.) must be routed to the COMEX futures tickers instead.
const METAL_TO_FUTURES: Record<string, string> = {
  XAU: 'GC=F',  // Gold
  XAG: 'SI=F',  // Silver
  XPT: 'PL=F',  // Platinum
  XPD: 'PA=F',  // Palladium
};

export function normalizeYFSymbol(symbol: string, instrumentType: string): string {
  const s = symbol.toUpperCase().replace(/\s+/g, '');
  const lettersOnly = s.replace(/[^A-Z]/g, '');

  // Metals override — regardless of declared instrumentType, route XAU/XAG/etc.
  // to the futures ticker Yahoo actually serves.
  const metalPrefix = lettersOnly.slice(0, 3);
  if (METAL_TO_FUTURES[metalPrefix] && lettersOnly.endsWith('USD')) {
    return METAL_TO_FUTURES[metalPrefix];
  }

  switch (instrumentType) {
    case 'FOREX':
      // Strip any broker suffixes (e.g. "EURUSDm" → "EURUSD"), then append =X
      return lettersOnly.slice(0, 6) + '=X';
    case 'CRYPTO':
      return s.includes('-') ? s : `${s}-USD`;
    case 'STOCKS':
      // Preserve dots and dashes — Yahoo uses them for class shares and
      // exchange suffixes (BRK.B, BF.A, RY.TO, 7203.T). Stripping non-letters
      // would silently turn BRK.B into BRKB and Yahoo would 404.
      // Strip whitespace only (already done above) and keep letters/digits/.-/^.
      return s.replace(/[^A-Z0-9.\-^]/g, '');
    default:
      // FUTURES, CFD, OPTIONS — strip slashes/punctuation but keep as-is
      return lettersOnly || s;
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

  // For stocks we additionally require adjClose to be populated. Rows cached
  // before adjusted-close tracking was added have adjClose=null; refetch so
  // split/dividend back-adjustment can be applied at read time.
  let needsAdjBackfill = false;
  if (instrumentType === 'STOCKS' && existing >= floor) {
    const missingAdj = await prisma.candle.count({
      where: { symbol, timeframe, openTime: { gte: from, lte: to }, adjClose: null },
    });
    needsAdjBackfill = missingAdj > 0;
    if (needsAdjBackfill) {
      logger.info(
        `Cache has ${existing} stock candles for ${symbol}/${timeframe} but ${missingAdj} lack adjClose; refetching.`,
      );
    }
  }

  if (existing >= floor && !needsAdjBackfill) {
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
  //
  // yf.chart() has no built-in timeout. When Yahoo stalls a connection (rate-
  // limiting, 502, network issue) the promise hangs indefinitely and the only
  // thing that frees the run is the orphanRunSweeper after 10 minutes — users
  // see "RUNNING BACKTEST 3% — FETCH DATA" stuck forever. Race the call with
  // a hard timeout, retry once on the first timeout, and surface a clear
  // error instead of hanging.
  const FETCH_TIMEOUT_MS = 30_000;
  const fetchOnce = (): Promise<{ quotes: YFQuote[] }> => {
    const call = yf.chart(yfSymbol, {
      period1: from,
      period2: to,
      interval,
      return: 'array',
    } as Parameters<typeof yf.chart>[1]) as unknown as Promise<{ quotes: YFQuote[] }>;
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`Yahoo Finance fetch timed out after ${FETCH_TIMEOUT_MS}ms`)),
        FETCH_TIMEOUT_MS,
      );
      call.then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
    });
  };

  let quotes: YFQuote[];
  try {
    let result: { quotes: YFQuote[] };
    try {
      result = await fetchOnce();
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      logger.warn(`Yahoo Finance first attempt failed for "${yfSymbol}": ${msg} — retrying once`);
      result = await fetchOnce();
    }
    quotes = result.quotes ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timed out/i.test(msg);
    logger.error(`Yahoo Finance fetch failed for "${yfSymbol}" after retry: ${msg}`);
    throw new AppError(
      isTimeout
        ? `Market data fetch for "${symbol}" timed out twice (Yahoo Finance unreachable or rate-limited). Try again in a minute.`
        : `Could not fetch market data for "${symbol}". Verify the symbol is correct for your instrument type.`,
      isTimeout ? 504 : 502,
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
            open:     q.open!,
            high:     q.high!,
            low:      q.low!,
            close:    q.close!,
            adjClose: q.adjclose ?? null,
            volume:   q.volume ?? 0,
          },
          update: {
            open:     q.open!,
            high:     q.high!,
            low:      q.low!,
            close:    q.close!,
            adjClose: q.adjclose ?? null,
            volume:   q.volume ?? 0,
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
  const rows = await getCachedCandles(symbol, timeframe, from, to);

  // Stocks only: back-adjust OHLC by the adjClose/close ratio so splits and
  // dividends do not produce phantom gap signals (e.g. AAPL 2020-08-31 4-for-1
  // would otherwise look like a -75% bar to every breakout/MA strategy).
  // Forex/futures/crypto do not have corporate actions — return rows as-is.
  if (instrumentType !== 'STOCKS') return rows;

  return rows.map((c) => {
    if (c.adjClose == null || c.close === 0) return c;
    const ratio = c.adjClose / c.close;
    if (ratio === 1) return c;
    return {
      ...c,
      open:  c.open  * ratio,
      high:  c.high  * ratio,
      low:   c.low   * ratio,
      close: c.adjClose,
    };
  });
}
