import { User } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { env } from '../config/env';
import { sendPasswordResetEmail } from '../utils/email';

const SALT_ROUNDS = 12;

export async function getUserById(userId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found', 404);
  return user;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export async function registerWithEmail(
  email: string,
  password: string,
  name?: string,
): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError('Email already registered', 409);

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  return prisma.user.create({
    data: { email, name: name ?? null, password: hashedPassword },
  });
}

export async function loginWithEmail(email: string, password: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password) throw new AppError('Invalid email or password', 401);

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throw new AppError('Invalid email or password', 401);

  return user;
}

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

export async function createPasswordResetToken(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always respond the same way to prevent email enumeration
  if (!user || !user.password) return;

  // Invalidate any existing unused tokens for this user
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_EXPIRY_MS),
    },
  });

  const resetUrl = `${env.CLIENT_URL}/reset-password?token=${rawToken}`;

  await sendPasswordResetEmail(email, resetUrl);
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AppError('This reset link is invalid or has expired. Please request a new one.', 400);
  }

  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { password: hashed } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
}
