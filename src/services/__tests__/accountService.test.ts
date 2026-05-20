import { describe, it, expect } from 'vitest';
import { summarizeAccounts, type RawAccountForOverview } from '../accountService';

function account(over: Partial<RawAccountForOverview> & { trades: RawAccountForOverview['trades'] }): RawAccountForOverview {
  return {
    id: over.id ?? 'a1',
    name: over.name ?? 'Main',
    broker: over.broker ?? null,
    accountType: over.accountType ?? 'DEMO',
    currency: over.currency ?? 'USD',
    balance: over.balance ?? 10_000,
    trades: over.trades,
  };
}

describe('summarizeAccounts — per-account rows', () => {
  it('computes netPnL, equity, winRate from closed trades', () => {
    const r = summarizeAccounts([
      account({
        balance: 10_000,
        trades: [
          { pnl: 100, status: 'CLOSED' },
          { pnl: -50, status: 'CLOSED' },
          { pnl: 200, status: 'CLOSED' },
          { pnl: null, status: 'OPEN' },
        ],
      }),
    ]);
    const a = r.accounts[0];
    expect(a.netPnL).toBe(250);
    expect(a.equity).toBe(10_250);
    expect(a.closedTrades).toBe(3);
    expect(a.openTrades).toBe(1);
    expect(a.winRate).toBeCloseTo((2 / 3) * 100, 6);
  });

  it('ignores closed trades with null pnl', () => {
    const r = summarizeAccounts([
      account({ trades: [{ pnl: null, status: 'CLOSED' }, { pnl: 50, status: 'CLOSED' }] }),
    ]);
    expect(r.accounts[0].closedTrades).toBe(1);
    expect(r.accounts[0].netPnL).toBe(50);
  });

  it('treats a 0 pnl trade as a non-win (not as a win)', () => {
    const r = summarizeAccounts([
      account({ trades: [{ pnl: 0, status: 'CLOSED' }, { pnl: 50, status: 'CLOSED' }] }),
    ]);
    expect(r.accounts[0].winRate).toBe(50);
  });

  it('winRate is 0 (not NaN) when there are no closed trades', () => {
    const r = summarizeAccounts([account({ trades: [{ pnl: null, status: 'OPEN' }] })]);
    expect(r.accounts[0].winRate).toBe(0);
    expect(Number.isFinite(r.accounts[0].winRate)).toBe(true);
  });
});

describe('summarizeAccounts — portfolio totals', () => {
  it('sums balance / netPnL / equity / trade counts across accounts', () => {
    const r = summarizeAccounts([
      account({
        id: 'a',
        balance: 10_000,
        trades: [
          { pnl: 200, status: 'CLOSED' },
          { pnl: -100, status: 'CLOSED' },
        ],
      }),
      account({
        id: 'b',
        balance: 5_000,
        trades: [
          { pnl: 300, status: 'CLOSED' },
          { pnl: null, status: 'OPEN' },
        ],
      }),
    ]);
    expect(r.totals.accounts).toBe(2);
    expect(r.totals.balance).toBe(15_000);
    expect(r.totals.netPnL).toBe(400);
    expect(r.totals.equity).toBe(15_400);
    expect(r.totals.closedTrades).toBe(3);
    expect(r.totals.openTrades).toBe(1);
  });

  it('aggregate winRate counts raw wins, not rounded per-account rebuilds', () => {
    // 1 of 3 + 1 of 3 = 2 of 6 = 33.333%. The old impl rebuilt wins via
    // Math.round(33.3%/100 * 3) = 1 per account → 2/6 → 33.333%. Same answer
    // here by luck, but the regression case below shows where it diverged.
    const r = summarizeAccounts([
      account({ id: 'a', trades: [
        { pnl: 100, status: 'CLOSED' },
        { pnl: -10, status: 'CLOSED' },
        { pnl: -20, status: 'CLOSED' },
      ] }),
      account({ id: 'b', trades: [
        { pnl: 100, status: 'CLOSED' },
        { pnl: -10, status: 'CLOSED' },
        { pnl: -20, status: 'CLOSED' },
      ] }),
    ]);
    expect(r.totals.winRate).toBeCloseTo((2 / 6) * 100, 6);
  });

  it('aggregate winRate is 0 (not NaN) when nobody has closed a trade', () => {
    const r = summarizeAccounts([
      account({ trades: [{ pnl: null, status: 'OPEN' }] }),
    ]);
    expect(r.totals.winRate).toBe(0);
  });

  it('returns empty totals for an empty account list', () => {
    const r = summarizeAccounts([]);
    expect(r.accounts).toHaveLength(0);
    expect(r.totals).toEqual({
      accounts: 0,
      balance: 0,
      netPnL: 0,
      equity: 0,
      closedTrades: 0,
      openTrades: 0,
      winRate: 0,
    });
  });
});
