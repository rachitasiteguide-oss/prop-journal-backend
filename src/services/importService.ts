import { ImportJobStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { parseStatement, type ParsedTrade, type StatementFormat, type RowError } from './statementParser';

// Returns the calendar date in the given IANA timezone as YYYY-MM-DD. String
// comparison preserves chronological ordering. Used by snapshot bucketing
// below to honour the firm's day boundary, not the server's UTC clock.
function dayKeyInTz(d: Date | string, tz: string): string {
  const date = d instanceof Date ? d : new Date(d);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}

// After a successful import, rebuild DailySnapshot rows for the account and
// (if there's an active challenge bound) stamp Challenge.currentEquity with
// the latest running balance. Idempotent — wipes and recreates so the
// derived view always matches the source-of-truth trades.
//
// Snapshots only get built when an active challenge exists on the account
// because we need a startingBalance to compute openBalance/closeBalance. For
// untracked accounts the snapshot rebuild is a no-op.
async function rebuildSnapshotsFromTrades(accountId: string): Promise<void> {
  const challenge = await prisma.challenge.findFirst({
    where: { accountId, status: 'ACTIVE' },
    select: { id: true, accountSize: true, timezone: true },
  });
  if (!challenge) return;

  const trades = await prisma.trade.findMany({
    where: { accountId, status: 'CLOSED', exitAt: { not: null } },
    select: { exitAt: true, pnl: true, commission: true },
    orderBy: { exitAt: 'asc' },
  });

  const tz = challenge.timezone || 'UTC';

  // Bucket by firm-day so intraday trades collapse into one snapshot row.
  const days = new Map<string, { pnl: number; commissions: number; tradeCount: number }>();
  for (const t of trades) {
    if (!t.exitAt) continue;
    const key = dayKeyInTz(t.exitAt, tz);
    const existing = days.get(key) ?? { pnl: 0, commissions: 0, tradeCount: 0 };
    existing.pnl += t.pnl ?? 0;
    existing.commissions += t.commission ?? 0;
    existing.tradeCount += 1;
    days.set(key, existing);
  }

  let running = challenge.accountSize;
  const rows: Prisma.DailySnapshotCreateManyInput[] = [];
  for (const dayKey of [...days.keys()].sort()) {
    const d = days.get(dayKey)!;
    const open = running;
    running += d.pnl;
    rows.push({
      accountId,
      // @db.Date stores only the date portion. The firm-TZ day key is
      // serialised as UTC midnight of that date — read with the same TZ
      // assumption to round-trip cleanly.
      date: new Date(`${dayKey}T00:00:00Z`),
      openBalance: open,
      closeBalance: running,
      pnl: d.pnl,
      commissions: d.commissions,
      tradeCount: d.tradeCount,
    });
  }

  await prisma.$transaction([
    prisma.dailySnapshot.deleteMany({ where: { accountId } }),
    ...(rows.length > 0 ? [prisma.dailySnapshot.createMany({ data: rows })] : []),
    prisma.challenge.update({
      where: { id: challenge.id },
      data: { currentEquity: running, equityUpdatedAt: new Date() },
    }),
  ]);
}

// Pure dedupe step extracted for unit-testing. Splits parsed trades into
// "to insert" vs "skipped (duplicate externalId)" given the set of externalIds
// already present in this account.
export interface DedupeResult {
  toInsert: ParsedTrade[];
  duplicates: ParsedTrade[];
}

export function dedupeAgainstExisting(
  parsed: ParsedTrade[],
  existingExternalIds: Set<string>,
): DedupeResult {
  const toInsert: ParsedTrade[] = [];
  const duplicates: ParsedTrade[] = [];
  // Also guard against the same externalId appearing twice in the file itself.
  const seenInFile = new Set<string>();
  for (const t of parsed) {
    if (existingExternalIds.has(t.externalId) || seenInFile.has(t.externalId)) {
      duplicates.push(t);
      continue;
    }
    seenInFile.add(t.externalId);
    toInsert.push(t);
  }
  return { toInsert, duplicates };
}

function classifyJobStatus(
  inserted: number,
  errors: number,
  parsedCount: number,
): ImportJobStatus {
  if (parsedCount === 0 && errors > 0) return 'FAILED';
  if (errors === 0) return 'COMPLETED';
  return inserted > 0 ? 'PARTIAL' : 'FAILED';
}

export interface RunImportInput {
  userId: string;
  accountId: string;
  fileName?: string;
  content: string;
}

export interface RunImportResult {
  jobId: string;
  status: ImportJobStatus;
  format: StatementFormat;
  rowsParsed: number;
  rowsImported: number;
  duplicates: number;
  errors: RowError[];
}

export async function runImport(input: RunImportInput): Promise<RunImportResult> {
  // Make sure the account belongs to the calling user. Prevents trade
  // injection into someone else's account by guessing a CUID.
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, userId: input.userId, isActive: true },
    select: { id: true },
  });
  if (!account) throw new AppError('Account not found', 404);

  const { format, trades, errors } = parseStatement(input.content);

  const job = await prisma.importJob.create({
    data: {
      accountId: input.accountId,
      source: format,
      fileName: input.fileName,
      status: 'PROCESSING',
      rowsTotal: trades.length,
    },
    select: { id: true },
  });

  // Pull existing externalIds for this account so we can dedupe in one round
  // trip rather than per-row.
  const existing = await prisma.trade.findMany({
    where: { accountId: input.accountId, externalId: { not: null } },
    select: { externalId: true },
  });
  const existingIds = new Set(existing.map((e) => e.externalId!).filter(Boolean));
  const { toInsert, duplicates } = dedupeAgainstExisting(trades, existingIds);

  let inserted = 0;
  if (toInsert.length > 0) {
    const created = await prisma.trade.createMany({
      data: toInsert.map((t) => ({
        accountId: input.accountId,
        importJobId: job.id,
        externalId: t.externalId,
        symbol: t.symbol,
        side: t.side,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice ?? undefined,
        volume: t.volume,
        pnl: t.pnl ?? undefined,
        commission: t.commission ?? undefined,
        swap: t.swap ?? undefined,
        stopLoss: t.stopLoss ?? undefined,
        takeProfit: t.takeProfit ?? undefined,
        entryAt: t.entryAt,
        exitAt: t.exitAt ?? undefined,
        status: t.status,
      })),
      // The composite unique on (accountId, externalId) means a race with
      // another concurrent import would conflict — skip those instead of
      // failing the whole transaction.
      skipDuplicates: true,
    });
    inserted = created.count;
  }

  const status = classifyJobStatus(inserted, errors.length, trades.length);

  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status,
      rowsImported: inserted,
      errors: errors.length > 0 ? (errors as unknown as Prisma.InputJsonValue) : undefined,
      finishedAt: new Date(),
    },
  });

  // Rebuild DailySnapshot rows + push live equity into the bound challenge.
  // Best-effort — log but don't fail the import if this step trips, since the
  // trades are already saved and a future import will rebuild correctly.
  if (inserted > 0) {
    try {
      await rebuildSnapshotsFromTrades(input.accountId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('rebuildSnapshotsFromTrades failed', err);
    }
  }

  return {
    jobId: job.id,
    status,
    format,
    rowsParsed: trades.length,
    rowsImported: inserted,
    duplicates: duplicates.length + (toInsert.length - inserted),
    errors,
  };
}

export async function listImportJobs(userId: string, accountId?: string) {
  return prisma.importJob.findMany({
    where: {
      account: { userId },
      ...(accountId ? { accountId } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      accountId: true,
      source: true,
      fileName: true,
      status: true,
      rowsTotal: true,
      rowsImported: true,
      errors: true,
      startedAt: true,
      finishedAt: true,
    },
  });
}

export async function getImportJob(userId: string, jobId: string) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, account: { userId } },
    select: {
      id: true,
      accountId: true,
      source: true,
      fileName: true,
      status: true,
      rowsTotal: true,
      rowsImported: true,
      errors: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  if (!job) throw new AppError('Import job not found', 404);
  return job;
}

// Exposed for tests so callers don't have to import from a deep path.
export { classifyJobStatus };
