import { parseCsv } from '../utils/csv';

// Normalised trade shape every parser returns. Downstream importService
// converts these to Prisma create payloads.
export interface ParsedTrade {
  externalId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number | null;
  volume: number;
  pnl: number | null;
  commission: number | null;
  swap: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  entryAt: Date;
  exitAt: Date | null;
  status: 'OPEN' | 'CLOSED';
}

export interface RowError {
  row: number;
  message: string;
}

export type StatementFormat = 'mt4' | 'mt5' | 'csv_generic';

export interface ParseResult {
  format: StatementFormat;
  trades: ParsedTrade[];
  errors: RowError[];
}

// Column aliases (lower-case, stripped of non-alphanumerics for matching).
// One canonical key → list of accepted header spellings used by MT4 / MT5 /
// generic broker exports. Anything not listed lands in `unmapped` and is
// ignored.
const ALIASES: Record<string, string[]> = {
  externalId: ['ticket', 'position', 'positionid', 'deal', 'dealid', 'order', 'orderid', 'id'],
  symbol: ['symbol', 'item', 'instrument', 'pair'],
  side: ['type', 'side', 'direction', 'action'],
  entryPrice: ['openprice', 'entryprice', 'priceopen', 'open'],
  exitPrice: ['closeprice', 'exitprice', 'priceclose', 'close'],
  volume: ['volume', 'size', 'lots', 'qty', 'quantity', 'lotsize'],
  pnl: ['profit', 'pnl', 'pl', 'netprofit', 'realisedpl', 'realizedpl', 'netpl'],
  commission: ['commission', 'comm', 'commissions', 'fee', 'fees'],
  swap: ['swap', 'rollover', 'storage'],
  stopLoss: ['sl', 'stoploss', 'stop'],
  takeProfit: ['tp', 'takeprofit', 'target'],
  entryAt: ['opentime', 'entrytime', 'time', 'datetimeopen', 'openat'],
  exitAt: ['closetime', 'exittime', 'datetimeclose', 'closeat'],
};

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildColumnMap(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const seen = new Set<string>();
  headers.forEach((h, idx) => {
    const norm = normaliseHeader(h);
    for (const [canonical, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(norm) && !map.has(canonical)) {
        map.set(canonical, idx);
        seen.add(canonical);
        break;
      }
    }
  });
  // Heuristic: if there are TWO "time" columns and we picked the first for
  // entryAt, the second is exitAt.
  const timeCols: number[] = [];
  headers.forEach((h, idx) => {
    if (normaliseHeader(h) === 'time') timeCols.push(idx);
  });
  if (timeCols.length === 2 && !map.has('exitAt')) {
    map.set('exitAt', timeCols[1]);
    if (!map.has('entryAt')) map.set('entryAt', timeCols[0]);
  }
  // Same logic for two "price" columns — MT4 statements have Open Price and
  // Close Price both labelled just "Price".
  const priceCols: number[] = [];
  headers.forEach((h, idx) => {
    if (normaliseHeader(h) === 'price') priceCols.push(idx);
  });
  if (priceCols.length >= 2) {
    if (!map.has('entryPrice')) map.set('entryPrice', priceCols[0]);
    if (!map.has('exitPrice')) map.set('exitPrice', priceCols[1]);
  }
  return map;
}

export function detectFormat(text: string): StatementFormat {
  const head = text.slice(0, 4000).toLowerCase();
  if (head.includes('metatrader 5')) return 'mt5';
  if (head.includes('metatrader 4') || head.includes('account statement')) return 'mt4';
  // Header-keyword fallback: MT5 history columns include "deal"; MT4 columns
  // include "ticket". Generic CSVs use neutral names ("id", "trade_id").
  const firstLine = head.split('\n').find((l) => l.trim().length > 0) ?? '';
  if (/\bdeal\b/.test(firstLine)) return 'mt5';
  if (/\bticket\b/.test(firstLine)) return 'mt4';
  return 'csv_generic';
}

const SIDE_MAP: Record<string, 'BUY' | 'SELL'> = {
  buy: 'BUY',
  long: 'BUY',
  b: 'BUY',
  sell: 'SELL',
  short: 'SELL',
  s: 'SELL',
};

function parseSide(raw: string): 'BUY' | 'SELL' | null {
  const norm = raw.trim().toLowerCase();
  // MT4/MT5 sometimes write "buy" / "balance" / "sell stop" — only accept the
  // pure direction tokens. Anything else (balance, credit, deposit) is a
  // skip-row signal handled by the parser.
  if (SIDE_MAP[norm]) return SIDE_MAP[norm];
  if (norm.startsWith('buy')) return 'BUY';
  if (norm.startsWith('sell')) return 'SELL';
  return null;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.replace(/\s/g, '').replace(/,/g, '');
  if (trimmed === '' || trimmed === '-') return null;
  // Some exports wrap negatives in parens: (123.45)
  const isParen = /^\(.*\)$/.test(trimmed);
  const stripped = isParen ? trimmed.slice(1, -1) : trimmed;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return isParen ? -n : n;
}

// Accepts:
//   "2024.05.13 14:30:00"     ← MT4/MT5 native
//   "2024.05.13 14:30"        ← MT4 shortened
//   "2024-05-13T14:30:00Z"    ← ISO
//   "2024-05-13 14:30:00"     ← generic CSV
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let iso = trimmed;
  // MT format "YYYY.MM.DD HH:MM[:SS]" → "YYYY-MM-DDTHH:MM[:SS]Z"
  const mt = /^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (mt) {
    const [, y, mo, d, h, mi, s] = mt;
    iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${s ?? '00'}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)) {
    iso = trimmed.replace(' ', 'T') + (trimmed.endsWith('Z') ? '' : 'Z');
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function findHeaderRow(rows: string[][]): { index: number; headers: string[] } | null {
  // Pick the first row whose columns map at least 3 canonical fields including
  // a side/type column AND a symbol column. Skips MT4 statement preamble rows
  // ("Account:", "Currency:", etc.) and HTML/CSV title rows.
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const r = rows[i];
    if (r.length < 3) continue;
    const map = buildColumnMap(r);
    if (map.has('side') && map.has('symbol') && map.size >= 3) {
      return { index: i, headers: r };
    }
  }
  return null;
}

export function parseStatement(text: string): ParseResult {
  const format = detectFormat(text);
  const rows = parseCsv(text, { delimiter: 'auto' });
  const trades: ParsedTrade[] = [];
  const errors: RowError[] = [];

  const header = findHeaderRow(rows);
  if (!header) {
    return {
      format,
      trades: [],
      errors: [{ row: 0, message: 'Could not locate a recognisable trade history header.' }],
    };
  }

  const cols = buildColumnMap(header.headers);
  const get = (row: string[], key: string): string | undefined => {
    const idx = cols.get(key);
    return idx == null ? undefined : row[idx];
  };

  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i];
    // Skip MT4/MT5 "balance" / "credit" / summary rows.
    const rawSide = get(row, 'side') ?? '';
    const side = parseSide(rawSide);
    if (!side) continue;

    try {
      const externalId = (get(row, 'externalId') ?? '').trim();
      if (!externalId) {
        errors.push({ row: i + 1, message: 'Missing ticket / position ID' });
        continue;
      }
      const symbol = (get(row, 'symbol') ?? '').trim().toUpperCase();
      if (!symbol) {
        errors.push({ row: i + 1, message: 'Missing symbol' });
        continue;
      }
      const entryPrice = parseNumber(get(row, 'entryPrice'));
      const volume = parseNumber(get(row, 'volume'));
      const entryAt = parseDate(get(row, 'entryAt'));
      if (entryPrice == null || entryPrice <= 0) {
        errors.push({ row: i + 1, message: 'Entry price missing or non-positive' });
        continue;
      }
      if (volume == null || volume <= 0) {
        errors.push({ row: i + 1, message: 'Volume missing or non-positive' });
        continue;
      }
      if (!entryAt) {
        errors.push({ row: i + 1, message: 'Entry time missing or unparseable' });
        continue;
      }

      const exitPrice = parseNumber(get(row, 'exitPrice'));
      const exitAt = parseDate(get(row, 'exitAt'));
      // A trade is "closed" when both exit price and exit time are present.
      // MT5 sometimes reports an exit price for stop-out positions without
      // a matching time — treat as open until both arrive.
      const closed = exitPrice != null && exitPrice > 0 && exitAt != null;

      trades.push({
        externalId,
        symbol,
        side,
        entryPrice,
        exitPrice: closed ? exitPrice : null,
        volume,
        pnl: closed ? parseNumber(get(row, 'pnl')) : null,
        commission: parseNumber(get(row, 'commission')),
        swap: parseNumber(get(row, 'swap')),
        stopLoss: parseNumber(get(row, 'stopLoss')),
        takeProfit: parseNumber(get(row, 'takeProfit')),
        entryAt,
        exitAt: closed ? exitAt : null,
        status: closed ? 'CLOSED' : 'OPEN',
      });
    } catch (e) {
      errors.push({ row: i + 1, message: (e as Error).message });
    }
  }

  return { format, trades, errors };
}
