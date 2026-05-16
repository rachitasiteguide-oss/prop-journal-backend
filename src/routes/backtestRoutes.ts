import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  listSessions, getSessionHandler, createSessionHandler, updateSessionHandler,
  deleteSessionHandler, getAnalyticsHandler, addTradeHandler, bulkAddTradesHandler,
  updateTradeHandler, deleteTradeHandler,
  getStrategyCatalogHandler, runSessionHandler, getRunStatusHandler, getSessionCandlesHandler,
} from '../controllers/backtestController';
import {
  listSavedStrategiesHandler, getSavedStrategyHandler,
  createSavedStrategyHandler, updateSavedStrategyHandler, deleteSavedStrategyHandler,
} from '../controllers/savedStrategyController';
import {
  createSweepHandler, getSweepHandler, listSweepsHandler,
  createWalkForwardHandler, getWalkForwardHandler, listWalkForwardsHandler,
} from '../controllers/sweepController';

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

// ── Parameter sweeps ──────────────────────────────────────────────────────────
router.post('/sessions/:id/sweep',   createSweepHandler);
router.get('/sessions/:id/sweeps',   listSweepsHandler);
router.get('/sweeps/:id',            getSweepHandler);

// ── Walk-forward analysis ─────────────────────────────────────────────────────
router.post('/sessions/:id/walkforward',   createWalkForwardHandler);
router.get('/sessions/:id/walkforwards',   listWalkForwardsHandler);
router.get('/walkforwards/:id',            getWalkForwardHandler);

// ── Saved custom strategies ───────────────────────────────────────────────────
router.get('/custom-strategies',          listSavedStrategiesHandler);
router.post('/custom-strategies',         createSavedStrategyHandler);
router.get('/custom-strategies/:id',      getSavedStrategyHandler);
router.patch('/custom-strategies/:id',    updateSavedStrategyHandler);
router.delete('/custom-strategies/:id',   deleteSavedStrategyHandler);

export default router;
