import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getPublicStatsHandler,
  getTestimonialsHandler,
  submitTestimonialHandler,
} from '../controllers/publicController';

const router = Router();

// Public — no auth. Consumed by the marketing/landing page.
router.get('/stats', getPublicStatsHandler);
router.get('/testimonials', getTestimonialsHandler);

// Authed — a logged-in user submits their own testimonial (defaults to
// unapproved; an admin flips `approved` before it appears publicly).
router.post('/testimonials', requireAuth, submitTestimonialHandler);

export default router;
