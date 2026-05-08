// One-shot micro-benchmark for the engine speedups in Sprint 1.
// Run with: npx tsx src/services/__tests__/bench.ts
//
// Compares hot paths against the legacy implementations so the speedup
// claim in the research doc isn't just hand-waving.

import { performance } from 'node:perf_hooks';
import {
  SMA as LibSMA, EMA as LibEMA, RSI as LibRSI,
} from 'technicalindicators';
import { calcSMAInline, calcEMAInline, calcRSIInline } from '../inlineIndicators';

// Synthetic 50,000-candle close series — roughly a 5-year H1 forex dataset.
const N = 50_000;
const closes = new Array<number>(N);
for (let i = 0; i < N; i++) {
  closes[i] = 100 + 5 * Math.sin(i / 7) + i * 0.0001 + ((i * 13) % 11) * 0.05;
}

// Run each function many times to amortize startup noise.
function bench(label: string, fn: () => void, iters = 20): number {
  // Warmup — let V8 JIT settle.
  for (let i = 0; i < 3; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = performance.now() - t0;
  const per = dt / iters;
  console.log(`${label.padEnd(28)} ${per.toFixed(2).padStart(8)} ms / call`);
  return per;
}

console.log(`\nBenchmark — ${N.toLocaleString()} candles, 20 iterations\n`);

const libSma  = bench('Library SMA(20)',   () => LibSMA.calculate({ period: 20, values: closes }));
const inlSma  = bench('Inline  SMA(20)',   () => calcSMAInline(closes, 20));
console.log(`  → SMA speedup: ${(libSma / inlSma).toFixed(1)}×\n`);

const libEma  = bench('Library EMA(20)',   () => LibEMA.calculate({ period: 20, values: closes }));
const inlEma  = bench('Inline  EMA(20)',   () => calcEMAInline(closes, 20));
console.log(`  → EMA speedup: ${(libEma / inlEma).toFixed(1)}×\n`);

const libRsi  = bench('Library RSI(14)',   () => LibRSI.calculate({ period: 14, values: closes }));
const inlRsi  = bench('Inline  RSI(14)',   () => calcRSIInline(closes, 14));
console.log(`  → RSI speedup: ${(libRsi / inlRsi).toFixed(1)}×\n`);
