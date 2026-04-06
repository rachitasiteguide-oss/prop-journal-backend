import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import { connectMt5Handler } from '../controllers/connect.controller';

const router = Router();

router.use(requireAuth);

// POST /accounts/connect
router.post('/', connectMt5Handler);

export default router;
