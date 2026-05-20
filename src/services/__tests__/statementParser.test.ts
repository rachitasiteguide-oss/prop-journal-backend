import { describe, it, expect } from 'vitest';
import { parseStatement, detectFormat } from '../statementParser';
import { parseCsv } from '../../utils/csv';

describe('parseCsv', () => {
  it('tokenises a plain CSV row', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with embedded commas', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    expect(parseCsv('a,"he said ""hi""",b')).toEqual([['a', 'he said "hi"', 'b']]);
  });

  it('autodetects tab delimiter when there are more tabs than commas', () => {
    expect(parseCsv('a\tb\tc\n1\t2\t3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('strips trailing blank rows from CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('detectFormat', () => {
  it('detects MT5 via the metatrader 5 marker', () => {
    expect(detectFormat('MetaTrader 5 Trading Report\nTime,Deal,Position,...')).toBe('mt5');
  });

  it('detects MT5 via deal+position columns', () => {
    expect(detectFormat('Time,Deal,Position,Symbol,Type,Volume\n2024.05.13 10:00,1,100,EURUSD,buy,1')).toBe('mt5');
  });

  it('detects MT4 via account statement marker', () => {
    expect(detectFormat('Account Statement for #12345\nTicket,Open Time,Type,Size,Item,Price'))
      .toBe('mt4');
  });

  it('falls back to csv_generic', () => {
    expect(detectFormat('id,symbol,side,entry,exit,volume,pnl')).toBe('csv_generic');
  });
});

describe('parseStatement — generic CSV', () => {
  const csv = [
    'id,symbol,side,open price,close price,volume,profit,commission,swap,sl,tp,open time,close time',
    '1001,EURUSD,buy,1.0850,1.0900,1.0,50.00,-1.50,-0.20,1.0820,1.0950,2026-05-13 10:00:00,2026-05-13 14:30:00',
    '1002,GBPUSD,sell,1.2500,1.2480,0.5,10.00,-0.75,0.00,1.2530,1.2470,2026-05-13 09:00:00,2026-05-13 11:00:00',
  ].join('\n');

  it('parses both rows into normalised trades', () => {
    const r = parseStatement(csv);
    expect(r.errors).toHaveLength(0);
    expect(r.trades).toHaveLength(2);
  });

  it('maps fields including dedupe key and timestamps', () => {
    const r = parseStatement(csv);
    const t = r.trades[0];
    expect(t.externalId).toBe('1001');
    expect(t.symbol).toBe('EURUSD');
    expect(t.side).toBe('BUY');
    expect(t.entryPrice).toBe(1.085);
    expect(t.exitPrice).toBe(1.09);
    expect(t.volume).toBe(1);
    expect(t.pnl).toBe(50);
    expect(t.commission).toBe(-1.5);
    expect(t.swap).toBe(-0.2);
    expect(t.stopLoss).toBe(1.082);
    expect(t.takeProfit).toBe(1.095);
    expect(t.entryAt.toISOString()).toBe('2026-05-13T10:00:00.000Z');
    expect(t.exitAt!.toISOString()).toBe('2026-05-13T14:30:00.000Z');
    expect(t.status).toBe('CLOSED');
  });

  it('marks a trade OPEN when exit price/time are absent', () => {
    const open = [
      'id,symbol,side,open price,close price,volume,profit,open time,close time',
      '1003,USDJPY,buy,155.10,,1.0,,2026-05-13 10:00:00,',
    ].join('\n');
    const r = parseStatement(open);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].status).toBe('OPEN');
    expect(r.trades[0].exitPrice).toBeNull();
    expect(r.trades[0].exitAt).toBeNull();
    expect(r.trades[0].pnl).toBeNull();
  });
});

describe('parseStatement — MT4 CSV export', () => {
  // MT4 history dump (tab-separated by default but the Save-as-CSV path uses
  // commas). Notable quirks: two columns called "Price", two called "Time".
  const mt4 = [
    'Ticket,Open Time,Type,Size,Item,Price,S/L,T/P,Close Time,Price,Commission,Taxes,Swap,Profit',
    '12345,2026.05.13 09:00:00,buy,0.10,EURUSD,1.08500,1.08000,1.09500,2026.05.13 11:30:00,1.08800,-0.50,0.00,-0.10,30.00',
    '12346,2026.05.13 10:00:00,balance,,,,,,,,,,,,1000.00',
    '12347,2026.05.13 12:00:00,sell,0.20,GBPUSD,1.25000,1.25500,1.24500,2026.05.13 14:00:00,1.24800,-1.00,0.00,0.00,40.00',
  ].join('\n');

  it('parses MT4 rows, skipping non-trade "balance" rows', () => {
    const r = parseStatement(mt4);
    expect(r.format).toBe('mt4');
    expect(r.trades).toHaveLength(2);
    expect(r.trades.map((t) => t.externalId)).toEqual(['12345', '12347']);
  });

  it('correctly maps the two Price columns to entryPrice / exitPrice', () => {
    const r = parseStatement(mt4);
    expect(r.trades[0].entryPrice).toBe(1.085);
    expect(r.trades[0].exitPrice).toBe(1.088);
  });

  it('parses the MT-native YYYY.MM.DD HH:MM:SS date format', () => {
    const r = parseStatement(mt4);
    expect(r.trades[0].entryAt.toISOString()).toBe('2026-05-13T09:00:00.000Z');
    expect(r.trades[0].exitAt!.toISOString()).toBe('2026-05-13T11:30:00.000Z');
  });
});

describe('parseStatement — MT5 deal export', () => {
  const mt5 = [
    'Time,Deal,Symbol,Type,Volume,Price,S/L,T/P,Time,Price,Commission,Swap,Profit',
    '2026.05.13 09:00,50001,EURUSD,buy,1.00,1.0850,1.0820,1.0950,2026.05.13 11:30,1.0880,-2.00,-0.20,300.00',
  ].join('\n');

  it('parses MT5 row and detects the format', () => {
    const r = parseStatement(mt5);
    expect(r.format).toBe('mt5');
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].externalId).toBe('50001');
    expect(r.trades[0].pnl).toBe(300);
  });
});

describe('parseStatement — error handling', () => {
  it('reports an error and skips rows missing the dedupe key', () => {
    const csv = [
      'id,symbol,side,open price,close price,volume,open time,close time',
      ',EURUSD,buy,1.0850,1.0900,1.0,2026-05-13 10:00:00,2026-05-13 11:00:00',
      '1001,EURUSD,buy,1.0850,1.0900,1.0,2026-05-13 10:00:00,2026-05-13 11:00:00',
    ].join('\n');
    const r = parseStatement(csv);
    expect(r.trades).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/ticket/i);
  });

  it('reports an error when volume is missing or zero', () => {
    const csv = [
      'id,symbol,side,open price,close price,volume,open time,close time',
      '1001,EURUSD,buy,1.0850,1.0900,0,2026-05-13 10:00:00,2026-05-13 11:00:00',
    ].join('\n');
    const r = parseStatement(csv);
    expect(r.trades).toHaveLength(0);
    expect(r.errors[0].message).toMatch(/volume/i);
  });

  it('returns a single header-not-found error when no recognisable columns exist', () => {
    const r = parseStatement('foo,bar,baz\n1,2,3');
    expect(r.trades).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/header/i);
  });

  it('handles paren-wrapped negatives like brokers that print (1.50) for -1.50', () => {
    const csv = [
      'id,symbol,side,open price,close price,volume,profit,open time,close time',
      '1001,EURUSD,buy,1.0850,1.0900,1.0,(50.00),2026-05-13 10:00:00,2026-05-13 11:00:00',
    ].join('\n');
    const r = parseStatement(csv);
    expect(r.trades[0].pnl).toBe(-50);
  });

  it('strips embedded commas from numeric values (e.g. 1,234.50)', () => {
    const csv = [
      'id,symbol,side,open price,close price,volume,profit,open time,close time',
      '1001,EURUSD,buy,1.0850,1.0900,1.0,"1,234.50",2026-05-13 10:00:00,2026-05-13 11:00:00',
    ].join('\n');
    const r = parseStatement(csv);
    expect(r.trades[0].pnl).toBe(1234.5);
  });
});
