import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getUpcomingEvents,
  getWeeklyEvents,
  detectNewsWindowTrades,
  type ImpactLevel,
} from '../services/economicCalendarService';
import { getTrades } from '../services/tradeService';

const impactSchema = z
  .enum(['High', 'Medium', 'Low', 'None'])
  .default('High');

export async function getUpcomingEventsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const impact: ImpactLevel = impactSchema.parse(
      typeof req.query.impact === 'string' ? req.query.impact : undefined,
    );
    const events = await getUpcomingEvents(impact);
    res.json({ status: 'success', data: events });
  } catch (error) {
    next(error);
  }
}

const riskQuerySchema = z.object({
  beforeMin: z.coerce.number().int().min(0).max(720).default(15),
  afterMin: z.coerce.number().int().min(0).max(720).default(15),
  minImpact: impactSchema,
});

/**
 * Trades the user opened inside a high-impact news window. Returns the flagged
 * trades plus a summary so the dashboard can show "N trades opened into news".
 */
export async function getNewsRiskHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { beforeMin, afterMin, minImpact } = riskQuerySchema.parse(req.query);

    const raw = req.query.accountIds;
    let accountIds: string[] | undefined;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      accountIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      accountIds = (raw as string[]).map((s) => s.trim()).filter(Boolean);
    }

    const [trades, events] = await Promise.all([
      getTrades(req.currentUser!.userId, accountIds),
      getWeeklyEvents(),
    ]);

    const hits = detectNewsWindowTrades(
      trades.map((t) => ({ id: t.id, symbol: t.symbol, entryAt: t.entryAt })),
      events,
      { beforeMin, afterMin, minImpact },
    );

    res.json({
      status: 'success',
      data: {
        windowMinutes: { before: beforeMin, after: afterMin },
        minImpact,
        flaggedCount: hits.length,
        totalTrades: trades.length,
        hits,
      },
    });
  } catch (error) {
    next(error);
  }
}
