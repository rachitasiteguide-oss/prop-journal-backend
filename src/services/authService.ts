import { User } from '@prisma/client';
import bcrypt from 'bcrypt';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

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
