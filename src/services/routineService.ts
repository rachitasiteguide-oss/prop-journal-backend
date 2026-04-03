import { RoutineType } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// ── Default routines seeded for new users ────────────────────────────────────

const DEFAULT_ROUTINES: { name: string; routineType: RoutineType; items: string[] }[] = [
  {
    name: 'Pre-Market Checklist',
    routineType: 'PRE_MARKET',
    items: [
      'Check economic calendar for high-impact news',
      'Review overnight market moves and gaps',
      'Mark key support/resistance levels on charts',
      'Set up watchlist with potential trades',
      'Review trading plan and daily goals',
      'Check mental state — am I clear-headed?',
      'Ensure risk parameters are set correctly',
    ],
  },
  {
    name: 'During Trade Reminders',
    routineType: 'DURING_TRADE',
    items: [
      'Follow entry rules — no impulse trades',
      'Set stop loss before entering',
      'Avoid moving stop loss against position',
      'Do not risk more than daily limit',
      'Log entry reason in journal',
      'Step away if emotional or frustrated',
    ],
  },
  {
    name: 'Post-Market Review',
    routineType: 'POST_MARKET',
    items: [
      'Record all trades in journal with screenshots',
      'Calculate daily P&L and update statistics',
      'Review what went well today',
      'Identify areas for improvement',
      'Note any patterns or lessons learned',
      'Prepare for tomorrow — mark key levels',
      'Close trading platform and disconnect mentally',
    ],
  },
];

export async function seedDefaultRoutines(userId: string): Promise<void> {
  const existing = await prisma.routine.findFirst({ where: { userId, isDefault: true } });
  if (existing) return; // already seeded

  for (let i = 0; i < DEFAULT_ROUTINES.length; i++) {
    const def = DEFAULT_ROUTINES[i];
    const routine = await prisma.routine.create({
      data: {
        userId,
        name: def.name,
        routineType: def.routineType,
        isDefault: true,
      },
    });
    await prisma.routineItem.createMany({
      data: def.items.map((text, position) => ({
        routineId: routine.id,
        text,
        position,
      })),
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function verifyRoutineOwnership(userId: string, routineId: string) {
  const routine = await prisma.routine.findUnique({ where: { id: routineId } });
  if (!routine) throw new AppError('Routine not found', 404);
  if (routine.userId !== userId) throw new AppError('Forbidden', 403);
  return routine;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getRoutines(userId: string) {
  await seedDefaultRoutines(userId);

  const today = todayUTC();
  const routines = await prisma.routine.findMany({
    where: { userId },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: {
          completions: {
            where: { date: today },
          },
        },
      },
    },
    orderBy: [{ routineType: 'asc' }, { createdAt: 'asc' }],
  });

  return routines.map((r) => ({
    id: r.id,
    name: r.name,
    routineType: r.routineType,
    isDefault: r.isDefault,
    items: r.items.map((item) => ({
      id: item.id,
      text: item.text,
      position: item.position,
      completedToday: item.completions.length > 0 && item.completions[0].completed,
    })),
    completedCount: r.items.filter((item) => item.completions.length > 0 && item.completions[0].completed).length,
    totalCount: r.items.length,
  }));
}

// ── Streak ────────────────────────────────────────────────────────────────────

export async function getUserStreak(userId: string): Promise<number> {
  // Get all routines for this user
  const routineIds = await prisma.routine
    .findMany({ where: { userId }, select: { id: true } })
    .then((rs) => rs.map((r) => r.id));

  if (routineIds.length === 0) return 0;

  // Find all days where ALL routines were fully completed
  const completions = await prisma.routineCompletion.findMany({
    where: { routineId: { in: routineIds }, allDone: true },
    orderBy: { date: 'desc' },
  });

  // Group by date
  const byDate = new Map<string, number>();
  for (const c of completions) {
    const key = c.date.toISOString().split('T')[0];
    byDate.set(key, (byDate.get(key) ?? 0) + 1);
  }

  // Count consecutive days (from today backward) where all routines done
  let streak = 0;
  const today = todayUTC();

  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().split('T')[0];
    const count = byDate.get(key) ?? 0;
    if (count >= routineIds.length) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

// ── Toggle item ───────────────────────────────────────────────────────────────

export async function toggleRoutineItem(userId: string, routineId: string, itemId: string) {
  await verifyRoutineOwnership(userId, routineId);

  const item = await prisma.routineItem.findUnique({ where: { id: itemId } });
  if (!item || item.routineId !== routineId) throw new AppError('Item not found', 404);

  const today = todayUTC();

  const existing = await prisma.routineItemCompletion.findUnique({
    where: { routineItemId_date: { routineItemId: itemId, date: today } },
  });

  let completedToday: boolean;
  if (existing) {
    await prisma.routineItemCompletion.delete({
      where: { routineItemId_date: { routineItemId: itemId, date: today } },
    });
    completedToday = false;
  } else {
    await prisma.routineItemCompletion.create({
      data: { routineItemId: itemId, date: today, completed: true },
    });
    completedToday = true;
  }

  // Update aggregate for this routine + date
  await updateRoutineCompletion(routineId, today);

  return { completedToday };
}

async function updateRoutineCompletion(routineId: string, date: Date) {
  const items = await prisma.routineItem.findMany({
    where: { routineId },
    include: { completions: { where: { date } } },
  });

  const totalItems = items.length;
  const completedItems = items.filter((i) => i.completions.length > 0 && i.completions[0].completed).length;
  const allDone = totalItems > 0 && completedItems === totalItems;

  await prisma.routineCompletion.upsert({
    where: { routineId_date: { routineId, date } },
    create: { routineId, date, totalItems, completedItems, allDone },
    update: { totalItems, completedItems, allDone },
  });
}

// ── Reset routine for today ───────────────────────────────────────────────────

export async function resetRoutine(userId: string, routineId: string) {
  await verifyRoutineOwnership(userId, routineId);

  const today = todayUTC();
  const items = await prisma.routineItem.findMany({ where: { routineId }, select: { id: true } });

  await prisma.routineItemCompletion.deleteMany({
    where: { routineItemId: { in: items.map((i) => i.id) }, date: today },
  });

  await prisma.routineCompletion.deleteMany({ where: { routineId, date: today } });
}

// ── CRUD items ────────────────────────────────────────────────────────────────

export async function addRoutineItem(userId: string, routineId: string, text: string) {
  await verifyRoutineOwnership(userId, routineId);

  const count = await prisma.routineItem.count({ where: { routineId } });
  return prisma.routineItem.create({ data: { routineId, text, position: count } });
}

export async function updateRoutineItem(
  userId: string,
  routineId: string,
  itemId: string,
  text: string,
) {
  await verifyRoutineOwnership(userId, routineId);
  return prisma.routineItem.update({ where: { id: itemId }, data: { text } });
}

export async function deleteRoutineItem(userId: string, routineId: string, itemId: string) {
  await verifyRoutineOwnership(userId, routineId);
  await prisma.routineItem.delete({ where: { id: itemId } });
}

// ── CRUD routines ─────────────────────────────────────────────────────────────

export async function createRoutine(userId: string, name: string) {
  return prisma.routine.create({
    data: { userId, name, routineType: 'CUSTOM', isDefault: false },
  });
}

export async function deleteRoutine(userId: string, routineId: string) {
  const routine = await verifyRoutineOwnership(userId, routineId);
  if (routine.isDefault) throw new AppError('Cannot delete default routines', 400);
  await prisma.routine.delete({ where: { id: routineId } });
}
