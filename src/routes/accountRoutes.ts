import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getAccountsHandler,
  createAccountHandler,
  getAccountsOverviewHandler,
} from '../controllers/accountController';

const router = Router();

router.use(requireAuth);

router.get('/', getAccountsHandler);
router.get('/overview', getAccountsOverviewHandler);
router.post('/', createAccountHandler);

export default router;
