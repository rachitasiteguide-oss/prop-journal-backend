import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import { z } from 'zod';
import { signToken, setAuthCookie, clearAuthCookie } from '../utils/jwt';
import { getUserById, registerWithEmail, loginWithEmail } from '../services/authService';
import { toPublicUser } from '../services/userService';
import { env } from '../config/env';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

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

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password, name } = registerSchema.parse(req.body);
    const user = await registerWithEmail(email, password, name);
    const token = signToken({ userId: user.id, email: user.email });
    setAuthCookie(res, token);
    res.status(201).json({ status: 'success', data: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await loginWithEmail(email, password);
    const token = signToken({ userId: user.id, email: user.email });
    setAuthCookie(res, token);
    res.json({ status: 'success', data: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getUserById(req.currentUser!.userId);
    res.json({ status: 'success', data: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
}
