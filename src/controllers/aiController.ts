import { Request, Response, NextFunction } from 'express';
import {
  runPatternScan,
  runWeeklyReview,
  getLatestInsight,
} from '../services/aiService';
import { sendWeeklyReviewForUser } from '../services/weeklyReviewJob';

export async function patternScanHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await runPatternScan(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

export async function getPatternScanHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getLatestInsight(req.currentUser!.userId, 'PATTERN_SCAN');
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

export async function weeklyReviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await runWeeklyReview(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

export async function getWeeklyReviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getLatestInsight(req.currentUser!.userId, 'WEEKLY_REVIEW');
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

// Generates this week's review and emails it to the requesting user only.
// Safe to expose (user-scoped) and used for live verification of the email path.
export async function sendWeeklyReviewEmailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sent = await sendWeeklyReviewForUser(req.currentUser!.userId);
    res.json({ status: 'success', data: { sent } });
  } catch (error) {
    next(error);
  }
}
