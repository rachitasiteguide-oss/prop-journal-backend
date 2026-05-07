import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import { z } from 'zod';
import { signToken, setAuthCookie, clearAuthCookie } from '../utils/jwt';
import { getUserById, registerWithEmail, loginWithEmail, createPasswordResetToken, resetPassword } from '../services/authService';
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
    // Redirect to the frontend cookie-setter route.
    // The backend and frontend are on different domains so we cannot set
    // the cookie here — the frontend's /api/auth/callback route sets it on
    // its own domain, then redirects the user to /dashboard.
    res.redirect(`${env.CLIENT_URL}/api/auth/callback?token=${token}`);
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

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    await createPasswordResetToken(email);
    // Always respond with success to prevent email enumeration
    res.json({ status: 'success', message: 'If that email is registered, a reset link has been sent.' });
  } catch (error) {
    next(error);
  }
}

export async function resetPasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await resetPassword(token, password);
    res.json({ status: 'success', message: 'Password updated successfully. You can now log in.' });
  } catch (error) {
    next(error);
  }
}
