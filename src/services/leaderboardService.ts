import { prisma } from '../config/db';

export type LeaderboardMetric = 'consistency' | 'rMultiple' | 'winRate' | 'profitFactor';
export type LeaderboardPeriod = 'week' | 'month' | 'allTime';

function periodStartDate(period: LeaderboardPeriod): Date | undefined {
  if (period === 'allTime') return undefined;
  const now = new Date();
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  const d = new Date(now);
  d.setMonth(d.getMonth() - 1);
  return d;
}

/** Compute metric score for a single user's closed trades in the time window */
function computeScore(
  trades: { pnl: number | null; stopLoss: number | null; entryPrice: number; volume: number }[],
  metric: LeaderboardMetric,
): number {
  const closed = trades.filter((t) => t.pnl !== null);
  if (closed.length === 0) return 0;

  if (metric === 'winRate') {
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    return Math.round((wins / closed.length) * 1000) / 10; // 0-100
  }

  if (metric === 'profitFactor') {
    const grossProfit = closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(closed.filter((t) => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl ?? 0), 0));
    if (grossLoss === 0) return grossProfit > 0 ? 99.9 : 0;
    return Math.round((grossProfit / grossLoss) * 100) / 100;
  }

  if (metric === 'rMultiple') {
    const rValues = closed
      .map((t) => {
        if (!t.stopLoss || t.stopLoss === 0) return null;
        const risk = Math.abs(t.entryPrice - t.stopLoss) * t.volume;
        if (risk === 0) return null;
        return (t.pnl ?? 0) / risk;
      })
      .filter((r): r is number => r !== null);
    if (rValues.length === 0) return 0;
    const avg = rValues.reduce((s, r) => s + r, 0) / rValues.length;
    return Math.round(avg * 100) / 100;
  }

  // consistency: % of trading days with positive PnL
  if (metric === 'consistency') {
    const byDay = new Map<string, number>();
    for (const t of closed) {
      // we don't have exitAt here — use a day grouping approximation
      const key = 'day'; // will be refined with actual dates below
      byDay.set(key, (byDay.get(key) ?? 0) + (t.pnl ?? 0));
    }
    // fallback: treat each trade as a separate "day" for simple ratio
    const profitable = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    return Math.round((profitable / closed.length) * 1000) / 10;
  }

  return 0;
}

/** Compute consistency properly using trade exitAt dates */
async function computeConsistency(userId: string, since?: Date): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: {
      account: { userId },
      status: 'CLOSED',
      pnl: { not: null },
      ...(since ? { exitAt: { gte: since } } : {}),
    },
    select: { exitAt: true, pnl: true },
  });

  if (trades.length === 0) return 0;

  const byDay = new Map<string, number>();
  for (const t of trades) {
    const key = t.exitAt ? t.exitAt.toISOString().split('T')[0] : 'unknown';
    byDay.set(key, (byDay.get(key) ?? 0) + (t.pnl ?? 0));
  }

  const days = Array.from(byDay.values());
  const profitable = days.filter((d) => d > 0).length;
  return Math.round((profitable / days.length) * 1000) / 10;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatar: string | null;
  score: number;
  tradeCount: number;
  isCurrentUser: boolean;
}

export async function getLeaderboard(
  currentUserId: string,
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
): Promise<LeaderboardEntry[]> {
  const since = periodStartDate(period);

  // Get all opted-in users
  const users = await prisma.user.findMany({
    where: { showOnLeaderboard: true },
    select: { id: true, name: true, avatar: true },
  });

  const entries: LeaderboardEntry[] = [];

  for (const user of users) {
    const trades = await prisma.trade.findMany({
      where: {
        account: { userId: user.id },
        status: 'CLOSED',
        pnl: { not: null },
        ...(since ? { exitAt: { gte: since } } : {}),
      },
      select: { pnl: true, stopLoss: true, entryPrice: true, volume: true },
    });

    let score: number;
    if (metric === 'consistency') {
      score = await computeConsistency(user.id, since);
    } else {
      score = computeScore(trades, metric);
    }

    entries.push({
      rank: 0,
      userId: user.id,
      displayName: user.name ?? 'Trader',
      avatar: user.avatar,
      score,
      tradeCount: trades.length,
      isCurrentUser: user.id === currentUserId,
    });
  }

  // Sort descending by score
  entries.sort((a, b) => b.score - a.score);
  entries.forEach((e, i) => (e.rank = i + 1));

  return entries;
}

export async function setLeaderboardVisibility(userId: string, show: boolean): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { showOnLeaderboard: show } });
}

export async function getLeaderboardStatus(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { showOnLeaderboard: true } });
  return user?.showOnLeaderboard ?? false;
}
