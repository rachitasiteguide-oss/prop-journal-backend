import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// ─── Validation schemas ────────────────────────────────────────────────────────

const createStrategySchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  isDefault:   z.boolean().optional().default(false),
});

const updateStrategySchema = z.object({
  name:        z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isDefault:   z.boolean().optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function getStrategiesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const strategies = await prisma.strategy.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ status: 'success', data: strategies });
  } catch (err) {
    next(err);
  }
}

export async function createStrategyHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const body = createStrategySchema.parse(req.body);

    // If setting as default, clear existing default
    if (body.isDefault) {
      await prisma.strategy.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    }

    const strategy = await prisma.strategy.create({ data: { userId, ...body } });
    res.status(201).json({ status: 'success', data: strategy });
  } catch (err) {
    next(err);
  }
}

export async function updateStrategyHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    const body = updateStrategySchema.parse(req.body);

    const existing = await prisma.strategy.findFirst({ where: { id, userId } });
    if (!existing) return next(new AppError('Strategy not found', 404));

    // If setting as default, clear existing default
    if (body.isDefault) {
      await prisma.strategy.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    }

    const updated = await prisma.strategy.update({ where: { id }, data: body });
    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteStrategyHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;

    const existing = await prisma.strategy.findFirst({ where: { id, userId } });
    if (!existing) return next(new AppError('Strategy not found', 404));

    await prisma.strategy.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
