import { Request, Response, NextFunction } from 'express';
import { getAccounts } from '../services/accountService';

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
