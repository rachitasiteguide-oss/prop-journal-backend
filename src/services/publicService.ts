// Public-facing data for the marketing site. Replaces the hardcoded
// "500+ traders / 4.9 stars" social-proof bar and invented testimonials
// with real numbers and real, approved user submissions.

import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

export interface PublicStats {
  traderCount: number;   // registered users
  tradeCount:  number;   // total logged trades
  avgRating:   number;   // mean of APPROVED testimonial ratings (0 if none)
  ratingCount: number;   // number of approved testimonials
}

export async function getPublicStats(): Promise<PublicStats> {
  const [traderCount, tradeCount, agg] = await Promise.all([
    prisma.user.count(),
    prisma.trade.count(),
    prisma.testimonial.aggregate({
      where: { approved: true },
      _avg:  { rating: true },
      _count: { _all: true },
    }),
  ]);

  return {
    traderCount,
    tradeCount,
    avgRating:   agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0,
    ratingCount: agg._count._all,
  };
}

export interface PublicTestimonial {
  id:         string;
  authorName: string;
  role:       string | null;
  quote:      string;
  rating:     number;
  createdAt:  Date;
}

export async function getApprovedTestimonials(limit = 12): Promise<PublicTestimonial[]> {
  const rows = await prisma.testimonial.findMany({
    where:   { approved: true },
    orderBy: { createdAt: 'desc' },
    take:    Math.min(Math.max(limit, 1), 50),
    select:  { id: true, authorName: true, role: true, quote: true, rating: true, createdAt: true },
  });
  return rows;
}

export async function submitTestimonial(
  userId: string,
  input: { quote: string; role?: string; rating: number },
): Promise<{ id: string; approved: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  if (!user) throw new AppError('User not found', 404);

  const quote = input.quote.trim();
  if (quote.length < 20 || quote.length > 600) {
    throw new AppError('Testimonial must be between 20 and 600 characters.', 400);
  }
  const rating = Math.round(input.rating);
  if (rating < 1 || rating > 5) {
    throw new AppError('Rating must be between 1 and 5.', 400);
  }

  // One pending/active testimonial per user — re-submitting replaces the
  // previous unapproved one rather than spamming the moderation queue.
  const existingPending = await prisma.testimonial.findFirst({
    where: { userId, approved: false },
    select: { id: true },
  });

  const data = {
    authorName: user.name?.trim() || 'Prop Journal Trader',
    role:       input.role?.trim() || null,
    quote,
    rating,
    approved:   false,
  };

  if (existingPending) {
    const updated = await prisma.testimonial.update({
      where: { id: existingPending.id },
      data,
      select: { id: true, approved: true },
    });
    return updated;
  }

  const created = await prisma.testimonial.create({
    data: { ...data, userId },
    select: { id: true, approved: true },
  });
  return created;
}
