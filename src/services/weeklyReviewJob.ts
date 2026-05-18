// Weekly AI review email job.
//
// Finds every user who closed at least one trade in the last 7 days, runs the
// AI weekly review (which persists an AiInsight and reuses the configured LLM
// provider / deterministic fallback), and emails them an on-brand summary.
//
// Users with no recent activity are skipped so the job never sends an empty
// "you traded 0 times" email.

import { prisma } from '../config/db';
import { logger } from '../utils/logger';
import { runWeeklyReview } from './aiService';
import { sendWeeklyReviewEmail } from '../utils/email';

export async function sendWeeklyReviewForUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });
  if (!user?.email) return false;

  const review = await runWeeklyReview(userId);
  return sendWeeklyReviewEmail(user.email, user.name ?? '', review.summary, {
    totalClosed: review.stats.totalClosed,
    totalPnL: review.stats.totalPnL,
    winRate: review.stats.winRate,
    profitFactor: review.stats.profitFactor,
  });
}

export async function sendWeeklyReviews(): Promise<number> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const recent = await prisma.trade.findMany({
    where: { status: 'CLOSED', exitAt: { gte: since }, account: { user: { is: {} } } },
    select: { account: { select: { userId: true } } },
    distinct: ['accountId'],
  });

  const userIds = [...new Set(recent.map((r) => r.account.userId))];
  if (userIds.length === 0) {
    logger.info('Weekly review job: no users with recent activity — nothing to send');
    return 0;
  }

  let sent = 0;
  for (const userId of userIds) {
    try {
      if (await sendWeeklyReviewForUser(userId)) sent++;
    } catch (err) {
      logger.error(`Weekly review failed for user ${userId}: ${(err as Error).message}`);
    }
  }
  logger.info(`Weekly review job: sent ${sent}/${userIds.length} review email(s)`);
  return sent;
}
