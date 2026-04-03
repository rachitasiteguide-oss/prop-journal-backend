import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getRoutinesHandler,
  getStreakHandler,
  toggleItemHandler,
  resetRoutineHandler,
  addItemHandler,
  updateItemHandler,
  deleteItemHandler,
  createRoutineHandler,
  deleteRoutineHandler,
} from '../controllers/routineController';

const router = Router();

router.use(requireAuth);

router.get('/', getRoutinesHandler);
router.get('/streak', getStreakHandler);
router.post('/', createRoutineHandler);

router.delete('/:routineId', deleteRoutineHandler);
router.post('/:routineId/reset', resetRoutineHandler);

router.post('/:routineId/items', addItemHandler);
router.put('/:routineId/items/:itemId', updateItemHandler);
router.delete('/:routineId/items/:itemId', deleteItemHandler);
router.post('/:routineId/items/:itemId/toggle', toggleItemHandler);

export default router;
