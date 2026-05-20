import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

const phaseEnum    = z.enum(['PHASE_1', 'PHASE_2', 'FUNDED']);
const statusEnum   = z.enum(['ACTIVE', 'PASSED', 'FAILED', 'WITHDRAWN']);
const ddTypeEnum   = z.enum(['STATIC', 'TRAILING', 'EOD_TRAILING']);

const createSchema = z.object({
  accountId:      z.string().min(1),
  firmName:       z.string().min(1).max(100),
  phase:          phaseEnum.default('PHASE_1'),
  accountSize:    z.number().positive(),
  currency:       z.string().min(1).max(8).default('USD'),
  profitTarget:   z.number().min(0).max(100),
  maxDrawdown:    z.number().min(0).max(100),
  dailyDrawdown:  z.number().min(0).max(100),
  minTradingDays: z.number().int().min(0).max(365).default(0),
  ddType:         ddTypeEnum.default('STATIC'),
  timezone:       z.string().min(1).max(64).default('UTC'),
  startDate:      z.string().datetime().optional(),
  notes:          z.string().max(2000).optional(),
});

const updateSchema = createSchema.partial().extend({
  status:  statusEnum.optional(),
  endDate: z.string().datetime().nullable().optional(),
});

async function ensureAccountOwned(userId: string, accountId: string): Promise<void> {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new AppError('Account not found', 404);
}

export async function listChallengesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const challenges = await prisma.challenge.findMany({
      where: { userId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ status: 'success', data: challenges });
  } catch (err) {
    next(err);
  }
}

export async function getChallengeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    const challenge = await prisma.challenge.findFirst({ where: { id, userId } });
    if (!challenge) return next(new AppError('Challenge not found', 404));
    res.json({ status: 'success', data: challenge });
  } catch (err) {
    next(err);
  }
}

export async function createChallengeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const body = createSchema.parse(req.body);
    await ensureAccountOwned(userId, body.accountId);

    const { startDate, ...rest } = body;
    const challenge = await prisma.challenge.create({
      data: {
        userId,
        ...rest,
        startDate: startDate ? new Date(startDate) : new Date(),
      },
    });
    res.status(201).json({ status: 'success', data: challenge });
  } catch (err) {
    next(err);
  }
}

export async function updateChallengeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    const body = updateSchema.parse(req.body);

    const existing = await prisma.challenge.findFirst({ where: { id, userId } });
    if (!existing) return next(new AppError('Challenge not found', 404));

    if (body.accountId && body.accountId !== existing.accountId) {
      await ensureAccountOwned(userId, body.accountId);
    }

    const { startDate, endDate, ...rest } = body;
    const updated = await prisma.challenge.update({
      where: { id },
      data: {
        ...rest,
        ...(startDate ? { startDate: new Date(startDate) } : {}),
        ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
      },
    });
    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteChallengeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    const existing = await prisma.challenge.findFirst({ where: { id, userId } });
    if (!existing) return next(new AppError('Challenge not found', 404));
    await prisma.challenge.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
