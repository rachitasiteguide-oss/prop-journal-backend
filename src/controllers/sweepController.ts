import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/sweepService';
import * as wfSvc from '../services/walkForwardService';

// Body for POST /sessions/:id/sweep. The base config mirrors the run-endpoint
// shape but is intentionally loose — the engine validates every field, and
// the sweep just substitutes one param per iteration.
const createSweepSchema = z.object({
  axis: z.object({
    paramKey: z.string().min(1).max(64),
    values:   z.array(z.number().finite()).min(1).max(50),
  }),
  baseConfig: z.record(z.unknown()),
});

export async function createSweepHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = createSweepSchema.parse(req.body);
    const sweep = await svc.createSweep(
      req.currentUser!.userId,
      String(req.params.id),
      body,
    );
    res.status(202).json({ status: 'success', data: sweep });
  } catch (e) { next(e); }
}

export async function getSweepHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sweep = await svc.getSweep(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data: sweep });
  } catch (e) { next(e); }
}

export async function listSweepsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sweeps = await svc.listSweepsForSession(
      req.currentUser!.userId,
      String(req.params.id),
    );
    res.json({ status: 'success', data: sweeps });
  } catch (e) { next(e); }
}

// ── Walk-forward ─────────────────────────────────────────────────────────────

const createWalkForwardSchema = z.object({
  axis: z.object({
    paramKey: z.string().min(1).max(64),
    values:   z.array(z.number().finite()).min(2).max(20),
  }),
  baseConfig: z.record(z.unknown()),
  windowsConfig: z.object({
    windows:         z.number().int().min(2).max(12),
    isRatio:         z.number().min(0.3).max(0.9),
    selectionMetric: z.enum(['sharpe', 'totalPnl', 'profitFactor']),
  }),
});

export async function createWalkForwardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = createWalkForwardSchema.parse(req.body);
    const wf = await wfSvc.createWalkForward(
      req.currentUser!.userId,
      String(req.params.id),
      body,
    );
    res.status(202).json({ status: 'success', data: wf });
  } catch (e) { next(e); }
}

export async function getWalkForwardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const wf = await wfSvc.getWalkForward(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data: wf });
  } catch (e) { next(e); }
}

export async function listWalkForwardsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const wfs = await wfSvc.listWalkForwardsForSession(
      req.currentUser!.userId,
      String(req.params.id),
    );
    res.json({ status: 'success', data: wfs });
  } catch (e) { next(e); }
}
