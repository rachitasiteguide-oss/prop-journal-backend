import { ImportJobStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { parseStatement, type ParsedTrade, type StatementFormat, type RowError } from './statementParser';

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
