// Process-local LRU cache for computed strategy signal arrays.
//
// Why this exists: when a user re-runs a backtest with the same symbol,
// timeframe, date range, and strategy params, the only changes that
// matter are *post-signal* (slippage, commission, volume, balance, SL/TP).
// The expensive part — generating the Signal[] from candles — is fully
// determined by (symbol, timeframe, dateRange, strategyType, strategyConfig,
// customStrategy). Caching this skips the heaviest part of every rerun.
//
// Design notes:
// - Process-local Map; no Redis dependency. For multi-instance deploys
//   each pod warms its own cache. That's fine: misses cost a recomputation,
//   not a correctness bug.
// - Bounded size + TTL. The TTL is mostly insurance against stale candle
//   data (Yahoo Finance occasionally backfills late ticks). A user can
//   force a fresh computation by waiting for TTL or restarting the process.
// - `Map` preserves insertion order, so cheapest LRU = re-insert on hit
//   and pop the first key on overflow.

import crypto from 'node:crypto';

type Signal = 'BUY' | 'SELL' | null;

interface CacheEntry {
  signals:   Signal[];
  expiresAt: number;
}

const MAX_ENTRIES = 256;
const TTL_MS      = 60 * 60 * 1000; // 1 hour

const cache = new Map<string, CacheEntry>();

// Stats — tiny but useful when debugging "why is my run slow":
//   import { signalCacheStats } from './signalCache';
//   logger.info(signalCacheStats());
let hits   = 0;
let misses = 0;

interface KeyParts {
  symbol:         string;
  timeframe:      string;
  startMs:        number;
  endMs:          number;
  candleCount:    number;
  strategyType:   string;
  strategyConfig: Record<string, unknown>;
  customStrategy?: unknown;
}

// Recursive canonicalization with sorted keys at every depth. Avoids the
// array-replacer pitfall of JSON.stringify (which filters keys at every
// level by name, stripping nested config like strategyConfig.fastPeriod).
function canonicalize(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys
    .map(k => JSON.stringify(k) + ':' + canonicalize(obj[k]))
    .join(',') + '}';
}

// SHA-1 of a canonical JSON of the inputs. Faster than SHA-256 and
// collision risk on a 256-entry cache is effectively zero.
function buildKey(parts: KeyParts): string {
  return crypto.createHash('sha1').update(canonicalize(parts)).digest('hex');
}

export function getCachedSignals(parts: KeyParts): Signal[] | null {
  const key   = buildKey(parts);
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    misses++;
    return null;
  }
  // LRU touch — re-insert moves to most-recent slot.
  cache.delete(key);
  cache.set(key, entry);
  hits++;
  return entry.signals;
}

export function setCachedSignals(parts: KeyParts, signals: Signal[]): void {
  const key = buildKey(parts);
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest entry — first key in insertion order.
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { signals, expiresAt: Date.now() + TTL_MS });
}

export function signalCacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
  const total = hits + misses;
  return { size: cache.size, hits, misses, hitRate: total > 0 ? hits / total : 0 };
}

// Test/debug only: clear the entire cache. Kept exported so vitest can
// reset state between test cases.
export function clearSignalCache(): void {
  cache.clear();
  hits   = 0;
  misses = 0;
}
