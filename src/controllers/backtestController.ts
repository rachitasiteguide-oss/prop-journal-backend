import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/backtestService';

const createSessionSchema = z.object({
  name: z.string().min(1).max(120),
  symbol: z.string().min(1).max(20),
  instrumentType: z.string().optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  startingBalance: z.number().positive().optional(),
  notes: z.string().max(500).optional(),
});

const updateSessionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'PAUSED']).optional(),
  notes: z.string().max(500).optional(),
});

const addTradeSchema = z.object({
  symbol: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  entryPrice: z.number().positive(),
  exitPrice: z.number().positive().optional(),
  volume: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  entryAt: z.string().datetime(),
  exitAt: z.string().datetime().optional(),
  notes: z.string().max(500).optional(),
});

const updateTradeSchema = z.object({
  exitPrice: z.number().positive().optional(),
  exitAt: z.string().datetime().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  notes: z.string().max(500).optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});

export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSessions(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function getSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSession(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function createSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = createSessionSchema.parse(req.body);
    const data = await svc.createSession(req.currentUser!.userId, {
      ...body,
      startDate: new Date(body.startDate),
      endDate: new Date(body.endDate),
    });
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function updateSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = updateSessionSchema.parse(req.body);
    const data = await svc.updateSession(req.currentUser!.userId, String(req.params.id), body);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function deleteSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteSession(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', message: 'Session deleted' });
  } catch (e) { next(e); }
}

export async function getAnalyticsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSessionAnalytics(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function addTradeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = addTradeSchema.parse(req.body);
    const data = await svc.addTrade(req.currentUser!.userId, String(req.params.id), {
      ...body,
      entryAt: new Date(body.entryAt),
      exitAt: body.exitAt ? new Date(body.exitAt) : undefined,
    });
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function updateTradeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = updateTradeSchema.parse(req.body);
    const data = await svc.updateTrade(
      req.currentUser!.userId,
      String(req.params.id),
      String(req.params.tradeId),
      { ...body, exitAt: body.exitAt ? new Date(body.exitAt) : undefined },
    );
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function deleteTradeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteTrade(req.currentUser!.userId, String(req.params.id), String(req.params.tradeId));
    res.json({ status: 'success', message: 'Trade deleted' });
  } catch (e) { next(e); }
}
