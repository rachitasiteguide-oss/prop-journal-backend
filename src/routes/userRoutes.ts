import { Router } from 'express';
import { getProfileHandler, updateProfileHandler } from '../controllers/userController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = Router();

// All user routes are protected
router.use(requireAuth);

router.get('/profile', getProfileHandler);
router.patch('/profile', updateProfileHandler);

export default router;
