// Weekly review scheduler.
//
// Mirrors the orphanRunSweeper pattern: a single unref'd interval, no external
// cron dependency. Ticks hourly and fires sendWeeklyReviews() once per ISO
// week, at SEND_DAY / SEND_HOUR (UTC). An in-memory week-key guard prevents
// double-sends within a process; on a fresh deploy mid-week the guard resets,
// so the send window is intentionally a single hour to keep restart-induced
// duplicates impossible in practice.

import { logger } from '../utils/logger';
import { sendWeeklyReviews } from './weeklyReviewJob';

const TICK_MS = 60 * 60 * 1000; // hourly
const SEND_DAY = 1; // Monday (0 = Sunday)
const SEND_HOUR = 13; // 13:00 UTC

let timer: NodeJS.Timeout | null = null;
let lastSentWeekKey: string | null = null;

// ISO-ish week key: <year>-W<weekNumber>. Stable within a calendar week.
function weekKey(d: Date): string {
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - onejan.getTime()) / 86400000 + onejan.getUTCDay() + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${week}`;
}

async function tick(): Promise<void> {
  const now = new Date();
  if (now.getUTCDay() !== SEND_DAY || now.getUTCHours() !== SEND_HOUR) return;

  const key = weekKey(now);
  if (key === lastSentWeekKey) return;
  lastSentWeekKey = key;

  logger.info(`Weekly review scheduler: firing for ${key}`);
  try {
    await sendWeeklyReviews();
  } catch (err) {
    logger.error('Weekly review scheduler run failed:', err);
  }
}

export function startWeeklyReviewScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => logger.error('Weekly review tick failed:', err));
  }, TICK_MS);
  timer.unref();
  logger.info('Weekly review scheduler started');
}

export function stopWeeklyReviewScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
