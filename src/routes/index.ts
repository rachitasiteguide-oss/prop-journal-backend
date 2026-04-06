import { Router } from 'express';
import authRoutes from './authRoutes';
import userRoutes from './userRoutes';
import accountRoutes from './accountRoutes';
import tradeRoutes from './tradeRoutes';
import notebookRoutes from './notebookRoutes';
import strategyRoutes from './strategyRoutes';
import leaderboardRoutes from './leaderboardRoutes';
import routineRoutes from './routineRoutes';
import backtestRoutes from './backtestRoutes';
import syncRoutes from './syncRoutes';
import connectRoutes from './connectRoutes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
// Specific sub-paths first — prevents "connect" being captured as :accountId
router.use('/accounts/connect', connectRoutes);
router.use('/accounts', accountRoutes);
router.use('/accounts/:accountId/sync', syncRoutes);
router.use('/trades', tradeRoutes);
router.use('/notebook', notebookRoutes);
router.use('/strategies', strategyRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/routines', routineRoutes);
router.use('/backtesting', backtestRoutes);

export default router;
