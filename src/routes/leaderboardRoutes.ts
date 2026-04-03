import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getLeaderboardHandler,
  getLeaderboardStatusHandler,
  updateLeaderboardVisibilityHandler,
} from '../controllers/leaderboardController';

const router = Router();

router.use(requireAuth);

router.get('/', getLeaderboardHandler);
router.get('/status', getLeaderboardStatusHandler);
router.patch('/visibility', updateLeaderboardVisibilityHandler);

export default router;
