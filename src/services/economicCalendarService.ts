import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Economic calendar (JBlanked free Forex Factory feed).
//
// Top trader pain point this addresses: accounts blown by trading into
// high-impact news. We surface upcoming high-impact events on the dashboard
// and flag historical trades that were opened inside a news window.
//
// Source: https://www.jblanked.com/news/api/forex-factory/calendar/week/
// Auth:   header  Authorization: Api-Key <key>
// The JBlanked "Date" field is "YYYY.MM.DD HH:MM:SS" in UTC.
// ─────────────────────────────────────────────────────────────────────────────

export type ImpactLevel = 'High' | 'Medium' | 'Low' | 'None';

export interface CalendarEvent {
  name: string;
  currency: string;
  impact: ImpactLevel;
  /** Event time as an ISO-8601 UTC string. */
  time: string;
  forecast: number | null;
  previous: number | null;
  actual: number | null;
}

/** Raw shape returned by the JBlanked feed (only fields we consume). */
interface RawEvent {
  Name?: unknown;
  Currency?: unknown;
  Impact?: unknown;
  Date?: unknown;
  Forecast?: unknown;
  Previous?: unknown;
  Actual?: unknown;
}

const VALID_IMPACTS: ReadonlySet<string> = new Set(['High', 'Medium', 'Low', 'None']);

/**
 * Parse the JBlanked date format ("2024.02.08 15:30:00", UTC) into a Date.
 * Returns null for anything that does not match the exact format so a single
 * malformed row never corrupts the whole feed.
 */
export function parseJBlankedDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(
    /^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize one raw feed row. Returns null when the row is unusable. */
export function normalizeEvent(raw: RawEvent): CalendarEvent | null {
  const name = typeof raw.Name === 'string' ? raw.Name.trim() : '';
  const currency =
    typeof raw.Currency === 'string' ? raw.Currency.trim().toUpperCase() : '';
  const date = parseJBlankedDate(raw.Date);
  if (!name || !currency || !date) return null;

  const impactRaw = typeof raw.Impact === 'string' ? raw.Impact.trim() : '';
  const impact = (VALID_IMPACTS.has(impactRaw) ? impactRaw : 'None') as ImpactLevel;

  return {
    name,
    currency,
    impact,
    time: date.toISOString(),
    forecast: toNumberOrNull(raw.Forecast),
    previous: toNumberOrNull(raw.Previous),
    actual: toNumberOrNull(raw.Actual),
  };
}

/**
 * Currencies a trade symbol is exposed to. "EURUSD" -> [EUR, USD],
 * "XAUUSD" -> [USD] (gold leg has no ISO code), "AAPL" -> [USD] (fallback:
 * US-listed equities react to USD events). Broker suffixes ("EURUSDm",
 * "EURUSD.pro") are stripped.
 */
export function symbolCurrencies(symbol: string): string[] {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  const ISO = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD',
  ]);
  const found: string[] = [];
  for (let i = 0; i + 3 <= s.length; i += 3) {
    const code = s.slice(i, i + 3);
    if (ISO.has(code) && !found.includes(code)) found.push(code);
  }
  return found.length > 0 ? found : ['USD'];
}

export interface NewsWindowOptions {
  /** Minutes before the event the window opens. */
  beforeMin: number;
  /** Minutes after the event the window closes. */
  afterMin: number;
  /** Only flag events at or above this impact. */
  minImpact: ImpactLevel;
}

const IMPACT_RANK: Record<ImpactLevel, number> = {
  None: 0,
  Low: 1,
  Medium: 2,
  High: 3,
};

export interface NewsWindowHit {
  tradeId: string;
  symbol: string;
  entryAt: string;
  event: { name: string; currency: string; impact: ImpactLevel; time: string };
  /** Signed minutes from event to entry (negative = entered before release). */
  minutesFromEvent: number;
}

export interface TradeLike {
  id: string;
  symbol: string;
  entryAt: Date | string;
}

/**
 * Flag trades whose entry falls inside the news window of a relevant
 * (currency-matched, impact-qualified) event. Pure — no I/O — so it is unit
 * testable and reusable for both historical scans and pre-trade checks.
 */
export function detectNewsWindowTrades(
  trades: TradeLike[],
  events: CalendarEvent[],
  opts: NewsWindowOptions,
): NewsWindowHit[] {
  const minRank = IMPACT_RANK[opts.minImpact];
  const qualifying = events.filter(
    (e) => IMPACT_RANK[e.impact] >= minRank,
  );
  const hits: NewsWindowHit[] = [];

  for (const trade of trades) {
    const entryMs = new Date(trade.entryAt).getTime();
    if (Number.isNaN(entryMs)) continue;
    const ccys = symbolCurrencies(trade.symbol);

    for (const ev of qualifying) {
      if (!ccys.includes(ev.currency)) continue;
      const evMs = new Date(ev.time).getTime();
      const deltaMin = (entryMs - evMs) / 60_000;
      if (deltaMin >= -opts.beforeMin && deltaMin <= opts.afterMin) {
        hits.push({
          tradeId: trade.id,
          symbol: trade.symbol,
          entryAt: new Date(entryMs).toISOString(),
          event: {
            name: ev.name,
            currency: ev.currency,
            impact: ev.impact,
            time: ev.time,
          },
          minutesFromEvent: Math.round(deltaMin),
        });
        break; // one hit per trade is enough to flag it
      }
    }
  }
  return hits;
}

// ── Cached network fetch ─────────────────────────────────────────────────────

const CALENDAR_URL =
  'https://www.jblanked.com/news/api/forex-factory/calendar/week/';
const CACHE_TTL_MS = 30 * 60_000; // 30 min — the upstream feed is hourly at best
const FETCH_TIMEOUT_MS = 10_000;

let cache: { at: number; events: CalendarEvent[] } | null = null;

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Authorization: `Api-Key ${env.JBLANKED_API_KEY}` },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * This week's events, normalized and cached. Returns [] (never throws) when
 * the API key is missing or the upstream call fails, so the dashboard simply
 * shows an empty calendar instead of erroring.
 */
export async function getWeeklyEvents(
  force = false,
): Promise<CalendarEvent[]> {
  if (!env.JBLANKED_API_KEY) return [];
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.events;
  }
  try {
    const res = await fetchWithTimeout(CALENDAR_URL);
    if (!res.ok) {
      logger.warn(`Economic calendar fetch failed: ${res.status}`);
      return cache?.events ?? [];
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body) ? body : [];
    const events = rows
      .map((r) => normalizeEvent(r as RawEvent))
      .filter((e): e is CalendarEvent => e !== null)
      .sort((a, b) => a.time.localeCompare(b.time));
    cache = { at: now, events };
    return events;
  } catch (err) {
    logger.warn(`Economic calendar errored: ${(err as Error).message}`);
    return cache?.events ?? [];
  }
}

/** Upcoming events (time >= now), optionally impact-filtered. */
export async function getUpcomingEvents(
  minImpact: ImpactLevel = 'High',
): Promise<CalendarEvent[]> {
  const all = await getWeeklyEvents();
  const nowIso = new Date().toISOString();
  const minRank = IMPACT_RANK[minImpact];
  return all.filter(
    (e) => e.time >= nowIso && IMPACT_RANK[e.impact] >= minRank,
  );
}

/** Test-only: reset the module cache. */
export function __resetCalendarCache(): void {
  cache = null;
}
