import { SMA, EMA, RSI, MACD, BollingerBands, Stochastic, ATR, CCI, WilliamsR, ADX } from 'technicalindicators';

// Prepend nulls so output[i] always aligns with input[i].
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

// ── New indicators ────────────────────────────────────────────────────────────

export interface StochPoint {
  k: number | null;
  d: number | null;
}

export function calcStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
  signalPeriod: number,
): StochPoint[] {
  const raw = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period,
    signalPeriod,
  }) as Array<{ k: number; d: number }>;

  const mapped: StochPoint[] = raw.map((r) => ({ k: r.k ?? null, d: r.d ?? null }));
  const NULL_POINT: StochPoint = { k: null, d: null };
  return align(closes, mapped, NULL_POINT);
}

export function calcATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): (number | null)[] {
  const raw = ATR.calculate({ high: highs, low: lows, close: closes, period }) as number[];
  return align(closes, raw, null);
}

export function calcCCI(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): (number | null)[] {
  const raw = CCI.calculate({ high: highs, low: lows, close: closes, period }) as number[];
  return align(closes, raw, null);
}

export function calcWilliamsR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): (number | null)[] {
  const raw = WilliamsR.calculate({ high: highs, low: lows, close: closes, period }) as number[];
  return align(closes, raw, null);
}

export interface ADXPoint {
  adx:  number | null;
  pdi:  number | null;
  mdi:  number | null;
}

export function calcADX(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): ADXPoint[] {
  const raw = ADX.calculate({ high: highs, low: lows, close: closes, period }) as Array<{
    adx: number; pdi: number; mdi: number;
  }>;

  const mapped: ADXPoint[] = raw.map((r) => ({
    adx: r.adx ?? null,
    pdi: r.pdi ?? null,
    mdi: r.mdi ?? null,
  }));

  const NULL_POINT: ADXPoint = { adx: null, pdi: null, mdi: null };
  return align(closes, mapped, NULL_POINT);
}

export interface DonchianPoint {
  upper:  number | null;
  lower:  number | null;
  middle: number | null;
}

// Donchian Channel: highest high and lowest low over N periods.
// Not in the technicalindicators package, so computed manually.
export function calcDonchian(
  highs: number[],
  lows: number[],
  period: number,
): DonchianPoint[] {
  const result: DonchianPoint[] = new Array(highs.length).fill(null).map(() => ({
    upper: null, lower: null, middle: null,
  }));

  for (let i = period - 1; i < highs.length; i++) {
    let upper = -Infinity;
    let lower = +Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > upper) upper = highs[j];
      if (lows[j]  < lower) lower = lows[j];
    }
    result[i] = { upper, lower, middle: (upper + lower) / 2 };
  }

  return result;
}
