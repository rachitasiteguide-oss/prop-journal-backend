import { SMA, EMA, RSI, MACD, BollingerBands } from 'technicalindicators';

// Prepend nulls so output[i] always aligns with input[i].
// technicalindicators returns arrays shorter than the input by the warmup period;
// this restores 1:1 index correspondence with the candle array.
function align<T>(values: number[], raw: T[], nullSlot: T): T[] {
  const warmup = values.length - raw.length;
  return [...Array(warmup).fill(nullSlot), ...raw];
}

export function calcSMA(values: number[], period: number): (number | null)[] {
  const raw = SMA.calculate({ period, values }) as number[];
  return align(values, raw, null);
}

export function calcEMA(values: number[], period: number): (number | null)[] {
  const raw = EMA.calculate({ period, values }) as number[];
  return align(values, raw, null);
}

export function calcRSI(values: number[], period: number): (number | null)[] {
  const raw = RSI.calculate({ period, values }) as number[];
  return align(values, raw, null);
}

export interface MACDPoint {
  macd:      number | null;
  signal:    number | null;
  histogram: number | null;
}

export function calcMACD(
  values: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MACDPoint[] {
  const raw = MACD.calculate({
    values,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  }) as Array<{ MACD: number; signal: number; histogram: number }>;

  const mapped: MACDPoint[] = raw.map((r) => ({
    macd:      r.MACD      ?? null,
    signal:    r.signal    ?? null,
    histogram: r.histogram ?? null,
  }));

  const NULL_POINT: MACDPoint = { macd: null, signal: null, histogram: null };
  return align(values, mapped, NULL_POINT);
}

export interface BBPoint {
  upper:  number | null;
  middle: number | null;
  lower:  number | null;
}

export function calcBB(
  values: number[],
  period: number,
  stdDev: number,
): BBPoint[] {
  const raw = BollingerBands.calculate({ period, values, stdDev }) as Array<{
    upper: number;
    middle: number;
    lower: number;
  }>;

  const mapped: BBPoint[] = raw.map((r) => ({
    upper:  r.upper  ?? null,
    middle: r.middle ?? null,
    lower:  r.lower  ?? null,
  }));

  const NULL_POINT: BBPoint = { upper: null, middle: null, lower: null };
  return align(values, mapped, NULL_POINT);
}
