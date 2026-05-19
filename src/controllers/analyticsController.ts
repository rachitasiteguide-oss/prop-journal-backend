import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getTrades } from '../services/tradeService';
import {
  computeEquityCurve,
  computeDailyHeatmap,
} from '../services/analyticsService';

function parseAccountIds(raw: unknown): string[] | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return (raw as string[]).map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

const equityQuerySchema = z.object({
  startingBalance: z.coerce.number().min(0).max(1e12).default(0),
  tz: z.string().min(1).max(64).optional(),
});

export async function getEquityCurveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { startingBalance, tz } = equityQuerySchema.parse(req.query);
    const accountIds = parseAccountIds(req.query.accountIds);
    const trades = await getTrades(req.currentUser!.userId, accountIds);
    const curve = computeEquityCurve(trades, startingBalance, tz);
    res.json({ status: 'success', data: curve });
  } catch (error) {
    next(error);
  }
}

const heatmapQuerySchema = z.object({
  tz: z.string().min(1).max(64).optional(),
});

export async function getHeatmapHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { tz } = heatmapQuerySchema.parse(req.query);
    const accountIds = parseAccountIds(req.query.accountIds);
    const trades = await getTrades(req.currentUser!.userId, accountIds);
    const days = computeDailyHeatmap(trades, tz);
    res.json({ status: 'success', data: days });
  } catch (error) {
    next(error);
  }
}
