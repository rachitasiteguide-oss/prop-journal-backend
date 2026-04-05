import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  listSessions, getSessionHandler, createSessionHandler, updateSessionHandler,
  deleteSessionHandler, getAnalyticsHandler, addTradeHandler, updateTradeHandler, deleteTradeHandler,
} from '../controllers/backtestController';

const router = Router();
router.use(requireAuth);

router.get('/sessions', listSessions);
router.post('/sessions', createSessionHandler);
router.get('/sessions/:id', getSessionHandler);
router.patch('/sessions/:id', updateSessionHandler);
router.delete('/sessions/:id', deleteSessionHandler);
router.get('/sessions/:id/analytics', getAnalyticsHandler);
router.post('/sessions/:id/trades', addTradeHandler);
router.patch('/sessions/:id/trades/:tradeId', updateTradeHandler);
router.delete('/sessions/:id/trades/:tradeId', deleteTradeHandler);

export default router;
