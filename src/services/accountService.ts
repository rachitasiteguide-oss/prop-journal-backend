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
