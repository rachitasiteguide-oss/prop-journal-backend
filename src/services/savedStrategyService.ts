import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { Prisma } from '@prisma/client';
import type { CustomStrategyDSL } from './customStrategyInterpreter';

export async function listSavedStrategies(userId: string) {
  return prisma.savedStrategy.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getSavedStrategy(userId: string, id: string) {
  const s = await prisma.savedStrategy.findFirst({ where: { id, userId } });
  if (!s) throw new AppError('Strategy not found', 404);
  return s;
}

export async function createSavedStrategy(
  userId: string,
  data: { name: string; description?: string; definition: CustomStrategyDSL },
) {
  return prisma.savedStrategy.create({
    data: {
      userId,
      name:        data.name,
      description: data.description ?? null,
      definition:  data.definition as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function updateSavedStrategy(
  userId: string,
  id: string,
  data: { name?: string; description?: string; definition?: CustomStrategyDSL },
) {
  const existing = await prisma.savedStrategy.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError('Strategy not found', 404);
  return prisma.savedStrategy.update({
    where: { id },
    data: {
      ...(data.name        !== undefined && { name:        data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.definition  !== undefined && { definition:  data.definition as unknown as Prisma.InputJsonValue }),
    },
  });
}

export async function deleteSavedStrategy(userId: string, id: string) {
  const existing = await prisma.savedStrategy.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError('Strategy not found', 404);
  await prisma.savedStrategy.delete({ where: { id } });
}
