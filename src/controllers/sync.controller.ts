import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { syncAccount } from '../services/sync.service';
import { SyncMode } from '../services/mockMt5.service';

const syncQuerySchema = z.object({
  mode: z.enum(['profitable', 'losing', 'random']).optional().default('random'),
});

export async function syncAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const accountId = String(req.params.accountId);
    const { mode } = syncQuerySchema.parse(req.query);

    const result = await syncAccount(accountId, req.currentUser!.userId, mode as SyncMode);

    res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}
