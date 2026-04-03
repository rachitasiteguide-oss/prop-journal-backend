import { Router } from 'express';
import authRoutes from './authRoutes';
import userRoutes from './userRoutes';
import accountRoutes from './accountRoutes';
import tradeRoutes from './tradeRoutes';
import notebookRoutes from './notebookRoutes';
import strategyRoutes from './strategyRoutes';
import leaderboardRoutes from './leaderboardRoutes';
import routineRoutes from './routineRoutes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/accounts', accountRoutes);
router.use('/trades', tradeRoutes);
router.use('/notebook', notebookRoutes);
router.use('/strategies', strategyRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/routines', routineRoutes);

export default router;
