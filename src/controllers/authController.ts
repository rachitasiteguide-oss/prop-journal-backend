import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import { signToken, setAuthCookie, clearAuthCookie } from '../utils/jwt';
import { getUserById } from '../services/authService';
import { toPublicUser } from '../services/userService';
import { env } from '../config/env';

export async function googleCallback(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // req.user is set by Passport after Google OAuth
    const user = req.user as unknown as User;
    const token = signToken({ userId: user.id, email: user.email });
    setAuthCookie(res, token);
    res.redirect(`${env.CLIENT_URL}/dashboard`);
  } catch (error) {
    next(error);
  }
}

export async function logout(_req: Request, res: Response): Promise<void> {
  clearAuthCookie(res);
  res.json({ status: 'success', message: 'Logged out successfully' });
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getUserById(req.currentUser!.userId);
    res.json({ status: 'success', data: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
}
