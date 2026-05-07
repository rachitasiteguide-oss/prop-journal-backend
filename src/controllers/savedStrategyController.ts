import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/savedStrategyService';

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

const createSchema = z.object({
  name:        z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  definition:  definitionSchema,
});

const updateSchema = z.object({
  name:        z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  definition:  definitionSchema.optional(),
});

export async function listSavedStrategiesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.listSavedStrategies(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function getSavedStrategyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSavedStrategy(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function createSavedStrategyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = createSchema.parse(req.body);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await svc.createSavedStrategy(req.currentUser!.userId, body as any);
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function updateSavedStrategyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = updateSchema.parse(req.body);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await svc.updateSavedStrategy(req.currentUser!.userId, String(req.params.id), body as any);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function deleteSavedStrategyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteSavedStrategy(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', message: 'Strategy deleted' });
  } catch (e) { next(e); }
}
