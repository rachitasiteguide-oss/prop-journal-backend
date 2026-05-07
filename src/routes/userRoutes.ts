import { Router } from 'express';
import { getProfileHandler, updateProfileHandler, changePasswordHandler, toggleTradingLockHandler, completeOnboardingHandler } from '../controllers/userController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = Router();
router.use(requireAuth);

router.get('/profile', getProfileHandler);
router.patch('/profile', updateProfileHandler);
router.post('/change-password', changePasswordHandler);
router.post('/trading-lock', toggleTradingLockHandler);
router.post('/complete-onboarding', completeOnboardingHandler);

export default router;
