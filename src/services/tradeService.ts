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
  return prisma.trade.create({ data });
}

export async function getTrades(userId: string, accountId?: string) {
  // Build account filter — if accountId given, verify ownership first
  if (accountId) {
    await verifyAccountOwnership(userId, accountId);
  }

  return prisma.trade.findMany({
    where: {
      account: { userId },
      ...(accountId ? { accountId } : {}),
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
  await verifyTradeOwnership(userId, tradeId);
  return prisma.trade.update({ where: { id: tradeId }, data });
}

export async function deleteTrade(userId: string, tradeId: string) {
  await verifyTradeOwnership(userId, tradeId);
  await prisma.trade.delete({ where: { id: tradeId } });
}
