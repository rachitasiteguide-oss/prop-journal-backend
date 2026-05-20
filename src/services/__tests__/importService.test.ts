import { describe, it, expect } from 'vitest';
import { dedupeAgainstExisting, classifyJobStatus } from '../importService';
import type { ParsedTrade } from '../statementParser';

function pt(externalId: string): ParsedTrade {
  return {
    externalId,
    symbol: 'EURUSD',
    side: 'BUY',
    entryPrice: 1.1,
    exitPrice: 1.11,
    volume: 1,
    pnl: 100,
    commission: -1,
    swap: 0,
    stopLoss: null,
    takeProfit: null,
    entryAt: new Date('2026-05-13T10:00:00Z'),
    exitAt: new Date('2026-05-13T11:00:00Z'),
    status: 'CLOSED',
  };
}

describe('dedupeAgainstExisting', () => {
  it('inserts all when nothing exists yet', () => {
    const r = dedupeAgainstExisting([pt('1'), pt('2')], new Set());
    expect(r.toInsert).toHaveLength(2);
    expect(r.duplicates).toHaveLength(0);
  });

  it('skips trades whose externalId is already in the DB', () => {
    const r = dedupeAgainstExisting([pt('1'), pt('2'), pt('3')], new Set(['2']));
    expect(r.toInsert.map((t) => t.externalId)).toEqual(['1', '3']);
    expect(r.duplicates.map((t) => t.externalId)).toEqual(['2']);
  });

  it('deduplicates trades that appear twice within the same import file', () => {
    // Important: this is the exact case task description calls out — re-uploading
    // the same file must not insert the trade twice.
    const r = dedupeAgainstExisting([pt('1'), pt('1'), pt('2')], new Set());
    expect(r.toInsert.map((t) => t.externalId)).toEqual(['1', '2']);
    expect(r.duplicates.map((t) => t.externalId)).toEqual(['1']);
  });

  it('treats DB matches and in-file matches independently in the duplicate list', () => {
    const r = dedupeAgainstExisting([pt('1'), pt('2'), pt('2'), pt('3')], new Set(['3']));
    expect(r.toInsert.map((t) => t.externalId)).toEqual(['1', '2']);
    expect(r.duplicates.map((t) => t.externalId).sort()).toEqual(['2', '3']);
  });
});

describe('classifyJobStatus', () => {
  it('COMPLETED when there are no errors at all', () => {
    expect(classifyJobStatus(5, 0, 5)).toBe('COMPLETED');
  });

  it('COMPLETED even when zero rows were inserted, as long as the parser produced 0 errors', () => {
    // The file had zero recognised trade rows but also no parse errors —
    // e.g. an MT5 statement filtered down to nothing but balance rows.
    expect(classifyJobStatus(0, 0, 0)).toBe('COMPLETED');
  });

  it('PARTIAL when some rows inserted and some failed', () => {
    expect(classifyJobStatus(3, 2, 5)).toBe('PARTIAL');
  });

  it('FAILED when there are errors and nothing was inserted', () => {
    expect(classifyJobStatus(0, 5, 5)).toBe('FAILED');
  });

  it('FAILED when the parser produced zero trades but reported errors (e.g. unrecognised header)', () => {
    expect(classifyJobStatus(0, 1, 0)).toBe('FAILED');
  });
});
