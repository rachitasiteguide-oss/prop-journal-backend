import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getPublicStats,
  getApprovedTestimonials,
  submitTestimonial,
} from '../services/publicService';

export async function getPublicStatsHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getPublicStats();
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function getTestimonialsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 12;
    const data = await getApprovedTestimonials(Number.isFinite(limit) ? limit : 12);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

const submitSchema = z.object({
  quote:  z.string().min(20).max(600),
  role:   z.string().max(80).optional(),
  rating: z.number().int().min(1).max(5),
});

export async function submitTestimonialHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = submitSchema.parse(req.body);
    const data = await submitTestimonial(req.currentUser!.userId, body);
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}
