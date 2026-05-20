import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  createTradeHandler,
  getTradesHandler,
  getTradeByIdHandler,
  updateTradeHandler,
  deleteTradeHandler,
  getTradeReplayHandler,
} from '../controllers/tradeController';
import {
  createImportHandler,
  listImportsHandler,
  getImportHandler,
} from '../controllers/importController';
import {
  presignScreenshotHandler,
  confirmScreenshotHandler,
  getScreenshotHandler,
  deleteScreenshotHandler,
} from '../controllers/screenshotController';
import { exportTaxHandler } from '../controllers/taxExportController';

const router = Router();

router.use(requireAuth);

// Import routes registered BEFORE /:id so 'import' / 'imports' don't get
// captured as a trade ID.
router.post('/import', createImportHandler);
router.get('/imports', listImportsHandler);
router.get('/imports/:id', getImportHandler);
router.get('/export/tax', exportTaxHandler);

router.get('/', getTradesHandler);
router.post('/', createTradeHandler);
router.get('/:id', getTradeByIdHandler);
router.get('/:id/replay', getTradeReplayHandler);
router.post('/:id/screenshot/presign', presignScreenshotHandler);
router.post('/:id/screenshot/confirm', confirmScreenshotHandler);
router.get('/:id/screenshot', getScreenshotHandler);
router.delete('/:id/screenshot', deleteScreenshotHandler);
router.patch('/:id', updateTradeHandler);
router.delete('/:id', deleteTradeHandler);

export default router;
