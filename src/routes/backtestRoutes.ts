import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  listSessions, getSessionHandler, createSessionHandler, updateSessionHandler,
  deleteSessionHandler, getAnalyticsHandler, addTradeHandler, bulkAddTradesHandler,
  updateTradeHandler, deleteTradeHandler,
  getStrategyCatalogHandler, runSessionHandler, getRunStatusHandler, getSessionCandlesHandler,
} from '../controllers/backtestController';

const router = Router();
router.use(requireAuth);

// ── Session CRUD ──────────────────────────────────────────────────────────────
router.get('/sessions', listSessions);
router.post('/sessions', createSessionHandler);
router.get('/sessions/:id', getSessionHandler);
router.patch('/sessions/:id', updateSessionHandler);
router.delete('/sessions/:id', deleteSessionHandler);
router.get('/sessions/:id/analytics', getAnalyticsHandler);

// ── Manual trade management ───────────────────────────────────────────────────
router.post('/sessions/:id/trades', addTradeHandler);
router.post('/sessions/:id/trades/bulk', bulkAddTradesHandler);
router.patch('/sessions/:id/trades/:tradeId', updateTradeHandler);
router.delete('/sessions/:id/trades/:tradeId', deleteTradeHandler);

// ── Automated backtest ────────────────────────────────────────────────────────
router.get('/strategies',              getStrategyCatalogHandler);
router.post('/sessions/:id/run',       runSessionHandler);
router.get('/sessions/:id/run/status', getRunStatusHandler);
router.get('/sessions/:id/candles',    getSessionCandlesHandler);

export default router;
