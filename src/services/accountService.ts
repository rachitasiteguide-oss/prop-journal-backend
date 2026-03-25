import { prisma } from '../config/db';

export async function getAccounts(userId: string) {
  return prisma.account.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, broker: true, accountType: true, currency: true },
  });
}
