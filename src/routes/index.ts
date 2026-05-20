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
import instrumentRoutes from './instrumentRoutes';
import publicRoutes from './publicRoutes';
import aiRoutes from './aiRoutes';
import economicCalendarRoutes from './economicCalendarRoutes';
import analyticsRoutes from './analyticsRoutes';
import challengeRoutes from './challengeRoutes';

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
router.use('/instruments', instrumentRoutes);
router.use('/public', publicRoutes);
router.use('/ai', aiRoutes);
router.use('/economic-calendar', economicCalendarRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/challenges', challengeRoutes);

export default router;
