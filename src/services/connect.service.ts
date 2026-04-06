import { prisma } from '../config/db';
import { AppError } from '../middlewares/errorHandler';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectMt5Input {
  /** MT5 account login number (not stored) */
  accountId: string;
  /** MT5 investor/trading password (never stored) */
  password: string;
  /** Broker server address, e.g. demo.broker.com:443 */
  server: string;
}

export interface ConnectResult {
  success: true;
  accountId: string; // our DB account id
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Simulates an MT5 broker handshake.
 * - Accepts any credentials (demo mode — no real API call).
 * - Delays 1–2 s to feel authentic.
 * - Fails ~10% of the time to simulate connection errors.
 * - Creates an Account record on success (password is never persisted).
 */
export async function connectMt5Account(
  userId: string,
  _input: ConnectMt5Input, // credentials intentionally unused in demo mode — TODO: pass to MetaAPI
): Promise<ConnectResult> {
  // ── 1. Simulate broker handshake latency ─────────────────────────────────
  const delayMs = 1000 + Math.random() * 1000; // 1 000 – 2 000 ms
  await sleep(delayMs);

  // ── 2. Simulate ~10% connection failure ──────────────────────────────────
  if (Math.random() < 0.1) {
    throw new AppError(
      'Failed to connect to MT5 server. Please verify your credentials and try again.',
      502,
    );
  }

  // ── 3. Create Account — password is intentionally NOT stored ─────────────
  const account = await prisma.account.create({
    data: {
      userId,
      name: 'MT5 Demo Account',
      broker: 'MetaTrader 5 (Demo)',
      accountType: 'DEMO',
      balance: 10_000,
      currency: 'USD',
      isActive: true,
    },
    select: { id: true },
  });

  return { success: true, accountId: account.id };
}
