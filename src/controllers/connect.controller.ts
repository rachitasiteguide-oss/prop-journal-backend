import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { connectMt5Account } from '../services/connect.service';

// ── Validation ────────────────────────────────────────────────────────────────

const connectBodySchema = z.object({
  /** MT5 account login/number (e.g. "12345678") */
  accountId: z.string().min(1, 'MT5 login ID is required'),
  /** Investor or trading password — never stored */
  password: z.string().min(1, 'Password is required'),
  /** Broker server address (e.g. "demo.broker.com:443") */
  server: z.string().min(1, 'Server address is required'),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export async function connectMt5Handler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = connectBodySchema.parse(req.body);
    // body fields are validated and forwarded — service prefixes param with _ in demo mode
    const result = await connectMt5Account(req.currentUser!.userId, body);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}
