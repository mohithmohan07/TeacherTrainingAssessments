import express from 'express';
import { uploadDocument } from '../uploads.js';
import { isPdf } from '../papers.js';
import { openaiConfigured } from '../openai.js';
import { PATH_RULES, clearFramework, getFramework, readFramework, saveFramework } from '../training.js';

const router = express.Router();

// GET /api/training: the growth paths the training plans are drawn from, and
// how a path is picked for a teacher.
router.get('/', (_req, res) => {
  res.json({ framework: getFramework(), rules: PATH_RULES, openai: openaiConfigured() });
});

router.put('/', (req, res) => {
  try {
    res.json({ framework: saveFramework(req.body) });
  } catch (error) {
    if (!error.userMessage) throw error;
    res.status(400).json({ error: error.userMessage });
  }
});

router.delete('/', (_req, res) => {
  clearFramework();
  res.json({ framework: null });
});

// POST /api/training/read: OpenAI reads the paths out of a PDF, for the page
// to show. Nothing is saved until the page saves it.
router.post('/read', uploadDocument.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose the PDF to read.' });
  if (!isPdf(req.file.buffer)) return res.status(400).json({ error: 'That file is not a PDF. Save or download the document as a PDF first.' });
  if (!openaiConfigured()) return res.status(400).json({ error: 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing. Type the paths in instead.' });
  try {
    res.json({ framework: await readFramework(req.file.buffer, req.file.originalname) });
  } catch (error) {
    console.error('Reading training paths failed:', error);
    res.status(502).json({ error: error.userMessage ?? `The document could not be read: ${error.message}` });
  }
});

export default router;
