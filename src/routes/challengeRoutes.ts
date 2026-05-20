import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  listChallengesHandler,
  getChallengeHandler,
  createChallengeHandler,
  updateChallengeHandler,
  deleteChallengeHandler,
} from '../controllers/challengeController';

const router = Router();
router.use(requireAuth);

router.get   ('/',    listChallengesHandler);
router.post  ('/',    createChallengeHandler);
router.get   ('/:id', getChallengeHandler);
router.patch ('/:id', updateChallengeHandler);
router.delete('/:id', deleteChallengeHandler);

export default router;
