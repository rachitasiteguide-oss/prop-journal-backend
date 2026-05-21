import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getAccountsHandler,
  createAccountHandler,
  getAccountsOverviewHandler,
  updateAccountHandler,
  deleteAccountHandler,
} from '../controllers/accountController';

const router = Router();

router.use(requireAuth);

router.get('/', getAccountsHandler);
router.get('/overview', getAccountsOverviewHandler);
router.post('/', createAccountHandler);
router.patch('/:id', updateAccountHandler);
router.delete('/:id', deleteAccountHandler);

export default router;
