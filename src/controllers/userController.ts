import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getProfile, updateProfile, changePassword, completeOnboarding } from '../services/userService';

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  phone: z.string().max(20).optional(),
  country: z.string().max(60).optional(),
  timezone: z.string().max(60).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(100),
});

export async function getProfileHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getProfile(req.currentUser!.userId);
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
}

export async function updateProfileHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = updateProfileSchema.parse(req.body);
    const user = await updateProfile(req.currentUser!.userId, data);
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
}

export async function completeOnboardingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await completeOnboarding(req.currentUser!.userId);
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
}

export async function changePasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    await changePassword(req.currentUser!.userId, currentPassword, newPassword);
    res.json({ status: 'success', message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
}
