import { TradeSide, TradeStatus, InstrumentType } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

export interface CreateTradeInput {
  accountId: string;
  symbol: string;
  instrumentType?: InstrumentType;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  volume: number;
  pnl?: number;
  commission?: number;
  swap?: number;
  stopLoss?: number;
  takeProfit?: number;
  setup?: string;
  notes?: string;
  tags?: string[];
  status?: TradeStatus;
  entryAt: Date;
  exitAt?: Date;
}

export interface UpdateTradeInput {
  symbol?: string;
  instrumentType?: InstrumentType;
  side?: TradeSide;
  entryPrice?: number;
  exitPrice?: number;
  volume?: number;
  pnl?: number;
  commission?: number;
  swap?: number;
  stopLoss?: number;
  takeProfit?: number;
  setup?: string;
  notes?: string;
  tags?: string[];
  status?: TradeStatus;
  entryAt?: Date;
  exitAt?: Date;
}

/** Verify the account belongs to the user; throw 403 if not. */
async function verifyAccountOwnership(userId: string, accountId: string): Promise<void> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new AppError('Account not found', 404);
  if (account.userId !== userId) throw new AppError('Forbidden', 403);
}

// Trade entry is gated by the per-challenge lock: any ACTIVE challenge bound
// to the account with tradingLocked=true blocks new trades on that account.
// Accounts not bound to any challenge are unaffected.
async function assertAccountNotLocked(accountId: string): Promise<void> {
  const locked = await prisma.challenge.findFirst({
    where: { accountId, status: 'ACTIVE', tradingLocked: true },
    select: { id: true, firmName: true },
  });
  if (locked) {
    throw new AppError(
      `Trading is locked on the ${locked.firmName} challenge bound to this account`,
      423, // Locked
    );
  }
}

/** Verify the trade exists and belongs to the user (via its account). */
async function verifyTradeOwnership(userId: string, tradeId: string) {
  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: { account: { select: { userId: true } } },
  });
  if (!trade) throw new AppError('Trade not found', 404);
  if (trade.account.userId !== userId) throw new AppError('Forbidden', 403);
  return trade;
}

export async function createTrade(userId: string, data: CreateTradeInput) {
  await verifyAccountOwnership(userId, data.accountId);
  await assertAccountNotLocked(data.accountId);
  return prisma.trade.create({ data });
}

export async function getTrades(userId: string, accountIds?: string[]) {
  // Security: ownership is enforced implicitly — Prisma's `account: { userId }`
  // filter ensures only the requesting user's trades are returned regardless of
  // which accountIds are supplied. No separate ownership loop needed.
  const hasFilter = accountIds && accountIds.length > 0;

  return prisma.trade.findMany({
    where: {
      account: { userId },
      ...(hasFilter ? { accountId: { in: accountIds } } : {}),
    },
    orderBy: { entryAt: 'desc' },
    include: { account: { select: { id: true, name: true } } },
  });
}

export async function getTradeById(userId: string, tradeId: string) {
  const trade = await verifyTradeOwnership(userId, tradeId);
  return trade;
}

export async function updateTrade(userId: string, tradeId: string, data: UpdateTradeInput) {
  const trade = await verifyTradeOwnership(userId, tradeId);
  await assertAccountNotLocked(trade.accountId);
  return prisma.trade.update({ where: { id: tradeId }, data });
}

export async function deleteTrade(userId: string, tradeId: string) {
  await verifyTradeOwnership(userId, tradeId);
  await prisma.trade.delete({ where: { id: tradeId } });
}
