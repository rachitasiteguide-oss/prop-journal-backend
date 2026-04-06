import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';
import { generateMockTrades, SyncMode } from './mockMt5.service';

export interface SyncResult {
  success: true;
  importJobId: string;
  syncedTrades: number;
}

export async function syncAccount(
  accountId: string,
  userId: string,
  mode: SyncMode = 'random',
): Promise<SyncResult> {
  // ── 1. Verify account ownership ──────────────────────────────────────────
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId, isActive: true },
    select: { id: true, accountType: true },
  });

  if (!account) {
    throw new AppError('Account not found', 404);
  }

  // ── 2. Create ImportJob ───────────────────────────────────────────────────
  const job = await prisma.importJob.create({
    data: {
      accountId,
      source: 'mt5_demo',
      status: 'PROCESSING',
    },
  });

  try {
    let syncedTrades = 0;

    // ── 3. Mock MT5 sync (runs for all account types until real MetaAPI is wired) ──
    // TODO: when account.accountType === 'LIVE' and MetaAPI credentials exist, call
    //       the real MetaAPI client here instead of the mock generator.
    const mockTrades = generateMockTrades(mode);

    const result = await prisma.trade.createMany({
      data: mockTrades.map((t) => ({
        accountId,
        importJobId: job.id,
        symbol: t.symbol,
        instrumentType: t.instrumentType,
        side: t.side,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        volume: t.volume,
        pnl: t.pnl,
        commission: t.commission,
        swap: t.swap,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        setup: t.setup,
        status: t.status,
        entryAt: t.entryAt,
        exitAt: t.exitAt,
        externalId: t.externalId,
      })),
      skipDuplicates: true, // deduplicate by (accountId, externalId)
    });

    syncedTrades = result.count;

    // ── 4. Mark job COMPLETED ─────────────────────────────────────────────
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        rowsImported: syncedTrades,
        rowsTotal: syncedTrades,
        finishedAt: new Date(),
      },
    });

    return { success: true, importJobId: job.id, syncedTrades };
  } catch (err) {
    // ── 5. Mark job FAILED ────────────────────────────────────────────────
    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
    throw err;
  }
}
