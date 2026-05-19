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

// ── ForexFactory fallback (keyless) ──────────────────────────────────────────
//
// JBlanked's "free" calendar has moved behind paid credits. When JBlanked is
// unavailable (no key, 401/credits, error, empty) we fall back to
// ForexFactory's own weekly JSON, which needs no key. Same week-of data.

/** Raw shape of the faireconomy ForexFactory weekly feed. */
interface FFRawEvent {
  title?: unknown;
  country?: unknown; // ISO currency code, e.g. "USD"
  date?: unknown; // ISO-8601 with offset, e.g. "2026-05-17T18:30:00-04:00"
  impact?: unknown; // "High" | "Medium" | "Low" | "Holiday" | ...
  forecast?: unknown; // string like "0.8%", "46.0", "1.2K", or ""
  previous?: unknown;
}

const FF_MULTIPLIER: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  T: 1e12,
};

/** Parse ForexFactory's stringy numbers ("0.8%", "-0.21%", "1.2K", ""). */
export function parseFFNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[,%\s]/g, '');
  if (!s) return null;
  const m = s.match(/^(-?\d*\.?\d+)([KMBT])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * FF_MULTIPLIER[m[2].toUpperCase()] : n;
}

/** Normalize one ForexFactory row. Returns null when unusable. */
export function normalizeForexFactoryEvent(
  raw: FFRawEvent,
): CalendarEvent | null {
  const name = typeof raw.title === 'string' ? raw.title.trim() : '';
  const currency =
    typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : '';
  const dateStr = typeof raw.date === 'string' ? raw.date.trim() : '';
  const date = dateStr ? new Date(dateStr) : null;
  if (!name || !currency || !date || Number.isNaN(date.getTime())) return null;

  const impactRaw = typeof raw.impact === 'string' ? raw.impact.trim() : '';
  const impact = (VALID_IMPACTS.has(impactRaw) ? impactRaw : 'None') as ImpactLevel;

  return {
    name,
    currency,
    impact,
    time: date.toISOString(),
    forecast: parseFFNumber(raw.forecast),
    previous: parseFFNumber(raw.previous),
    actual: null, // the weekly FF feed carries no actuals
  };
}

// ── Cached network fetch ─────────────────────────────────────────────────────

const CALENDAR_URL =
  'https://www.jblanked.com/news/api/forex-factory/calendar/week/';
const FF_FALLBACK_URL =
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_TTL_MS = 30 * 60_000; // 30 min — the upstream feed is hourly at best
const FETCH_TIMEOUT_MS = 10_000;

let cache: { at: number; events: CalendarEvent[] } | null = null;

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Primary source: JBlanked. Returns null (not []) to signal "unavailable, try
 * the fallback" — distinct from a successful empty week. Unchanged behaviour
 * from the original implementation, just lifted into its own function.
 */
async function fetchJBlanked(): Promise<CalendarEvent[] | null> {
  if (!env.JBLANKED_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(CALENDAR_URL, {
      Authorization: `Api-Key ${env.JBLANKED_API_KEY}`,
    });
    if (!res.ok) {
      logger.warn(`Economic calendar (JBlanked) failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body) ? body : [];
    const events = rows
      .map((r) => normalizeEvent(r as RawEvent))
      .filter((e): e is CalendarEvent => e !== null);
    return events.length > 0 ? events : null;
  } catch (err) {
    logger.warn(`Economic calendar (JBlanked) errored: ${(err as Error).message}`);
    return null;
  }
}

/** Fallback source: keyless ForexFactory weekly JSON. */
async function fetchForexFactory(): Promise<CalendarEvent[] | null> {
  try {
    const res = await fetchWithTimeout(FF_FALLBACK_URL, {
      'user-agent': 'Mozilla/5.0 (PropJournalX economic-calendar)',
    });
    if (!res.ok) {
      logger.warn(`Economic calendar (ForexFactory) failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body) ? body : [];
    const events = rows
      .map((r) => normalizeForexFactoryEvent(r as FFRawEvent))
      .filter((e): e is CalendarEvent => e !== null);
    return events.length > 0 ? events : null;
  } catch (err) {
    logger.warn(`Economic calendar (ForexFactory) errored: ${(err as Error).message}`);
    return null;
  }
}

/**
 * This week's events, normalized and cached. Tries JBlanked first, falls back
 * to the keyless ForexFactory feed. Returns [] (never throws) only when both
 * sources are unavailable, so the dashboard just shows an empty calendar.
 */
export async function getWeeklyEvents(
  force = false,
): Promise<CalendarEvent[]> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.events;
  }
  const events =
    (await fetchJBlanked()) ?? (await fetchForexFactory());
  if (events) {
    const sorted = [...events].sort((a, b) => a.time.localeCompare(b.time));
    cache = { at: now, events: sorted };
    return sorted;
  }
  return cache?.events ?? [];
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
