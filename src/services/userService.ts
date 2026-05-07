import { User } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

export type PublicUser = Omit<User, 'googleId' | 'password'>;

export function toPublicUser(user: User): PublicUser {
  const { googleId: _g, password: _p, ...publicUser } = user;
  return publicUser;
}

export async function getProfile(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found', 404);
  // Auto-generate referral code if missing
  if (!user.referralCode) {
    const code = 'PJ-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const updated = await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
    return toPublicUser(updated);
  }
  return toPublicUser(user);
}

export async function updateProfile(
  userId: string,
  data: {
    name?: string;
    avatar?: string;
    bio?: string;
    phone?: string;
    country?: string;
    timezone?: string;
    challengeConfig?: object;
  },
): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
  });
  return toPublicUser(user);
}

export async function toggleTradingLock(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found', 404);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { tradingLocked: !user.tradingLocked },
  });
  return toPublicUser(updated);
}

export async function completeOnboarding(userId: string): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { onboardingCompleted: true },
  });
  return toPublicUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found', 404);
  if (!user.password) throw new AppError('Password change not available for OAuth accounts', 400);
  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) throw new AppError('Current password is incorrect', 401);
  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { password: hashed } });
}
