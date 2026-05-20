import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';

const ACCOUNT_SELECT = {
  id: true,
  name: true,
  broker: true,
  accountType: true,
  currency: true,
  balance: true,
} as const;

export async function getAccounts(userId: string) {
  return prisma.account.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: ACCOUNT_SELECT,
  });
}

// ── Multi-account unified overview ────────────────────────────────────────────
// Aggregates P&L and status across every active account a user holds into one
// portfolio view. Computed from whatever trades currently exist (manual entry
// today; broker-sync / file-import feeds will populate the same shape once
// those ingestion tasks land — no change needed here).

export interface AccountOverview {
  id: string;
  name: string;
  broker: string | null;
  accountType: AccountType;
  currency: string;
  balance: number;
  netPnL: number;
  equity: number; // balance + netPnL
  closedTrades: number;
  openTrades: number;
  winRate: number; // 0-100
}

export interface PortfolioOverview {
  accounts: AccountOverview[];
  totals: {
    accounts: number;
    balance: number;
    netPnL: number;
    equity: number;
    closedTrades: number;
    openTrades: number;
    winRate: number;
  };
}

// Pure aggregator extracted from getAccountsOverview so it can be unit-tested
// without spinning up Prisma. The raw input matches the shape returned by the
// prisma findMany() select below; tests fabricate it directly.
export interface RawAccountForOverview {
  id: string;
  name: string;
  broker: string | null;
  accountType: AccountType;
  currency: string;
  balance: number;
  trades: { pnl: number | null; status: string }[];
}

export function summarizeAccounts(accounts: RawAccountForOverview[]): PortfolioOverview {
  const rows: AccountOverview[] = accounts.map((a) => {
    const closed = a.trades.filter((t) => t.status === 'CLOSED' && t.pnl !== null);
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const netPnL = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return {
      id: a.id,
      name: a.name,
      broker: a.broker,
      accountType: a.accountType,
      currency: a.currency,
      balance: a.balance,
      netPnL,
      equity: a.balance + netPnL,
      closedTrades: closed.length,
      openTrades: a.trades.filter((t) => t.status === 'OPEN').length,
      winRate: closed.length ? (wins / closed.length) * 100 : 0,
    };
  });

  // Count wins from raw trades, not from `winRate * closedTrades` — the prior
  // implementation rebuilt the count via Math.round which would skew the
  // aggregate win rate slightly on accounts with awkward win counts (e.g.
  // 7/9 = 77.7777% rounds back to 7, which happens to work, but 1/3 = 33.33%
  // rounded back is fragile and inelegant).
  const totalWins = accounts.reduce(
    (s, a) => s + a.trades.filter((t) => t.status === 'CLOSED' && (t.pnl ?? 0) > 0).length,
    0,
  );
  const totalClosed = rows.reduce((s, r) => s + r.closedTrades, 0);

  return {
    accounts: rows,
    totals: {
      accounts: rows.length,
      balance: rows.reduce((s, r) => s + r.balance, 0),
      netPnL: rows.reduce((s, r) => s + r.netPnL, 0),
      equity: rows.reduce((s, r) => s + r.equity, 0),
      closedTrades: totalClosed,
      openTrades: rows.reduce((s, r) => s + r.openTrades, 0),
      winRate: totalClosed ? (totalWins / totalClosed) * 100 : 0,
    },
  };
}

export async function getAccountsOverview(userId: string): Promise<PortfolioOverview> {
  const accounts = await prisma.account.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: {
      ...ACCOUNT_SELECT,
      trades: { select: { pnl: true, status: true } },
    },
  });
  return summarizeAccounts(accounts);
}

export interface CreateAccountInput {
  name: string;
  broker?: string;
  accountType?: AccountType;
  balance?: number;
  currency?: string;
}

export async function createAccount(userId: string, data: CreateAccountInput) {
  return prisma.account.create({
    data: {
      userId,
      name: data.name,
      broker: data.broker,
      accountType: data.accountType ?? 'DEMO',
      balance: data.balance ?? 0,
      currency: data.currency ?? 'USD',
    },
    select: ACCOUNT_SELECT,
  });
}
