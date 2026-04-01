import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware';
import {
  getFoldersHandler,
  createFolderHandler,
  updateFolderHandler,
  deleteFolderHandler,
  getNotesHandler,
  getNoteHandler,
  createNoteHandler,
  updateNoteHandler,
  deleteNoteHandler,
} from '../controllers/notebookController';

const router = Router();

router.use(requireAuth);

// Folders
router.get   ('/folders',     getFoldersHandler);
router.post  ('/folders',     createFolderHandler);
router.patch ('/folders/:id', updateFolderHandler);
router.delete('/folders/:id', deleteFolderHandler);

// Notes
router.get   ('/notes',     getNotesHandler);
router.post  ('/notes',     createNoteHandler);
router.get   ('/notes/:id', getNoteHandler);
router.patch ('/notes/:id', updateNoteHandler);
router.delete('/notes/:id', deleteNoteHandler);

export default router;
