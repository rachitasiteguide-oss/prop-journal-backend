import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getUpcomingEventsHandler,
  getNewsRiskHandler,
} from '../controllers/economicCalendarController';

const router = Router();

router.use(requireAuth);

router.get('/upcoming', getUpcomingEventsHandler);
router.get('/news-risk', getNewsRiskHandler);

export default router;
