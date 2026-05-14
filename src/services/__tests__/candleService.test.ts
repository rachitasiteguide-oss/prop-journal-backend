import { describe, it, expect, vi } from 'vitest';
import { normalizeYFSymbol, fetchAndCacheCandles } from '../candleService';

vi.mock('../../config/db', () => ({
  prisma: {
    candle: {
      count:  vi.fn().mockResolvedValue(0),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('yahoo-finance2', () => {
  // Must be a regular function (not arrow) so `new YahooFinance()` works.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function MockYF(this: any) { this.chart = vi.fn(); }
  return { default: MockYF };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ── normalizeYFSymbol ─────────────────────────────────────────────────────────

describe('normalizeYFSymbol', () => {
  it('FOREX: appends =X suffix', () => {
    expect(normalizeYFSymbol('EURUSD', 'FOREX')).toBe('EURUSD=X');
  });

  it('FOREX: strips broker suffix (e.g. EURUSDm) before appending =X', () => {
    expect(normalizeYFSymbol('EURUSDm', 'FOREX')).toBe('EURUSD=X');
  });

  it('CRYPTO: appends -USD when no dash present', () => {
    expect(normalizeYFSymbol('BTC', 'CRYPTO')).toBe('BTC-USD');
  });

  it('CRYPTO: leaves already-qualified symbols unchanged', () => {
    expect(normalizeYFSymbol('BTC-USD', 'CRYPTO')).toBe('BTC-USD');
  });

  it('STOCKS: returns symbol as-is (uppercased)', () => {
    expect(normalizeYFSymbol('AAPL', 'STOCKS')).toBe('AAPL');
  });

  // ── Metals: Yahoo has no spot-metal feed, must route to COMEX futures ─────
  it('METAL: XAU/USD → GC=F (gold futures), regardless of FOREX classification', () => {
    expect(normalizeYFSymbol('XAU/USD', 'FOREX')).toBe('GC=F');
  });

  it('METAL: XAUUSD (no slash) → GC=F', () => {
    expect(normalizeYFSymbol('XAUUSD', 'FOREX')).toBe('GC=F');
  });

  it('METAL: XAGUSD → SI=F (silver futures)', () => {
    expect(normalizeYFSymbol('XAG/USD', 'FOREX')).toBe('SI=F');
  });

  it('METAL: XPTUSD → PL=F (platinum futures)', () => {
    expect(normalizeYFSymbol('XPTUSD', 'FOREX')).toBe('PL=F');
  });

  it('METAL: XPDUSD → PA=F (palladium futures)', () => {
    expect(normalizeYFSymbol('XPD/USD', 'CFD')).toBe('PA=F');
  });

  it('STOCKS: strips slashes/punctuation defensively', () => {
    expect(normalizeYFSymbol('BRK/B', 'STOCKS')).toBe('BRKB');
  });
});

// ── fetchAndCacheCandles — input validation ───────────────────────────────────

describe('fetchAndCacheCandles — validation', () => {
  it('throws AppError 400 when start date is not before end date', async () => {
    const from = new Date('2023-06-01');
    const to   = new Date('2023-01-01'); // inverted
    await expect(
      fetchAndCacheCandles('AAPL', 'STOCKS', 'D1', from, to),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws AppError 400 when end date is in the future', async () => {
    const from = new Date('2023-01-01');
    const to   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
    await expect(
      fetchAndCacheCandles('AAPL', 'STOCKS', 'D1', from, to),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws AppError 400 for an unsupported timeframe (e.g. M5)', async () => {
    const from = new Date('2023-01-01');
    const to   = new Date('2023-06-01');
    await expect(
      fetchAndCacheCandles('AAPL', 'STOCKS', 'M5', from, to),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws AppError 400 when H1 date range exceeds 730 days', async () => {
    const from = new Date('2020-01-01');
    const to   = new Date('2022-02-01'); // ≈ 762 days > 730-day H1 limit
    await expect(
      fetchAndCacheCandles('AAPL', 'STOCKS', 'H1', from, to),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
