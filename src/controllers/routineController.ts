import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getRoutines,
  getUserStreak,
  toggleRoutineItem,
  resetRoutine,
  addRoutineItem,
  updateRoutineItem,
  deleteRoutineItem,
  createRoutine,
  deleteRoutine,
} from '../services/routineService';

export async function getRoutinesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getRoutines(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

export async function getStreakHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const streak = await getUserStreak(req.currentUser!.userId);
    res.json({ status: 'success', data: { streak } });
  } catch (error) {
    next(error);
  }
}

export async function toggleItemHandler(
  req: Request<{ routineId: string; itemId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await toggleRoutineItem(
      req.currentUser!.userId,
      req.params.routineId,
      req.params.itemId,
    );
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function resetRoutineHandler(
  req: Request<{ routineId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await resetRoutine(req.currentUser!.userId, req.params.routineId);
    res.json({ status: 'success', data: null });
  } catch (error) {
    next(error);
  }
}

export async function addItemHandler(
  req: Request<{ routineId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { text } = z.object({ text: z.string().min(1).max(200) }).parse(req.body);
    const item = await addRoutineItem(req.currentUser!.userId, req.params.routineId, text);
    res.status(201).json({ status: 'success', data: item });
  } catch (error) {
    next(error);
  }
}

export async function updateItemHandler(
  req: Request<{ routineId: string; itemId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { text } = z.object({ text: z.string().min(1).max(200) }).parse(req.body);
    const item = await updateRoutineItem(req.currentUser!.userId, req.params.routineId, req.params.itemId, text);
    res.json({ status: 'success', data: item });
  } catch (error) {
    next(error);
  }
}

export async function deleteItemHandler(
  req: Request<{ routineId: string; itemId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await deleteRoutineItem(req.currentUser!.userId, req.params.routineId, req.params.itemId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function createRoutineHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    const routine = await createRoutine(req.currentUser!.userId, name);
    res.status(201).json({ status: 'success', data: routine });
  } catch (error) {
    next(error);
  }
}

export async function deleteRoutineHandler(
  req: Request<{ routineId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await deleteRoutine(req.currentUser!.userId, req.params.routineId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
