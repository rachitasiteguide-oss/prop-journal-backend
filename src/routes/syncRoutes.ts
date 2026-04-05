import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import { syncAccountHandler } from '../controllers/sync.controller';

const router = Router({ mergeParams: true });

router.use(requireAuth);

// POST /accounts/:accountId/sync?mode=profitable|losing|random
router.post('/', syncAccountHandler);

export default router;
