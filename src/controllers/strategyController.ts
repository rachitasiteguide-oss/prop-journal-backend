import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// ─── Validation schemas ────────────────────────────────────────────────────────

// Mirrors customStrategyInterpreter.CustomStrategyDSL — kept here so we can
// validate at the API edge before persisting. Loose `right` typing matches
// the DSL (indicator id string OR numeric literal).
const conditionSchema = z.object({
  left:  z.string().min(1),
  op:    z.enum(['GT', 'LT', 'GTE', 'LTE', 'EQ', 'CROSSES_ABOVE', 'CROSSES_BELOW']),
  right: z.union([z.string(), z.number()]),
});
const ruleGroupSchema = z.object({
  logic:      z.enum(['AND', 'OR']),
  conditions: z.array(conditionSchema).min(1).max(10),
});
const indicatorDefSchema = z.object({
  id:     z.string().min(1).max(50),
  type:   z.string().min(1),
  params: z.record(z.number()).optional(),
});
const definitionSchema = z.object({
  name:        z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  indicators:  z.array(indicatorDefSchema).min(1).max(20),
  buy:         ruleGroupSchema,
  sell:        ruleGroupSchema,
});

const createStrategySchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  isDefault:   z.boolean().optional().default(false),
  // `null` clears the attached DSL; omitted leaves it untouched.
  definition:  definitionSchema.nullable().optional(),
});

const updateStrategySchema = z.object({
  name:        z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isDefault:   z.boolean().optional(),
  definition:  definitionSchema.nullable().optional(),
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

    // Prisma's Json field rejects `undefined`; we must explicitly include or
    // omit the key. Same dance in the update handler below.
    const { definition, ...rest } = body;
    const strategy = await prisma.strategy.create({
      data: {
        userId,
        ...rest,
        ...(definition !== undefined && {
          definition: definition === null
            ? Prisma.JsonNull
            : (definition as unknown as Prisma.InputJsonValue),
        }),
      },
    });
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

    const { definition, ...rest } = body;
    const updated = await prisma.strategy.update({
      where: { id },
      data: {
        ...rest,
        ...(definition !== undefined && {
          definition: definition === null
            ? Prisma.JsonNull
            : (definition as unknown as Prisma.InputJsonValue),
        }),
      },
    });
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
