// Answer papers uploaded together as PDFs, matched, checked and filed (bulk.js).
import express from 'express';
import db from '../db.js';
import { uploadPdfPages } from '../uploads.js';
import { discardUploads } from '../scans.js';
import { testFor } from '../results.js';
import {
  addItem, evaluateSittings, evaluateUnmarked, markingState, matchAll, choosePageSections, choosePapers, chooseTeacher, fileReady, itemFor, presentItem, presentItems, queueSort, removeItem,
  unmarkedSittings,
} from '../bulk.js';

const router = express.Router();

const selectSchool = db.prepare('SELECT * FROM schools WHERE id = ?');

function schoolAndTest(source) {
  const school = selectSchool.get(Number(source.school_id));
  return school ? { school, test: testFor(school.id, source.test_id) } : {};
}

// GET /api/bulk?school_id=1&test_id=2: the PDFs waiting to be filed in the test.
router.get('/', (req, res) => {
  const { school, test } = schoolAndTest(req.query);
  if (!school) return res.status(400).json({ error: 'Pick a school.' });
  res.json({ school: { id: school.id, name: school.name }, test: { id: test.id, name: test.name }, items: presentItems(school.id, test.id) });
});

// One PDF's pages, as pictures, with the PDF's file name. Nothing is
// matched, filed or marked yet.
router.post('/', uploadPdfPages.array('pages', 120), (req, res) => {
  const { school, test } = schoolAndTest(req.body);
  if (!school) {
    discardUploads(req.files);
    return res.status(400).json({ error: 'Pick a school.' });
  }
  if (!req.files?.length) return res.status(400).json({ error: 'That PDF has no pages.' });
  const fileName = String(req.body.file_name ?? '').trim().slice(0, 200) || 'Answer paper.pdf';
  const id = addItem(school, test, fileName, req.files);
  res.status(201).json(presentItem(itemFor(id)));
});

// Changes made on the review screen: the teacher, the paper for a section, or
// the section a page belongs to.
router.put('/:id', (req, res) => {
  let item = itemFor(req.params.id);
  if (!item) return res.status(404).json({ error: 'That PDF is no longer waiting to be filed.' });
  if ('teacher_id' in req.body) {
    const problem = chooseTeacher(item, Number(req.body.teacher_id) || null);
    if (problem) return res.status(400).json({ error: problem });
    item = itemFor(item.id);
  }
  if (req.body.papers) {
    const problem = choosePapers(item, req.body.papers);
    if (problem) return res.status(400).json({ error: problem });
  }
  if (Array.isArray(req.body.pages)) choosePageSections(item, req.body.pages);
  const items = db.prepare('SELECT * FROM bulk_items WHERE school_id = ? AND test_id = ?').all(item.school_id, item.test_id);
  res.json(presentItem(itemFor(item.id), items));
});

// "Find the question papers": every PDF of the test not matched yet, or whose
// matching failed, is matched at once.
router.post('/match', (req, res) => {
  const { school, test } = schoolAndTest(req.body);
  if (!school) return res.status(400).json({ error: 'Pick a school.' });
  const started = matchAll(school.id, test.id);
  res.json({ started, items: presentItems(school.id, test.id) });
});

// Match one PDF again, for example after the paper pack was imported.
router.post('/:id/sort', (req, res) => {
  const item = itemFor(req.params.id);
  if (!item) return res.status(404).json({ error: 'That PDF is no longer waiting to be filed.' });
  if (['waiting', 'running'].includes(item.sort_status)) return res.status(400).json({ error: 'It is being matched already.' });
  queueSort(item.id);
  res.json(presentItem(itemFor(item.id)));
});

router.delete('/:id', (req, res) => {
  const item = itemFor(req.params.id);
  if (!item) return res.status(404).json({ error: 'That PDF is no longer waiting to be filed.' });
  removeItem(item.id);
  res.json({ deleted: true });
});

// Files every ready PDF of the test, or only the ones in `ids`.
router.post('/file', (req, res) => {
  const { school, test } = schoolAndTest(req.body);
  if (!school) return res.status(400).json({ error: 'Pick a school.' });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
  res.json(fileReady(school.id, test.id, ids));
});

// Evaluate pressed for every sitting just filed, with one Standard or Lenient
// choice for all of them. They are marked as many at once as the server's
// memory allows.
router.post('/evaluate', (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((id) => db.prepare('SELECT 1 FROM assessments WHERE id = ?').get(id));
  if (!ids.length) return res.status(400).json({ error: 'There is nothing to evaluate.' });
  const problem = evaluateSittings(ids, req.body.marking ?? 'standard');
  if (problem) return res.status(400).json({ error: problem });
  res.status(202).json(markingState(ids));
});

// GET /api/bulk/unmarked?school_id=1&test_id=2: the test's sittings whose
// marking failed, with the reasons, and those waiting for Evaluate.
router.get('/unmarked', (req, res) => {
  const { school, test } = schoolAndTest(req.query);
  if (!school) return res.status(400).json({ error: 'Pick a school.' });
  res.json(unmarkedSittings(school.id, test.id));
});

// Evaluate pressed once for all of them: { which: 'failed' } evaluates every
// sitting of the test whose marking failed again, { which: 'waiting' } every
// one waiting for Evaluate, as many at once as the server's memory allows.
router.post('/evaluate-unmarked', (req, res) => {
  const { school, test } = schoolAndTest(req.body);
  if (!school) return res.status(400).json({ error: 'Pick a school.' });
  const { started, error } = evaluateUnmarked(school.id, test.id, req.body.which, req.body.marking ?? 'standard');
  if (error) return res.status(400).json({ error });
  res.json({ started });
});

// GET /api/bulk/marking?ids=1,2,3: how far the marking of those sittings has got.
router.get('/marking', (req, res) => {
  res.json(markingState(String(req.query.ids ?? '').split(',').map(Number).filter(Boolean)));
});

export default router;
