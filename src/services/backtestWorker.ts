// Worker-thread entry point for the backtest engine.
//
// Runs in an isolated thread so the main Node.js event loop (which serves
// HTTP requests) is not blocked by the candle loop or signal computation.
// The worker has no Prisma client — all DB I/O stays on the main thread.
//
// Wire protocol (parent → worker via workerData):
//   { candles, cachedSignals, config, symbol }
// Wire protocol (worker → parent via postMessage):
//   { type: 'progress', value: number }
//   { type: 'complete', closedTrades, finalBalance, signals }
//   { type: 'error', message: string }

import { parentPort, workerData } from 'node:worker_threads';
import {
  generateSignalsPure, runEventLoopPure,
  type PureCandle, type PureEngineConfig, type Signal, type PureTradeResult,
} from './backtestEngineCore';

interface WorkerInput {
  candles:        PureCandle[];
  // If the main thread already had a cache hit, it passes the signals in
  // and the worker skips signal generation.
  cachedSignals:  Signal[] | null;
  config:         PureEngineConfig;
  symbol:         string;
}

export type WorkerMessage =
  | { type: 'progress'; value: number }
  | { type: 'complete'; closedTrades: PureTradeResult[]; finalBalance: number; signals: Signal[] }
  | { type: 'error';    message: string };

if (!parentPort) {
  // Defensive: this file should only run inside a Worker. If it's required
  // directly we throw immediately so the bug shows up loudly.
  throw new Error('backtestWorker.ts must be launched via worker_threads');
}

try {
  const input = workerData as WorkerInput;

  // Worker doesn't know about Date constructor preservation across thread
  // boundaries — Node.js structured-clones Dates correctly, but be paranoid
  // and rehydrate any serialized strings just in case.
  const rehydratedCandles: PureCandle[] = input.candles.map(c => ({
    ...c,
    openTime: c.openTime instanceof Date ? c.openTime : new Date(c.openTime),
  }));

  const signals = input.cachedSignals
    ?? generateSignalsPure(
      rehydratedCandles,
      input.config.strategyType,
      input.config.strategyConfig,
      input.config.customStrategy,
    );

  const { closedTrades, finalBalance } = runEventLoopPure(
    rehydratedCandles,
    signals,
    input.config,
    input.symbol,
    (progress) => parentPort!.postMessage({ type: 'progress', value: progress } satisfies WorkerMessage),
  );

  parentPort.postMessage({
    type:         'complete',
    closedTrades,
    finalBalance,
    // Send signals back so the main thread can populate its cache when the
    // worker had a miss. (No-op when cachedSignals was already provided —
    // we just echo it back.)
    signals,
  } satisfies WorkerMessage);
} catch (err) {
  parentPort.postMessage({
    type:    'error',
    message: err instanceof Error ? err.message : String(err),
  } satisfies WorkerMessage);
}
