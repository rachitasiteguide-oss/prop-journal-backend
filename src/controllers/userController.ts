import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getProfile, updateProfile } from '../services/userService';

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().url().optional(),
});

export async function getProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await getProfile(req.currentUser!.userId);
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
}

export async function updateProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = updateProfileSchema.parse(req.body);
    const user = await updateProfile(req.currentUser!.userId, data);
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
}
