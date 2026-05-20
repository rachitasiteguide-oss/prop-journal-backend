import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  listPayoutsHandler,
  createPayoutHandler,
  updatePayoutHandler,
  deletePayoutHandler,
} from '../controllers/payoutController';

// Mounted twice in routes/index.ts so two URL shapes work:
//   GET  /challenges/:challengeId/payouts        — list / create
//   POST /challenges/:challengeId/payouts
//   PATCH/DELETE /payouts/:id                    — per-row updates
const challengeScoped = Router({ mergeParams: true });
challengeScoped.use(requireAuth);
challengeScoped.get('/',  listPayoutsHandler);
challengeScoped.post('/', createPayoutHandler);

const flat = Router();
flat.use(requireAuth);
flat.patch ('/:id', updatePayoutHandler);
flat.delete('/:id', deletePayoutHandler);

export { challengeScoped as payoutChallengeRoutes, flat as payoutFlatRoutes };
