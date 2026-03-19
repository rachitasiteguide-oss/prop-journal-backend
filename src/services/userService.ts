import { User } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

export type PublicUser = Omit<User, 'googleId' | 'password'>;

export function toPublicUser(user: User): PublicUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { googleId: _g, password: _p, ...publicUser } = user;
  return publicUser;
}

export async function getProfile(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found', 404);
  return toPublicUser(user);
}

export async function updateProfile(
  userId: string,
  data: { name?: string; avatar?: string },
): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
  });
  return toPublicUser(user);
}
