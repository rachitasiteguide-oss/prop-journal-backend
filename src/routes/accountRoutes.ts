import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import { getAccountsHandler, createAccountHandler } from '../controllers/accountController';

const router = Router();

router.use(requireAuth);

router.get('/', getAccountsHandler);
router.post('/', createAccountHandler);

export default router;
