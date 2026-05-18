import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AccountType } from '@prisma/client';
import { getAccounts, createAccount, getAccountsOverview } from '../services/accountService';

const createAccountSchema = z.object({
  name: z.string().min(1).max(100),
  broker: z.string().max(100).optional(),
  accountType: z.nativeEnum(AccountType).optional(),
  balance: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
});

export async function getAccountsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const accounts = await getAccounts(req.currentUser!.userId);
    res.json({ status: 'success', data: accounts });
  } catch (error) {
    next(error);
  }
}

export async function getAccountsOverviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getAccountsOverview(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
}

export async function createAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = createAccountSchema.parse(req.body);
    const account = await createAccount(req.currentUser!.userId, data);
    res.status(201).json({ status: 'success', data: account });
  } catch (error) {
    next(error);
  }
}
