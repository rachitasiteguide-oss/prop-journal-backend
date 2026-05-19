import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getEquityCurveHandler,
  getHeatmapHandler,
} from '../controllers/analyticsController';

const router = Router();

router.use(requireAuth);

router.get('/equity-curve', getEquityCurveHandler);
router.get('/heatmap', getHeatmapHandler);

export default router;
