import express from 'express';
import db from '../db.js';
import { defaultTestFor } from '../results.js';

const router = express.Router();

const selectTests = db.prepare(`
  SELECT t.*,
         (SELECT COUNT(DISTINCT a.teacher_id) FROM assessments a WHERE a.test_id = t.id) AS teacher_count,
         (SELECT COUNT(*) FROM assessments a WHERE a.test_id = t.id)                    AS sitting_count
    FROM tests t
   WHERE t.school_id = ?
   ORDER BY t.id DESC
`);
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');

// GET /api/tests?school_id=1. A school always has at least one test, so the
// board has something to file scans under.
router.get('/', (req, res) => {
  const schoolId = Number(req.query.school_id);
  if (!db.prepare('SELECT 1 FROM schools WHERE id = ?').get(schoolId)) {
    return res.status(400).json({ error: 'Pick a school to see its tests.' });
  }
  defaultTestFor(schoolId);
  res.json(selectTests.all(schoolId));
});

router.post('/', (req, res) => {
  const schoolId = Number(req.body.school_id);
  if (!db.prepare('SELECT 1 FROM schools WHERE id = ?').get(schoolId)) {
    return res.status(400).json({ error: 'Pick a school for this test.' });
  }
  const name = String(req.body.name ?? '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Give the test a name, for example "Post-training test".' });
  const info = db.prepare('INSERT INTO tests (school_id, name) VALUES (?, ?)').run(schoolId, name);
  res.status(201).json(selectTest.get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const test = selectTest.get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const name = String(req.body.name ?? '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'A test needs a name.' });
  db.prepare('UPDATE tests SET name = ? WHERE id = ?').run(name, test.id);
  res.json(selectTest.get(test.id));
});

// Only an empty test can be deleted, so no scans or marks go with it.
router.delete('/:id', (req, res) => {
  const test = selectTest.get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const used = db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE test_id = ?').get(test.id).n;
  if (used) return res.status(400).json({ error: 'This test already has scans filed under it, so it cannot be deleted.' });
  db.prepare('DELETE FROM tests WHERE id = ?').run(test.id);
  res.json({ deleted: true });
});

export default router;
