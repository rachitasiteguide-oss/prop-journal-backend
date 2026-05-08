import { describe, it, expect } from 'vitest';
import { calcSMA, calcEMA, calcRSI } from '../indicatorService';
import {
  calcSMAInline, calcEMAInline, calcRSIInline,
} from '../inlineIndicators';

// Generate a deterministic but non-trivial price series. Pure sine waves
// hide bugs that show up on noisy data; a sine + secular drift catches both
// rolling-window arithmetic errors and EMA smoothing-coefficient mistakes.
function makeSeries(n: number): number[] {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 100 + 5 * Math.sin(i / 7) + i * 0.05 + ((i * 13) % 11) * 0.1;
  }
  return out;
}

// Library and inline outputs are the same algorithm computed with different
// floating-point operation orders, so we compare with a tight epsilon
// rather than strict equality.
function expectAlignedClose(
  inline: (number | null)[],
  reference: (number | null)[],
  eps = 1e-9,
) {
  expect(inline.length).toBe(reference.length);
  for (let i = 0; i < inline.length; i++) {
    const a = inline[i];
    const b = reference[i];
    if (a === null || b === null) {
      // Warmup positions must agree on null/non-null.
      expect(a === null && b === null).toBe(true);
    } else {
      expect(Math.abs(a - b)).toBeLessThan(eps);
    }
  }
}

describe('inlineIndicators — numerical parity with technicalindicators', () => {
  const series = makeSeries(200);

  it('SMA matches the library for periods 5, 14, 20, 50', () => {
    for (const p of [5, 14, 20, 50]) {
      expectAlignedClose(calcSMAInline(series, p), calcSMA(series, p));
    }
  });

  it('EMA matches the library for periods 5, 12, 26, 50', () => {
    for (const p of [5, 12, 26, 50]) {
      // EMA accumulates rounding so we relax epsilon slightly for longer windows.
      expectAlignedClose(calcEMAInline(series, p), calcEMA(series, p), 1e-6);
    }
  });

  it('RSI matches the library for periods 7, 14, 21', () => {
    for (const p of [7, 14, 21]) {
      // Wilder smoothing also accumulates rounding; relax epsilon.
      expectAlignedClose(calcRSIInline(series, p), calcRSI(series, p), 1e-6);
    }
  });

  it('handles short input gracefully (returns all nulls when below warmup)', () => {
    expect(calcSMAInline([1, 2, 3], 5)).toEqual([null, null, null]);
    expect(calcEMAInline([1, 2, 3], 5)).toEqual([null, null, null]);
    expect(calcRSIInline([1, 2, 3], 5)).toEqual([null, null, null]);
  });
});
