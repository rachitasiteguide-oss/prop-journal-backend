import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { TradeSide, TradeStatus, InstrumentType } from '@prisma/client';
import {
  createTrade,
  getTrades,
  getTradeById,
  updateTrade,
  deleteTrade,
} from '../services/tradeService';

const createTradeSchema = z.object({
  accountId: z.string().cuid('Invalid account ID'),
  symbol: z.string().min(1).max(20).transform((v) => v.toUpperCase()),
  instrumentType: z.nativeEnum(InstrumentType).optional(),
  side: z.nativeEnum(TradeSide),
  entryPrice: z.number().positive(),
  exitPrice: z.number().positive().optional(),
  volume: z.number().positive(),
  pnl: z.number().optional(),
  commission: z.number().optional(),
  swap: z.number().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  setup: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).optional(),
  status: z.nativeEnum(TradeStatus).optional(),
  entryAt: z.coerce.date(),
  exitAt: z.coerce.date().optional(),
});

const updateTradeSchema = createTradeSchema.omit({ accountId: true }).partial();

export async function createTradeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = createTradeSchema.parse(req.body);
    const trade = await createTrade(req.currentUser!.userId, data);
    res.status(201).json({ status: 'success', data: trade });
  } catch (error) {
    next(error);
  }
}

export async function getTradesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const accountId =
      typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    const trades = await getTrades(req.currentUser!.userId, accountId);
    res.json({ status: 'success', data: trades });
  } catch (error) {
    next(error);
  }
}

export async function getTradeByIdHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const trade = await getTradeById(req.currentUser!.userId, req.params.id);
    res.json({ status: 'success', data: trade });
  } catch (error) {
    next(error);
  }
}

export async function updateTradeHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = updateTradeSchema.parse(req.body);
    const trade = await updateTrade(req.currentUser!.userId, req.params.id, data);
    res.json({ status: 'success', data: trade });
  } catch (error) {
    next(error);
  }
}

export async function deleteTradeHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await deleteTrade(req.currentUser!.userId, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
