import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getPublicStats,
  getApprovedTestimonials,
  submitTestimonial,
} from '../services/publicService';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

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

// Public, unauthenticated. Returns a sanitised slice of the challenge for a
// share-card UI. Only percentages and high-level status — no raw dollar
// amounts, no account balance, no user identity. Anyone with the slug can
// view; revoke by clearing publicSlug from the owner's settings.
export async function getPublicChallengeHandler(
  req: Request<{ slug: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const slug = req.params.slug;
    const c = await prisma.challenge.findUnique({
      where: { publicSlug: slug },
      select: {
        firmName: true,
        phase: true,
        status: true,
        accountSize: true,
        profitTarget: true,
        maxDrawdown: true,
        dailyDrawdown: true,
        ddType: true,
        currency: true,
        currentEquity: true,
        startDate: true,
        endDate: true,
        timezone: true,
        account: { select: { trades: { select: { pnl: true, status: true, exitAt: true } } } },
      },
    });
    if (!c) throw new AppError('Not found', 404);

    // Compute the same percent-based view the main page uses, but never expose
    // dollar amounts — keeps shares safe for socials.
    const closedPnL = c.account.trades
      .filter((t) => t.status === 'CLOSED' && t.pnl != null)
      .reduce((s, t) => s + (t.pnl ?? 0), 0);
    const balance = c.currentEquity ?? c.accountSize + closedPnL;
    const totalReturnPct = c.accountSize > 0 ? ((balance - c.accountSize) / c.accountSize) * 100 : 0;
    const profitProgressPct =
      c.profitTarget > 0 ? Math.min(100, Math.max(0, (totalReturnPct / c.profitTarget) * 100)) : 0;

    const tradingDayKeys = new Set<string>();
    for (const t of c.account.trades) {
      if (t.exitAt && t.status === 'CLOSED') {
        const key = new Intl.DateTimeFormat('en-CA', {
          timeZone: c.timezone || 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(t.exitAt);
        tradingDayKeys.add(key);
      }
    }

    res.json({
      status: 'success',
      data: {
        firmName: c.firmName,
        phase: c.phase,
        status: c.status,
        ddType: c.ddType,
        currency: c.currency,
        profitTargetPct: c.profitTarget,
        maxDrawdownPct: c.maxDrawdown,
        dailyDrawdownPct: c.dailyDrawdown,
        totalReturnPct,
        profitProgressPct,
        tradingDays: tradingDayKeys.size,
        startDate: c.startDate,
        endDate: c.endDate,
      },
    });
  } catch (e) { next(e); }
}
