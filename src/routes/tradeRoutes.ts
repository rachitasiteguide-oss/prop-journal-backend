import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  createTradeHandler,
  getTradesHandler,
  getTradeByIdHandler,
  updateTradeHandler,
  deleteTradeHandler,
} from '../controllers/tradeController';

const router = Router();

router.use(requireAuth);

router.get('/', getTradesHandler);
router.post('/', createTradeHandler);
router.get('/:id', getTradeByIdHandler);
router.patch('/:id', updateTradeHandler);
router.delete('/:id', deleteTradeHandler);

export default router;
