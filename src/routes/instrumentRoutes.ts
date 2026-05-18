import { Router, Request, Response } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import { getInstruments } from '../services/instrumentService';

const router = Router();

router.use(requireAuth);

// GET /api/v1/instruments — canonical instrument + pip-value list.
router.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'success', data: getInstruments() });
});

export default router;
