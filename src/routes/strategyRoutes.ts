import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getStrategiesHandler,
  createStrategyHandler,
  updateStrategyHandler,
  deleteStrategyHandler,
} from '../controllers/strategyController';

const router = Router();

router.use(requireAuth);

router.get   ('/',     getStrategiesHandler);
router.post  ('/',     createStrategyHandler);
router.patch ('/:id',  updateStrategyHandler);
router.delete('/:id',  deleteStrategyHandler);

export default router;
