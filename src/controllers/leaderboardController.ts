import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getLeaderboard,
  setLeaderboardVisibility,
  getLeaderboardStatus,
  LeaderboardMetric,
  LeaderboardPeriod,
} from '../services/leaderboardService';

const querySchema = z.object({
  metric: z.enum(['consistency', 'rMultiple', 'winRate', 'profitFactor']).default('consistency'),
  period: z.enum(['week', 'month', 'allTime']).default('week'),
});

export async function getLeaderboardHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { metric, period } = querySchema.parse(req.query);
    const data = await getLeaderboard(
      req.currentUser!.userId,
      metric as LeaderboardMetric,
      period as LeaderboardPeriod,
    );
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

export async function getLeaderboardStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visible = await getLeaderboardStatus(req.currentUser!.userId);
    res.json({ status: 'success', data: { showOnLeaderboard: visible } });
  } catch (error) {
    next(error);
  }
}

export async function updateLeaderboardVisibilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { show } = z.object({ show: z.boolean() }).parse(req.body);
    await setLeaderboardVisibility(req.currentUser!.userId, show);
    res.json({ status: 'success', data: { showOnLeaderboard: show } });
  } catch (error) {
    next(error);
  }
}
