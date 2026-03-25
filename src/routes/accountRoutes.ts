import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import { getAccountsHandler } from '../controllers/accountController';

const router = Router();

router.use(requireAuth);

router.get('/', getAccountsHandler);

export default router;
