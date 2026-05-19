// ─────────────────────────────────────────────────────────────────────────────
// Dashboard analytics computed server-side from real trade data.
//
// Pure functions only (no Prisma / I/O) so they are unit-testable and the
// controller stays a thin fetch-then-compute shim.
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeForAnalytics {
  status: 'OPEN' | 'CLOSED';
  pnl: number | null;
  commission: number | null;
  swap: number | null;
  entryAt: Date | string;
  exitAt: Date | string | null;
}

/** Net P&L for a single trade, after commission and swap. */
export function netPnl(t: TradeForAnalytics): number {
  return (t.pnl ?? 0) - (t.commission ?? 0) - (t.swap ?? 0);
}

/**
 * Day key for a trade. A closed trade lands on its exit day, an open one on
 * its entry day. `tz` is an IANA zone (e.g. "America/New_York"); when omitted
 * the boundary is UTC. This keeps the heatmap/equity buckets aligned to the
 * trader's local trading day rather than UTC midnight.
 */
export function tradeDayKey(t: TradeForAnalytics, tz?: string): string {
  return dayKey(t.exitAt ?? t.entryAt, tz);
}

/** YYYY-MM-DD for an instant in the given IANA timezone (UTC if omitted). */
export function dayKey(value: Date | string, tz?: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!tz) return d.toISOString().slice(0, 10);
  // en-CA gives an ISO-like YYYY-MM-DD; the formatter applies the zone offset.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export interface EquityPoint {
  date: string;
  /** Account equity = startingBalance + cumulative net P&L. */
  equity: number;
  /** Cumulative net P&L from zero. */
  cumulative: number;
  /** Net P&L realised on this day. */
  pnl: number;
  /** Peak-to-current equity drawdown in currency (>= 0). */
  drawdown: number;
  /** Drawdown as a percentage of the running peak equity (>= 0). */
  drawdownPct: number;
}

export interface EquityCurve {
  startingBalance: number;
  points: EquityPoint[];
  summary: {
    netPnL: number;
    finalEquity: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    tradingDays: number;
  };
}

/**
 * Build a daily equity curve from closed trades. Points are sorted ascending;
 * an empty trade set yields an empty curve (the frontend renders an empty
 * state rather than a flat line).
 */
export function computeEquityCurve(
  trades: TradeForAnalytics[],
  startingBalance = 0,
  tz?: string,
): EquityCurve {
  const closed = trades.filter((t) => t.status === 'CLOSED');

  const byDay = new Map<string, number>();
  for (const t of closed) {
    const k = tradeDayKey(t, tz);
    byDay.set(k, (byDay.get(k) ?? 0) + netPnl(t));
  }

  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  let cumulative = 0;
  let peakEquity = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const points: EquityPoint[] = days.map(([date, dayPnl]) => {
    cumulative += dayPnl;
    const equity = startingBalance + cumulative;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    const drawdownPct = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
    return {
      date,
      equity,
      cumulative,
      pnl: dayPnl,
      drawdown,
      drawdownPct,
    };
  });

  return {
    startingBalance,
    points,
    summary: {
      netPnL: cumulative,
      finalEquity: startingBalance + cumulative,
      maxDrawdown,
      maxDrawdownPct,
      tradingDays: points.length,
    },
  };
}

export interface HeatmapDay {
  date: string;
  pnl: number;
  tradeCount: number;
}

/**
 * Per-day net P&L keyed by the trader's local day. Returns only days that
 * actually had closed trades — the frontend fills the calendar grid and renders
 * a neutral cell for any day not present here (a true no-trade day).
 */
export function computeDailyHeatmap(
  trades: TradeForAnalytics[],
  tz?: string,
): HeatmapDay[] {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const map = new Map<string, HeatmapDay>();
  for (const t of closed) {
    const date = tradeDayKey(t, tz);
    const cur = map.get(date) ?? { date, pnl: 0, tradeCount: 0 };
    cur.pnl += netPnl(t);
    cur.tradeCount += 1;
    map.set(date, cur);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
