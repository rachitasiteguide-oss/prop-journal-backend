// Backtest engine orchestrator.
//
// This file owns:
//  - All Prisma I/O for an automated backtest run
//  - The signal cache lookup/store
//  - Spawning the worker thread for the heavy compute (and a fallback path
//    that runs the same compute inline, used by tests)
//
// All numeric work — signal generation and the candle loop — lives in
// `backtestEngineCore.ts` so the worker thread can import it without
// pulling in Prisma or any DB dependencies.

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';
import { getCandles } from './candleService';
import { type StrategyType } from './strategyDefinitions';
import { type CustomStrategyDSL } from './customStrategyInterpreter';
import { getCachedSignals, setCachedSignals } from './signalCache';
import {
  generateSignalsPure, runEventLoopPure, minCandlesRequired,
  type PureCandle, type PureTradeResult, type Signal,
} from './backtestEngineCore';
import type { WorkerMessage } from './backtestWorker';

// ── Public config ─────────────────────────────────────────────────────────────

export interface EngineConfig {
  strategyType:     StrategyType;
  strategyConfig:   Record<string, number | string>;
  customStrategy?:  CustomStrategyDSL;   // only used when strategyType === 'CUSTOM'
  startingBalance:  number;
  volume:           number;
  stopLossPct:      number;        // e.g. 0.02 = 2% from entry
  takeProfitRatio:  number;        // TP distance = stopLossPct × ratio
  slippagePct:      number;        // applied at entry (Rule 3)
  commission:       number;        // deducted at close (Rule 4)
  maxOpenPositions: number;
  instrumentType:   string;
}

// ── Worker / inline dispatch ──────────────────────────────────────────────────

// Vitest sets VITEST=true; in that case we run the engine inline because
// there is no compiled worker file under dist/services/. Operators can
// also force inline via BACKTEST_INLINE=1 if they want to debug a run
// without the worker boundary.
function shouldUseWorker(): boolean {
  if (process.env.VITEST === 'true')      return false;
  if (process.env.BACKTEST_INLINE === '1') return false;
  return true;
}

// Resolve the worker entrypoint relative to *this* file's compiled location.
// At runtime __dirname is `…/dist/services` and the worker sits next to it.
function workerEntryPath(): string {
  return path.join(__dirname, 'backtestWorker.js');
}

interface EngineRunResult {
  closedTrades: PureTradeResult[];
  finalBalance: number;
  signals:      Signal[];
}

// Spawn the worker, forward progress events to a callback, await completion.
// The worker terminates on its own once it posts the 'complete' (or 'error')
// message; we still call .terminate() defensively if anything goes wrong.
function runEngineInWorker(
  candles:       PureCandle[],
  cachedSignals: Signal[] | null,
  config:        EngineConfig,
  symbol:        string,
  onProgress:    (value: number) => void,
): Promise<EngineRunResult> {
  return new Promise<EngineRunResult>((resolve, reject) => {
    const worker = new Worker(workerEntryPath(), {
      workerData: { candles, cachedSignals, config, symbol },
    });

    let settled = false;
    const settleResolve = (v: EngineRunResult) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      resolve(v);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      reject(err);
    };

    worker.on('message', (msg: WorkerMessage) => {
      switch (msg.type) {
        case 'progress':
          onProgress(msg.value);
          break;
        case 'complete':
          settleResolve({
            closedTrades: msg.closedTrades,
            finalBalance: msg.finalBalance,
            signals:      msg.signals,
          });
          break;
        case 'error':
          settleReject(new Error(msg.message));
          break;
      }
    });
    worker.on('error', (err) => settleReject(err));
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settleReject(new Error(`Backtest worker exited with code ${code}`));
      }
    });
  });
}

// Inline fallback — same compute path the worker uses, just on the main
// thread. Used by tests (vitest can't easily resolve dist/) and by any
// operator who set BACKTEST_INLINE=1.
function runEngineInline(
  candles:       PureCandle[],
  cachedSignals: Signal[] | null,
  config:        EngineConfig,
  symbol:        string,
  onProgress:    (value: number) => void,
): EngineRunResult {
  const signals = cachedSignals
    ?? generateSignalsPure(candles, config.strategyType, config.strategyConfig, config.customStrategy);
  const { closedTrades, finalBalance } = runEventLoopPure(
    candles, signals, config, symbol, onProgress,
  );
  return { closedTrades, finalBalance, signals };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runAutomatedBacktest(
  userId: string,
  sessionId: string,
  config: EngineConfig,
): Promise<void> {
  // 1. Validate session belongs to this user.
  const session = await prisma.backtestSession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) throw new AppError('Session not found', 404);

  const timeframe = session.timeframe;
  if (!timeframe) throw new AppError('Session has no timeframe configured', 400);

  // 2. Mark as RUNNING, reset balance for fresh run.
  await prisma.backtestSession.update({
    where: { id: sessionId },
    data: {
      runStatus:      'RUNNING',
      runStartedAt:   new Date(),
      runProgress:    0,
      runError:       null,
      currentBalance: session.startingBalance,
    },
  });

  try {
    // 3. Delete existing auto-generated trades (re-run safety).
    await prisma.backtestTrade.deleteMany({ where: { sessionId } });

    // 4. Fetch (or serve from cache) candle data.
    //    Signal 3% so the UI shows movement while Yahoo Finance fetches.
    await prisma.backtestSession.update({ where: { id: sessionId }, data: { runProgress: 3 } });

    const candles = await getCandles(
      session.symbol,
      config.instrumentType,
      timeframe,
      session.startDate,
      session.endDate,
    ) as PureCandle[];

    // Data fetched — signal 12% before the engine loop starts.
    await prisma.backtestSession.update({ where: { id: sessionId }, data: { runProgress: 12 } });

    // 5. Validate enough candles for a meaningful run.
    const lookback = minCandlesRequired(config.strategyType, config.strategyConfig);
    const needed   = lookback + 2; // +1 for signal candle, +1 for entry candle
    if (candles.length < needed) {
      throw new AppError(
        `Insufficient data: need at least ${needed} candles for ${config.strategyType} ` +
        `(got ${candles.length}). Try a longer date range or lower indicator periods.`,
        400,
      );
    }

    // 6. Try the LRU signal cache before doing any work.
    const cacheKeyParts = {
      symbol:         session.symbol,
      timeframe,
      startMs:        session.startDate.getTime(),
      endMs:          session.endDate.getTime(),
      candleCount:    candles.length,
      strategyType:   config.strategyType,
      strategyConfig: config.strategyConfig,
      customStrategy: config.customStrategy,
    };
    const cachedSignals = getCachedSignals(cacheKeyParts);

    // 7. Throttled, fire-and-forget progress writer. Same throttle window
    //    as before (500 ms) — keeps the UI feeling live without flooding
    //    the connection pool. We never await these; if a write fails we
    //    log and continue.
    let lastProgressWriteTs = Date.now();
    let progressInFlight    = false;
    const PROGRESS_THROTTLE_MS = 500;
    const onProgress = (value: number): void => {
      const now = Date.now();
      if (progressInFlight || now - lastProgressWriteTs < PROGRESS_THROTTLE_MS) return;
      lastProgressWriteTs = now;
      progressInFlight    = true;
      prisma.backtestSession
        .update({ where: { id: sessionId }, data: { runProgress: value } })
        .catch((err) => logger.warn(
          `Backtest ${sessionId} progress write failed: ${err instanceof Error ? err.message : String(err)}`,
        ))
        .finally(() => { progressInFlight = false; });
    };

    // 8. Run the engine — worker if in production, inline for tests/debug.
    const { closedTrades, finalBalance, signals } = shouldUseWorker()
      ? await runEngineInWorker(candles, cachedSignals, config, session.symbol, onProgress)
      : runEngineInline    (candles, cachedSignals, config, session.symbol, onProgress);

    // 9. Populate the cache on miss.
    if (!cachedSignals) setCachedSignals(cacheKeyParts, signals);

    // 10. Persist all trades in one batch.
    if (closedTrades.length > 0) {
      await prisma.backtestTrade.createMany({
        data: closedTrades.map((t) => ({
          sessionId,
          symbol:     t.symbol,
          side:       t.side,
          entryPrice: t.entryPrice,
          exitPrice:  t.exitPrice,
          volume:     t.volume,
          stopLoss:   t.stopLoss,
          takeProfit: t.takeProfit,
          pnl:        parseFloat(t.pnl.toFixed(2)),
          pnlPct:     parseFloat(t.pnlPct.toFixed(4)),
          commission: t.commission,
          slippage:   t.slippage,
          ambiguous:  t.ambiguous,
          status:     'CLOSED' as const,
          entryAt:    t.entryAt,
          exitAt:     t.exitAt,
        })),
      });
    }

    // 11. Mark session COMPLETED.
    await prisma.backtestSession.update({
      where: { id: sessionId },
      data: {
        runStatus:      'COMPLETED',
        runProgress:    100,
        runCompletedAt: new Date(),
        currentBalance: parseFloat(finalBalance.toFixed(2)),
      },
    });

    logger.info(
      `Backtest ${sessionId} completed: ${closedTrades.length} trades, ` +
      `final balance $${finalBalance.toFixed(2)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Backtest ${sessionId} failed: ${msg}`);

    // Best-effort status update — swallow secondary errors.
    await prisma.backtestSession
      .update({ where: { id: sessionId }, data: { runStatus: 'FAILED', runError: msg } })
      .catch(() => undefined);

    throw err;
  }
}
