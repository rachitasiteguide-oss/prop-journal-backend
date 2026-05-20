import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { runImport, listImportJobs, getImportJob } from '../services/importService';

// File content arrives as a JSON string (frontend reads it with FileReader and
// posts the text). Keeps the endpoint dep-free of multer for now; an
// upload-multipart variant can layer on top later without changing the service.
const importSchema = z.object({
  accountId: z.string().cuid('Invalid account ID'),
  fileName: z.string().max(255).optional(),
  // ~10 MB of UTF-8 text — generous for even multi-year MT5 history exports.
  content: z.string().min(1).max(10_000_000),
});

export async function createImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = importSchema.parse(req.body);
    const result = await runImport({
      userId: req.currentUser!.userId,
      accountId: data.accountId,
      fileName: data.fileName,
      content: data.content,
    });
    res.status(201).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function listImportsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    const jobs = await listImportJobs(req.currentUser!.userId, accountId);
    res.json({ status: 'success', data: jobs });
  } catch (error) {
    next(error);
  }
}

export async function getImportHandler(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const job = await getImportJob(req.currentUser!.userId, req.params.id);
    res.json({ status: 'success', data: job });
  } catch (error) {
    next(error);
  }
}
