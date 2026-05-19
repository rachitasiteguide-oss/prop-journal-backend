import { describe, it, expect } from 'vitest';
import {
  parseJBlankedDate,
  normalizeEvent,
  normalizeForexFactoryEvent,
  parseFFNumber,
  symbolCurrencies,
  detectNewsWindowTrades,
  type CalendarEvent,
} from '../economicCalendarService';

describe('parseJBlankedDate', () => {
  it('parses the JBlanked "YYYY.MM.DD HH:MM:SS" format as UTC', () => {
    const d = parseJBlankedDate('2024.02.08 15:30:00');
    expect(d?.toISOString()).toBe('2024-02-08T15:30:00.000Z');
  });

  it('accepts a T separator too', () => {
    const d = parseJBlankedDate('2024.02.08T00:00:00');
    expect(d?.toISOString()).toBe('2024-02-08T00:00:00.000Z');
  });

  it('returns null for malformed / non-string input', () => {
    expect(parseJBlankedDate('2024-02-08 15:30')).toBeNull();
    expect(parseJBlankedDate('garbage')).toBeNull();
    expect(parseJBlankedDate(42)).toBeNull();
    expect(parseJBlankedDate(null)).toBeNull();
  });
});

describe('normalizeEvent', () => {
  it('normalizes a well-formed row', () => {
    const ev = normalizeEvent({
      Name: ' Core CPI m/m ',
      Currency: 'usd',
      Impact: 'High',
      Date: '2024.02.08 15:30:00',
      Forecast: 0.4,
      Previous: 0.2,
      Actual: '0.5',
    });
    expect(ev).toEqual<CalendarEvent>({
      name: 'Core CPI m/m',
      currency: 'USD',
      impact: 'High',
      time: '2024-02-08T15:30:00.000Z',
      forecast: 0.4,
      previous: 0.2,
      actual: 0.5,
    });
  });

  it('defaults an unknown impact to None and nulls empty numbers', () => {
    const ev = normalizeEvent({
      Name: 'Bank Holiday',
      Currency: 'EUR',
      Impact: 'Holiday',
      Date: '2024.02.08 00:00:00',
      Forecast: '',
      Previous: null,
      Actual: undefined,
    });
    expect(ev?.impact).toBe('None');
    expect(ev?.forecast).toBeNull();
    expect(ev?.previous).toBeNull();
    expect(ev?.actual).toBeNull();
  });

  it('drops rows missing name, currency, or a valid date', () => {
    expect(normalizeEvent({ Currency: 'USD', Date: '2024.02.08 00:00:00' })).toBeNull();
    expect(normalizeEvent({ Name: 'X', Date: '2024.02.08 00:00:00' })).toBeNull();
    expect(normalizeEvent({ Name: 'X', Currency: 'USD', Date: 'bad' })).toBeNull();
  });
});

describe('parseFFNumber', () => {
  it('strips percent and parses', () => {
    expect(parseFFNumber('0.8%')).toBe(0.8);
    expect(parseFFNumber('-0.21%')).toBeCloseTo(-0.21);
    expect(parseFFNumber('46.0')).toBe(46);
  });
  it('applies K/M/B/T multipliers', () => {
    expect(parseFFNumber('1.2K')).toBe(1200);
    expect(parseFFNumber('3M')).toBe(3_000_000);
  });
  it('returns null for empty / non-numeric', () => {
    expect(parseFFNumber('')).toBeNull();
    expect(parseFFNumber('  ')).toBeNull();
    expect(parseFFNumber('n/a')).toBeNull();
    expect(parseFFNumber(undefined)).toBeNull();
  });
});

describe('normalizeForexFactoryEvent', () => {
  it('normalizes a ForexFactory weekly row (ISO date with offset)', () => {
    const ev = normalizeForexFactoryEvent({
      title: ' Core CPI m/m ',
      country: 'usd',
      date: '2026-05-17T18:30:00-04:00',
      impact: 'High',
      forecast: '0.4%',
      previous: '0.2%',
    });
    expect(ev).toEqual<CalendarEvent>({
      name: 'Core CPI m/m',
      currency: 'USD',
      impact: 'High',
      time: '2026-05-17T22:30:00.000Z', // -04:00 -> UTC
      forecast: 0.4,
      previous: 0.2,
      actual: null,
    });
  });

  it('maps non-standard impacts (Holiday) to None', () => {
    const ev = normalizeForexFactoryEvent({
      title: 'Bank Holiday',
      country: 'EUR',
      date: '2026-05-18T00:00:00-04:00',
      impact: 'Holiday',
      forecast: '',
      previous: '',
    });
    expect(ev?.impact).toBe('None');
    expect(ev?.forecast).toBeNull();
  });

  it('drops rows missing title, country, or a valid date', () => {
    expect(
      normalizeForexFactoryEvent({ country: 'USD', date: '2026-05-18T00:00:00-04:00' }),
    ).toBeNull();
    expect(normalizeForexFactoryEvent({ title: 'X', country: 'USD', date: 'bad' })).toBeNull();
  });
});

describe('symbolCurrencies', () => {
  it('splits a forex pair into both legs', () => {
    expect(symbolCurrencies('EURUSD')).toEqual(['EUR', 'USD']);
  });

  it('strips broker suffixes', () => {
    expect(symbolCurrencies('EURUSDm')).toEqual(['EUR', 'USD']);
    expect(symbolCurrencies('GBPJPY.pro')).toEqual(['GBP', 'JPY']);
  });

  it('keeps only the USD leg for metals like XAUUSD', () => {
    expect(symbolCurrencies('XAUUSD')).toEqual(['USD']);
  });

  it('falls back to USD for equities with no ISO legs', () => {
    expect(symbolCurrencies('AAPL')).toEqual(['USD']);
  });
});

describe('detectNewsWindowTrades', () => {
  const events: CalendarEvent[] = [
    {
      name: 'NFP',
      currency: 'USD',
      impact: 'High',
      time: '2024-02-02T13:30:00.000Z',
      forecast: null,
      previous: null,
      actual: null,
    },
    {
      name: 'Retail Sales',
      currency: 'GBP',
      impact: 'Medium',
      time: '2024-02-02T09:30:00.000Z',
      forecast: null,
      previous: null,
      actual: null,
    },
  ];

  it('flags a trade entered inside the window of a currency-matched high-impact event', () => {
    const hits = detectNewsWindowTrades(
      [{ id: 't1', symbol: 'EURUSD', entryAt: '2024-02-02T13:35:00.000Z' }],
      events,
      { beforeMin: 15, afterMin: 15, minImpact: 'High' },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].tradeId).toBe('t1');
    expect(hits[0].event.name).toBe('NFP');
    expect(hits[0].minutesFromEvent).toBe(5);
  });

  it('does not flag a trade outside the window', () => {
    const hits = detectNewsWindowTrades(
      [{ id: 't2', symbol: 'EURUSD', entryAt: '2024-02-02T14:00:00.000Z' }],
      events,
      { beforeMin: 15, afterMin: 15, minImpact: 'High' },
    );
    expect(hits).toHaveLength(0);
  });

  it('respects the before-window for entries ahead of the release', () => {
    const hits = detectNewsWindowTrades(
      [{ id: 't3', symbol: 'GBPUSD', entryAt: '2024-02-02T13:20:00.000Z' }],
      events,
      { beforeMin: 15, afterMin: 15, minImpact: 'High' },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].minutesFromEvent).toBe(-10);
  });

  it('ignores events below the minimum impact', () => {
    const hits = detectNewsWindowTrades(
      [{ id: 't4', symbol: 'GBPUSD', entryAt: '2024-02-02T09:32:00.000Z' }],
      events,
      { beforeMin: 15, afterMin: 15, minImpact: 'High' },
    );
    expect(hits).toHaveLength(0); // GBP event is Medium
  });

  it('ignores events for unrelated currencies', () => {
    const hits = detectNewsWindowTrades(
      [{ id: 't5', symbol: 'AUDNZD', entryAt: '2024-02-02T13:31:00.000Z' }],
      events,
      { beforeMin: 15, afterMin: 15, minImpact: 'High' },
    );
    expect(hits).toHaveLength(0);
  });
});
