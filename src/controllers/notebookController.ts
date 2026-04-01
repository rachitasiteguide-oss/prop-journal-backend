import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// ─── Validation schemas ────────────────────────────────────────────────────────

const createFolderSchema = z.object({
  name: z.string().min(1).max(80),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(80),
});

const createNoteSchema = z.object({
  title:    z.string().min(1).max(200),
  content:  z.string().default(''),
  type:     z.enum(['NOTE', 'TRADE_IDEA', 'MARKET_ANALYSIS', 'WEEKLY_REVIEW', 'STRATEGY']).default('NOTE'),
  status:   z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE'),
  folderId: z.string().cuid().nullable().optional(),
});

const updateNoteSchema = z.object({
  title:    z.string().min(1).max(200).optional(),
  content:  z.string().optional(),
  type:     z.enum(['NOTE', 'TRADE_IDEA', 'MARKET_ANALYSIS', 'WEEKLY_REVIEW', 'STRATEGY']).optional(),
  status:   z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  folderId: z.string().cuid().nullable().optional(),
});

// ─── Folder handlers ───────────────────────────────────────────────────────────

export async function getFoldersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const folders = await prisma.noteFolder.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { notes: true } } },
    });
    res.json({ status: 'success', data: folders });
  } catch (err) {
    next(err);
  }
}

export async function createFolderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const body = createFolderSchema.parse(req.body);
    const folder = await prisma.noteFolder.create({
      data: { userId, name: body.name },
      include: { _count: { select: { notes: true } } },
    });
    res.status(201).json({ status: 'success', data: folder });
  } catch (err) {
    next(err);
  }
}

export async function updateFolderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    const body = updateFolderSchema.parse(req.body);

    const folder = await prisma.noteFolder.findFirst({ where: { id, userId } });
    if (!folder) return next(new AppError('Folder not found', 404));

    const updated = await prisma.noteFolder.update({
      where: { id },
      data: { name: body.name },
      include: { _count: { select: { notes: true } } },
    });
    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteFolderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;

    const folder = await prisma.noteFolder.findFirst({ where: { id, userId } });
    if (!folder) return next(new AppError('Folder not found', 404));

    await prisma.note.updateMany({ where: { folderId: id, userId }, data: { folderId: null } });
    await prisma.noteFolder.delete({ where: { id } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ─── Note handlers ─────────────────────────────────────────────────────────────

export async function getNotesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId  = req.currentUser!.userId;
    const folderId = typeof req.query['folderId'] === 'string' ? req.query['folderId'] : undefined;
    const search   = typeof req.query['search']   === 'string' ? req.query['search']   : undefined;

    const notes = await prisma.note.findMany({
      where: {
        userId,
        ...(folderId ? { folderId } : {}),
        ...(search   ? { title: { contains: search, mode: 'insensitive' } } : {}),
      },
      include: { folder: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ status: 'success', data: notes });
  } catch (err) {
    next(err);
  }
}

export async function getNoteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;

    const note = await prisma.note.findFirst({
      where: { id, userId },
      include: { folder: { select: { id: true, name: true } } },
    });
    if (!note) return next(new AppError('Note not found', 404));

    res.json({ status: 'success', data: note });
  } catch (err) {
    next(err);
  }
}

export async function createNoteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const body = createNoteSchema.parse(req.body);

    // Verify folder belongs to user if provided
    if (body.folderId) {
      const folder = await prisma.noteFolder.findFirst({ where: { id: body.folderId, userId } });
      if (!folder) return next(new AppError('Folder not found', 404));
    }

    const note = await prisma.note.create({
      data: { userId, ...body },
      include: { folder: { select: { id: true, name: true } } },
    });
    res.status(201).json({ status: 'success', data: note });
  } catch (err) {
    next(err);
  }
}

export async function updateNoteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;
    const body = updateNoteSchema.parse(req.body);

    const note = await prisma.note.findFirst({ where: { id, userId } });
    if (!note) return next(new AppError('Note not found', 404));

    if (body.folderId) {
      const folder = await prisma.noteFolder.findFirst({ where: { id: body.folderId, userId } });
      if (!folder) return next(new AppError('Folder not found', 404));
    }

    const updated = await prisma.note.update({
      where: { id },
      data: body,
      include: { folder: { select: { id: true, name: true } } },
    });
    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteNoteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.currentUser!.userId;
    const id = req.params['id'] as string;

    const note = await prisma.note.findFirst({ where: { id, userId } });
    if (!note) return next(new AppError('Note not found', 404));

    await prisma.note.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
