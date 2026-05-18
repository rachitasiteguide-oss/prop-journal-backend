import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  patternScanHandler,
  getPatternScanHandler,
  weeklyReviewHandler,
  getWeeklyReviewHandler,
  sendWeeklyReviewEmailHandler,
} from '../controllers/aiController';

const router = Router();

router.use(requireAuth);

router.post('/pattern-scan', patternScanHandler);
router.get('/pattern-scan', getPatternScanHandler);
router.post('/weekly-review', weeklyReviewHandler);
router.get('/weekly-review', getWeeklyReviewHandler);
router.post('/weekly-review/email', sendWeeklyReviewEmailHandler);

export default router;
