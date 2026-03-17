import { Router } from 'express';
import passport from 'passport';
import { googleCallback, logout, me } from '../controllers/authController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = Router();

// Initiates Google OAuth flow
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  }),
);

// Google OAuth callback
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failure' }),
  googleCallback,
);

// Auth failure
router.get('/failure', (_req, res) => {
  res.status(401).json({ status: 'error', message: 'Google authentication failed' });
});

// Get current user (protected)
router.get('/me', requireAuth, me);

// Logout
router.post('/logout', logout);

export default router;
