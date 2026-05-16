// Orphan-run sweeper.
//
// A backtest session can be stuck in `runStatus = RUNNING` forever if:
//   - the worker thread crashed without posting a `complete` message,
//   - the Node process was killed (OOM, redeploy) mid-run,
//   - the fire-and-forget `triggerRun` promise rejected before runStatus was
//     written but the session row never got back to FAILED.
//
// All three modes are silent: the user polls /run/status, sees RUNNING, and
// can't retry because the session never resolves.
//
// This sweeper runs on an interval, finds sessions whose `runStartedAt` is
// older than MAX_RUN_DURATION_MS, and flips them to FAILED with a clear
// error message so the user can retry.

import { prisma } from '../config/db';
import { logger } from '../utils/logger';

const SWEEP_INTERVAL_MS  = 60 * 1000;       // check every minute
const MAX_RUN_DURATION_MS = 10 * 60 * 1000; // any run >10 min is orphaned

let timer: NodeJS.Timeout | null = null;

export async function sweepOrphanRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - MAX_RUN_DURATION_MS);

  const orphans = await prisma.backtestSession.findMany({
    where: {
      runStatus: 'RUNNING',
      OR: [
        { runStartedAt: { lt: cutoff } },
        { runStartedAt: null }, // belt and braces — RUNNING without a start time is definitionally stuck
      ],
    },
    select: { id: true, runStartedAt: true },
  });

  if (orphans.length === 0) return 0;

  const ids = orphans.map((s) => s.id);
  await prisma.backtestSession.updateMany({
    where: { id: { in: ids } },
    data: {
      runStatus: 'FAILED',
      runError: `Run did not complete within ${MAX_RUN_DURATION_MS / 60_000} minutes. The worker may have crashed or the process restarted. Retry the run.`,
      runCompletedAt: new Date(),
    },
  });

  logger.warn(`Orphan-run sweeper: marked ${orphans.length} stuck session(s) as FAILED: ${ids.join(', ')}`);
  return orphans.length;
}

export function startOrphanRunSweeper(): void {
  if (timer) return;
  // Run once on startup to clear anything stuck from a previous process.
  sweepOrphanRuns().catch((err) => {
    logger.error('Orphan-run sweep (startup) failed:', err);
  });
  timer = setInterval(() => {
    sweepOrphanRuns().catch((err) => {
      logger.error('Orphan-run sweep failed:', err);
    });
  }, SWEEP_INTERVAL_MS);
  // Don't block process exit on this timer.
  timer.unref();
}

export function stopOrphanRunSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
