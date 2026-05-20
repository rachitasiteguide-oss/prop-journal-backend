import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import {
  presignScreenshotUpload,
  presignScreenshotRead,
  objectExists,
  deleteObject,
  isStorageConfigured,
} from '../services/storageService';

// Guard used by every handler so the endpoints fail fast with a clear 503
// instead of leaking AWS SDK errors when R2 credentials aren't configured.
function requireStorage(): void {
  if (!isStorageConfigured()) {
    throw new AppError(
      'Screenshot storage is not configured on this server',
      503,
    );
  }
}

async function getOwnedTrade(userId: string, tradeId: string) {
  const trade = await prisma.trade.findFirst({
    where: { id: tradeId, account: { userId } },
    select: { id: true, screenshotKey: true },
  });
  if (!trade) throw new AppError('Trade not found', 404);
  return trade;
}

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  contentLength: z.number().int().positive(),
});

export async function presignScreenshotHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireStorage();
    const data = presignSchema.parse(req.body);
    const trade = await getOwnedTrade(req.currentUser!.userId, req.params.id);
    const result = await presignScreenshotUpload({
      userId: req.currentUser!.userId,
      tradeId: trade.id,
      filename: data.filename,
      contentType: data.contentType,
      contentLength: data.contentLength,
    });
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

const confirmSchema = z.object({
  key: z.string().min(1).max(500),
});

export async function confirmScreenshotHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireStorage();
    const data = confirmSchema.parse(req.body);
    const trade = await getOwnedTrade(req.currentUser!.userId, req.params.id);

    // The key must belong to this user + trade — stops anyone confirming
    // an attacker-controlled key into someone else's row.
    const expectedPrefix = `screenshots/${req.currentUser!.userId}/${trade.id}/`;
    if (!data.key.startsWith(expectedPrefix)) {
      throw new AppError('Screenshot key does not belong to this trade', 403);
    }

    if (!(await objectExists(data.key))) {
      throw new AppError('Screenshot was not uploaded successfully', 400);
    }

    // If a previous screenshot exists, delete it from R2 so we don't
    // accumulate orphaned objects.
    if (trade.screenshotKey && trade.screenshotKey !== data.key) {
      await deleteObject(trade.screenshotKey).catch(() => {
        // Non-fatal: the new key is saved either way. The orphan will get
        // cleaned up by a future garbage-collect job.
      });
    }

    await prisma.trade.update({
      where: { id: trade.id },
      data: { screenshotKey: data.key },
    });
    res.json({ status: 'success', data: { key: data.key } });
  } catch (error) {
    next(error);
  }
}

export async function getScreenshotHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireStorage();
    const trade = await getOwnedTrade(req.currentUser!.userId, req.params.id);
    if (!trade.screenshotKey) {
      res.json({ status: 'success', data: null });
      return;
    }
    const url = await presignScreenshotRead(trade.screenshotKey);
    res.json({ status: 'success', data: { url, key: trade.screenshotKey } });
  } catch (error) {
    next(error);
  }
}

export async function deleteScreenshotHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireStorage();
    const trade = await getOwnedTrade(req.currentUser!.userId, req.params.id);
    if (trade.screenshotKey) {
      await deleteObject(trade.screenshotKey).catch(() => {
        // ignore — db record is still cleared below
      });
      await prisma.trade.update({
        where: { id: trade.id },
        data: { screenshotKey: null },
      });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
