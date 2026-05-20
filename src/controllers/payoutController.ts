import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

const payoutStatusEnum = z.enum(['REQUESTED', 'PAID', 'REJECTED']);

const createSchema = z.object({
  amount:      z.number().positive(),
  netAmount:   z.number().nonnegative().optional(),
  splitPct:    z.number().min(0).max(100).optional(),
  method:      z.string().max(60).optional(),
  reference:   z.string().max(120).optional(),
  notes:       z.string().max(2000).optional(),
  requestedAt: z.string().datetime().optional(),
});

const updateSchema = createSchema.partial().extend({
  status: payoutStatusEnum.optional(),
  paidAt: z.string().datetime().nullable().optional(),
});

async function ensureChallengeOwned(userId: string, challengeId: string): Promise<void> {
  const challenge = await prisma.challenge.findFirst({
    where: { id: challengeId, userId },
    select: { id: true },
  });
  if (!challenge) throw new AppError('Challenge not found', 404);
}

async function ensurePayoutOwned(userId: string, payoutId: string) {
  const payout = await prisma.challengePayout.findFirst({
    where: { id: payoutId, challenge: { userId } },
  });
  if (!payout) throw new AppError('Payout not found', 404);
  return payout;
}

export async function listPayoutsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const challengeId = req.params['challengeId'] as string;
    await ensureChallengeOwned(userId, challengeId);
    const payouts = await prisma.challengePayout.findMany({
      where: { challengeId },
      orderBy: { requestedAt: 'desc' },
    });
    res.json({ status: 'success', data: payouts });
  } catch (err) {
    next(err);
  }
}

export async function createPayoutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const challengeId = req.params['challengeId'] as string;
    await ensureChallengeOwned(userId, challengeId);

    const body = createSchema.parse(req.body);
    const { requestedAt, ...rest } = body;
    const payout = await prisma.challengePayout.create({
      data: {
        challengeId,
        ...rest,
        ...(requestedAt ? { requestedAt: new Date(requestedAt) } : {}),
      },
    });
    res.status(201).json({ status: 'success', data: payout });
  } catch (err) {
    next(err);
  }
}

export async function updatePayoutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    await ensurePayoutOwned(userId, id);

    const body = updateSchema.parse(req.body);
    const { paidAt, status, ...rest } = body;
    // Auto-stamp paidAt = now when status transitions to PAID and the caller
    // didn't supply one explicitly.
    const computedPaidAt =
      paidAt !== undefined
        ? paidAt
          ? new Date(paidAt)
          : null
        : status === 'PAID'
          ? new Date()
          : undefined;

    const updated = await prisma.challengePayout.update({
      where: { id },
      data: {
        ...rest,
        ...(status ? { status } : {}),
        ...(computedPaidAt !== undefined ? { paidAt: computedPaidAt } : {}),
      },
    });
    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deletePayoutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    await ensurePayoutOwned(userId, id);
    await prisma.challengePayout.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
