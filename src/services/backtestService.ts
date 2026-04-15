import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { BacktestStatus, TradeSide, TradeStatus } from '@prisma/client';

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function getSessions(userId: string) {
  return prisma.backtestSession.findMany({
    where: { userId },
    include: { trades: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getSession(userId: string, id: string) {
  const session = await prisma.backtestSession.findFirst({
    where: { id, userId },
    include: { trades: { orderBy: { entryAt: 'asc' } } },
  });
  if (!session) throw new AppError('Session not found', 404);
  return session;
}

export async function createSession(userId: string, data: {
  name: string; symbol: string; instrumentType?: string;
  startDate: Date; endDate: Date; startingBalance?: number; notes?: string;
}) {
  return prisma.backtestSession.create({
    data: {
      userId,
      name: data.name,
      symbol: data.symbol,
      instrumentType: data.instrumentType ?? 'FOREX',
      startDate: data.startDate,
      endDate: data.endDate,
      startingBalance: data.startingBalance ?? 10000,
      currentBalance: data.startingBalance ?? 10000,
      notes: data.notes ?? null,
    },
    include: { trades: true },
  });
}

export async function updateSession(userId: string, id: string, data: {
  name?: string; status?: BacktestStatus; notes?: string;
}) {
  const existing = await prisma.backtestSession.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError('Session not found', 404);
  return prisma.backtestSession.update({ where: { id }, data, include: { trades: true } });
}

export async function deleteSession(userId: string, id: string) {
  const existing = await prisma.backtestSession.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError('Session not found', 404);
  await prisma.backtestSession.delete({ where: { id } });
}

// ── Trades ───────────────────────────────────────────────────────────────────

export async function addTrade(userId: string, sessionId: string, data: {
  symbol: string; side: TradeSide; entryPrice: number; exitPrice?: number;
  volume?: number; stopLoss?: number; takeProfit?: number; entryAt: Date;
  exitAt?: Date; notes?: string;
}) {
  // Verify session belongs to user
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  // Calculate P&L if exit price provided
  let pnl: number | null = null;
  let pnlPct: number | null = null;
  let status: TradeStatus = 'OPEN';

  if (data.exitPrice != null && data.exitPrice > 0) {
    const direction = data.side === 'BUY' ? 1 : -1;
    const priceDiff = (data.exitPrice - data.entryPrice) * direction;
    pnl = parseFloat((priceDiff * (data.volume ?? 1) * 100000 * 10 / 100000).toFixed(2));
    pnlPct = parseFloat(((pnl / session.startingBalance) * 100).toFixed(4));
    status = 'CLOSED';
  }

  const trade = await prisma.backtestTrade.create({
    data: {
      sessionId,
      symbol: data.symbol,
      side: data.side,
      entryPrice: data.entryPrice,
      exitPrice: data.exitPrice ?? null,
      volume: data.volume ?? 1,
      stopLoss: data.stopLoss ?? null,
      takeProfit: data.takeProfit ?? null,
      pnl,
      pnlPct,
      status,
      entryAt: data.entryAt,
      exitAt: data.exitAt ?? null,
      notes: data.notes ?? null,
    },
  });

  // Update session current balance
  if (pnl !== null) {
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { increment: pnl } },
    });
  }

  return trade;
}

export async function updateTrade(userId: string, sessionId: string, tradeId: string, data: {
  exitPrice?: number; exitAt?: Date; stopLoss?: number; takeProfit?: number; notes?: string; status?: TradeStatus;
}) {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  const trade = await prisma.backtestTrade.findFirst({ where: { id: tradeId, sessionId } });
  if (!trade) throw new AppError('Trade not found', 404);

  let pnl = trade.pnl;
  let pnlPct = trade.pnlPct;
  let status = data.status ?? trade.status;

  if (data.exitPrice != null && trade.exitPrice == null) {
    const direction = trade.side === 'BUY' ? 1 : -1;
    const priceDiff = (data.exitPrice - trade.entryPrice) * direction;
    const newPnl = parseFloat((priceDiff * trade.volume * 100000 * 10 / 100000).toFixed(2));
    const newPnlPct = parseFloat(((newPnl / session.startingBalance) * 100).toFixed(4));
    pnl = newPnl;
    pnlPct = newPnlPct;
    status = 'CLOSED';
    // Update balance
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { increment: newPnl } },
    });
  }

  return prisma.backtestTrade.update({
    where: { id: tradeId },
    data: { ...data, pnl, pnlPct, status },
  });
}

export async function bulkAddTrades(userId: string, sessionId: string, trades: Array<{
  symbol: string; side: TradeSide; entryPrice: number; exitPrice?: number;
  volume?: number; stopLoss?: number; takeProfit?: number; entryAt: Date;
  exitAt?: Date; notes?: string;
}>) {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);

  let balanceDelta = 0;
  const created = [];

  for (const data of trades) {
    let pnl: number | null = null;
    let pnlPct: number | null = null;
    let status: TradeStatus = 'OPEN';

    if (data.exitPrice != null && data.exitPrice > 0) {
      const direction = data.side === 'BUY' ? 1 : -1;
      const priceDiff = (data.exitPrice - data.entryPrice) * direction;
      pnl = parseFloat((priceDiff * (data.volume ?? 1) * 100000 * 10 / 100000).toFixed(2));
      pnlPct = parseFloat(((pnl / session.startingBalance) * 100).toFixed(4));
      status = 'CLOSED';
      balanceDelta += pnl;
    }

    const trade = await prisma.backtestTrade.create({
      data: {
        sessionId,
        symbol: data.symbol,
        side: data.side,
        entryPrice: data.entryPrice,
        exitPrice: data.exitPrice ?? null,
        volume: data.volume ?? 1,
        stopLoss: data.stopLoss ?? null,
        takeProfit: data.takeProfit ?? null,
        pnl,
        pnlPct,
        status,
        entryAt: data.entryAt,
        exitAt: data.exitAt ?? null,
        notes: data.notes ?? null,
      },
    });
    created.push(trade);
  }

  if (balanceDelta !== 0) {
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { increment: balanceDelta } },
    });
  }

  return created;
}

export async function deleteTrade(userId: string, sessionId: string, tradeId: string) {
  const session = await prisma.backtestSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new AppError('Session not found', 404);
  const trade = await prisma.backtestTrade.findFirst({ where: { id: tradeId, sessionId } });
  if (!trade) throw new AppError('Trade not found', 404);

  // Reverse balance if trade was closed
  if (trade.pnl !== null) {
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: { currentBalance: { decrement: trade.pnl } },
    });
  }
  await prisma.backtestTrade.delete({ where: { id: tradeId } });
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export async function getSessionAnalytics(userId: string, sessionId: string) {
  const session = await getSession(userId, sessionId);
  const trades = session.trades.filter((t) => t.status === 'CLOSED');

  const totalTrades = trades.length;
  const winners = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losers = trades.filter((t) => (t.pnl ?? 0) < 0);
  const breakeven = trades.filter((t) => (t.pnl ?? 0) === 0);

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + (t.pnl ?? 0), 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + (t.pnl ?? 0), 0) / losers.length : 0;
  const bestWin = winners.length > 0 ? Math.max(...winners.map((t) => t.pnl ?? 0)) : 0;
  const worstLoss = losers.length > 0 ? Math.min(...losers.map((t) => t.pnl ?? 0)) : 0;

  const profitFactor = Math.abs(avgLoss) > 0 ? Math.abs(avgWin * winners.length) / Math.abs(avgLoss * losers.length) : 0;

  // Equity curve
  let runningBalance = session.startingBalance;
  const equityCurve = [{ date: session.startDate.toISOString(), balance: runningBalance }];
  for (const t of trades) {
    runningBalance += t.pnl ?? 0;
    equityCurve.push({ date: (t.exitAt ?? t.entryAt).toISOString(), balance: parseFloat(runningBalance.toFixed(2)) });
  }

  // Drawdown
  let peak = session.startingBalance;
  let maxDrawdown = 0;
  for (const pt of equityCurve) {
    if (pt.balance > peak) peak = pt.balance;
    const dd = ((peak - pt.balance) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Performance by day of week
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = dayLabels.map((day, i) => {
    const dayTrades = trades.filter((t) => {
      const d = new Date(t.exitAt ?? t.entryAt).getDay();
      const mapped = d === 0 ? 6 : d - 1; // convert Sun=0 to Mon=0 index
      return mapped === i;
    });
    const pnl = dayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return { day, pnl: parseFloat(pnl.toFixed(2)), trades: dayTrades.length };
  });

  // Performance by hour
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const hourTrades = trades.filter((t) => new Date(t.exitAt ?? t.entryAt).getHours() === h);
    const pnl = hourTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return { hour: h, pnl: parseFloat(pnl.toFixed(2)), trades: hourTrades.length };
  }).filter((h) => h.trades > 0);

  // Buy vs Sell
  const buyTrades = trades.filter((t) => t.side === 'BUY');
  const sellTrades = trades.filter((t) => t.side === 'SELL');
  const bySide = {
    buy: { trades: buyTrades.length, winRate: buyTrades.length > 0 ? (buyTrades.filter(t => (t.pnl ?? 0) > 0).length / buyTrades.length) * 100 : 0, pnl: buyTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) },
    sell: { trades: sellTrades.length, winRate: sellTrades.length > 0 ? (sellTrades.filter(t => (t.pnl ?? 0) > 0).length / sellTrades.length) * 100 : 0, pnl: sellTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) },
  };

  // Performance by month
  const byMonth: Record<string, { pnl: number; trades: number }> = {};
  for (const t of trades) {
    const key = new Date(t.exitAt ?? t.entryAt).toISOString().slice(0, 7);
    if (!byMonth[key]) byMonth[key] = { pnl: 0, trades: 0 };
    byMonth[key].pnl += t.pnl ?? 0;
    byMonth[key].trades += 1;
  }

  // Duration stats
  const avgDuration = trades.length > 0 ? trades.reduce((s, t) => {
    if (!t.exitAt) return s;
    return s + (new Date(t.exitAt).getTime() - new Date(t.entryAt).getTime());
  }, 0) / trades.length / 1000 / 60 : 0; // in minutes

  return {
    session: { ...session, trades: undefined },
    trades: session.trades,
    metrics: {
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      totalPnlPct: parseFloat(((totalPnl / session.startingBalance) * 100).toFixed(2)),
      currentBalance: parseFloat(session.currentBalance.toFixed(2)),
      winRate: parseFloat(winRate.toFixed(2)),
      totalTrades,
      winners: winners.length,
      losers: losers.length,
      breakeven: breakeven.length,
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      bestWin: parseFloat(bestWin.toFixed(2)),
      worstLoss: parseFloat(worstLoss.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      avgDurationMinutes: parseFloat(avgDuration.toFixed(0)),
    },
    equityCurve,
    byDay,
    byHour,
    bySide,
    byMonth,
  };
}
