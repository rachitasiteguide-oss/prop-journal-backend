import { describe, it, expect } from 'vitest';
import {
  summarizeForTaxYear,
  tradesToCsvRows,
  buildCsv,
  type TaxRow,
} from '../taxExportService';

function row(over: Partial<TaxRow>): TaxRow {
  return {
    externalId: 'T1',
    symbol: 'EURUSD',
    side: 'BUY',
    volume: 1,
    entryPrice: 1.1,
    exitPrice: 1.11,
    pnl: 100,
    commission: -1,
    swap: 0,
    entryAt: new Date('2026-05-13T10:00:00Z'),
    exitAt: new Date('2026-05-13T11:00:00Z'),
    accountName: 'Main',
    ...over,
  };
}

describe('summarizeForTaxYear — totals', () => {
  it('counts wins, losses, and breakevens correctly', () => {
    const s = summarizeForTaxYear(
      [row({ pnl: 100 }), row({ pnl: -50 }), row({ pnl: 0 }), row({ pnl: 200 })],
      2026,
    );
    expect(s.winningTrades).toBe(2);
    expect(s.losingTrades).toBe(1);
    expect(s.breakevenTrades).toBe(1);
    expect(s.tradesClosed).toBe(4);
  });

  it('grossPnL sums pnl; netPnL applies fees + swap', () => {
    const s = summarizeForTaxYear(
      [row({ pnl: 100, commission: -2, swap: -1 }), row({ pnl: 50, commission: -1, swap: 0 })],
      2026,
    );
    expect(s.grossPnL).toBe(150);
    expect(s.totalCommission).toBe(-3);
    expect(s.totalSwap).toBe(-1);
    expect(s.netPnL).toBe(146);
  });

  it('tracks largest single winner and loser', () => {
    const s = summarizeForTaxYear(
      [row({ pnl: 50 }), row({ pnl: 300 }), row({ pnl: -10 }), row({ pnl: -250 })],
      2026,
    );
    expect(s.largestWin).toBe(300);
    expect(s.largestLoss).toBe(-250);
  });

  it('returns zeroed totals on an empty year', () => {
    const s = summarizeForTaxYear([], 2026);
    expect(s.tradesClosed).toBe(0);
    expect(s.grossPnL).toBe(0);
    expect(s.netPnL).toBe(0);
    expect(s.largestWin).toBe(0);
    expect(s.largestLoss).toBe(0);
  });

  it('treats null pnl as 0 (defensive — pnl should never be null for CLOSED trades)', () => {
    const s = summarizeForTaxYear([row({ pnl: null })], 2026);
    expect(s.grossPnL).toBe(0);
    expect(s.breakevenTrades).toBe(1);
  });
});

describe('tradesToCsvRows', () => {
  it('emits the header row first', () => {
    const rows = tradesToCsvRows([row({})]);
    expect(rows[0]).toEqual([
      'Ticket', 'Symbol', 'Side', 'Volume', 'Entry Price', 'Exit Price',
      'P&L', 'Commission', 'Swap', 'Entry Time (UTC)', 'Exit Time (UTC)', 'Account',
    ]);
  });

  it('formats pnl/commission/swap to 2dp', () => {
    const rows = tradesToCsvRows([row({ pnl: 100.5, commission: -1.123, swap: 0 })]);
    expect(rows[1][6]).toBe('100.50');
    expect(rows[1][7]).toBe('-1.12');
    expect(rows[1][8]).toBe('0.00');
  });

  it('uses ISO timestamps for entry/exit so Excel can sort them as dates', () => {
    const rows = tradesToCsvRows([row({})]);
    expect(rows[1][9]).toBe('2026-05-13T10:00:00.000Z');
    expect(rows[1][10]).toBe('2026-05-13T11:00:00.000Z');
  });
});

describe('buildCsv', () => {
  it('starts with a UTF-8 BOM so Excel detects the encoding', () => {
    expect(buildCsv([row({})]).charCodeAt(0)).toBe(0xfeff);
  });

  it('quotes cells that contain commas or quotes', () => {
    const csv = buildCsv([row({ accountName: 'Funded, Phase 2' })]);
    expect(csv).toContain('"Funded, Phase 2"');
  });

  it('escapes embedded double-quotes by doubling them', () => {
    const csv = buildCsv([row({ accountName: 'My "Live" Account' })]);
    expect(csv).toContain('"My ""Live"" Account"');
  });

  it('emits CRLF line endings (Excel-on-Windows convention)', () => {
    const csv = buildCsv([row({})]);
    expect(csv).toMatch(/\r\n/);
  });
});
