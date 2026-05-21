// Canonical instrument list — the single source of truth the frontend
// (Lot Calculator, Create Session Wizard, and anywhere else picking a
// symbol) reads from, replacing the duplicated hardcoded arrays that
// drifted out of sync.
//
// pipValue is the value of one pip per 1.00 standard lot, in USD. The forex
// values match what the Lot Calculator already shipped (kept identical so
// existing user expectations don't change); the source is now centralised.

export type InstrumentType = 'FOREX' | 'METAL';

export interface Instrument {
  symbol:    string;   // user-facing form, e.g. "EUR/USD"
  label:     string;
  type:      InstrumentType;
  pipValue:  number;   // USD per pip per 1.0 lot
}

export const INSTRUMENTS: Instrument[] = [
  { symbol: 'EUR/USD', label: 'EUR/USD', type: 'FOREX', pipValue: 10 },
  { symbol: 'GBP/USD', label: 'GBP/USD', type: 'FOREX', pipValue: 10 },
  { symbol: 'USD/JPY', label: 'USD/JPY', type: 'FOREX', pipValue: 9.09 },
  { symbol: 'AUD/USD', label: 'AUD/USD', type: 'FOREX', pipValue: 10 },
  { symbol: 'USD/CAD', label: 'USD/CAD', type: 'FOREX', pipValue: 7.69 },
  { symbol: 'USD/CHF', label: 'USD/CHF', type: 'FOREX', pipValue: 11.24 },
  { symbol: 'NZD/USD', label: 'NZD/USD', type: 'FOREX', pipValue: 10 },
  { symbol: 'EUR/GBP', label: 'EUR/GBP', type: 'FOREX', pipValue: 12.5 },
  { symbol: 'EUR/JPY', label: 'EUR/JPY', type: 'FOREX', pipValue: 9.09 },
  { symbol: 'GBP/JPY', label: 'GBP/JPY', type: 'FOREX', pipValue: 9.09 },
  // Gold: 1 standard lot = 100 oz, 1 pip = $0.01 price move -> $1.00 per pip.
  { symbol: 'XAU/USD', label: 'XAU/USD (Gold)',   type: 'METAL', pipValue: 1 },
  { symbol: 'XAG/USD', label: 'XAG/USD (Silver)', type: 'METAL', pipValue: 5 },
];

export function getInstruments(): Instrument[] {
  return INSTRUMENTS;
}
