import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// Server-issued random slug for the public share URL. URL-safe base32, 12
// chars — gives ~60 bits of entropy, plenty for non-enumerable public links.
function generatePublicSlug(): string {
  return crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toLowerCase();
}

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
  status:           statusEnum.optional(),
  endDate:          z.string().datetime().nullable().optional(),
  tradingLocked:    z.boolean().optional(),
  // Pass null to clear the live-equity override and fall back to closed-trade
  // accounting. Setting a value auto-stamps equityUpdatedAt = now.
  currentEquity:    z.number().nullable().optional(),
  profitSplitPct:   z.number().min(0).max(100).nullable().optional(),
  nextScaleTarget:  z.number().positive().nullable().optional(),
  // Server-issued slug when true; cleared when false. We never accept a
  // user-supplied slug to prevent squatting and profanity in URLs.
  isPublic:         z.boolean().optional(),
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

    const { startDate, endDate, status, currentEquity, isPublic, ...rest } = body;
    // Transitioning to a terminal status auto-stamps endDate if the caller
    // didn't provide one explicitly. Lets the UI offer simple "Mark passed"
    // / "Mark failed" / "Withdraw" buttons without juggling the date.
    const terminal = status && status !== 'ACTIVE';
    const computedEndDate =
      endDate !== undefined
        ? endDate
          ? new Date(endDate)
          : null
        : terminal && !existing.endDate
          ? new Date()
          : undefined;

    const updated = await prisma.challenge.update({
      where: { id },
      data: {
        ...rest,
        ...(status ? { status } : {}),
        ...(startDate ? { startDate: new Date(startDate) } : {}),
        ...(computedEndDate !== undefined ? { endDate: computedEndDate } : {}),
        ...(currentEquity !== undefined
          ? currentEquity === null
            ? { currentEquity: null, equityUpdatedAt: null }
            : { currentEquity, equityUpdatedAt: new Date() }
          : {}),
        ...(isPublic === true && !existing.publicSlug
          ? { publicSlug: generatePublicSlug() }
          : {}),
        ...(isPublic === false ? { publicSlug: null } : {}),
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
