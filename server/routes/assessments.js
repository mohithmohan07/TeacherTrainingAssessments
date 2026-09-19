import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import db, { UPLOADS_DIR } from '../db.js';
import { uploadScans } from '../uploads.js';

const router = express.Router();

const KINDS = new Set(['question_paper', 'response']);
const STATUSES = new Set(['draft', 'scanned', 'evaluated']);

const selectAssessmentRow = db.prepare(`
  SELECT a.*, t.name AS teacher_name, t.grade AS teacher_grade, t.subjects AS teacher_subjects,
         s.name AS school_name,
         (SELECT COUNT(*) FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'question_paper') AS question_paper_count,
         (SELECT COUNT(*) FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'response')       AS response_count
    FROM assessments a
    JOIN teachers t ON t.id = a.teacher_id
    JOIN schools  s ON s.id = a.school_id
   WHERE a.id = ?
`);

const selectFiles = db.prepare(
  'SELECT * FROM assessment_files WHERE assessment_id = ? ORDER BY kind, position, id'
);

function withFiles(assessment) {
  if (!assessment) return assessment;
  const files = selectFiles.all(assessment.id);
  return {
    ...assessment,
    question_paper_files: files.filter((f) => f.kind === 'question_paper'),
    response_files: files.filter((f) => f.kind === 'response'),
  };
}

function removeStoredFile(storedName) {
  if (!storedName) return;
  fs.rm(path.join(UPLOADS_DIR, storedName), { force: true }, () => {});
}

function assessmentFields(body) {
  const rawScore = String(body.score ?? '').trim();
  const rawMax = String(body.max_score ?? '').trim();
  return {
    title: String(body.title ?? '').trim(),
    assessment_date: String(body.assessment_date ?? '').trim() || null,
    subject: String(body.subject ?? '').trim(),
    status: STATUSES.has(body.status) ? body.status : 'draft',
    notes: String(body.notes ?? '').trim(),
    score: Number.isFinite(Number(rawScore)) && rawScore !== '' ? Number(rawScore) : null,
    max_score: Number.isFinite(Number(rawMax)) && rawMax !== '' ? Number(rawMax) : null,
  };
}

// GET /api/assessments?school_id=1&teacher_id=2
router.get('/', (req, res) => {
  const clauses = [];
  const params = {};

  if (req.query.school_id) {
    clauses.push('a.school_id = @school_id');
    params.school_id = Number(req.query.school_id);
  }
  if (req.query.teacher_id) {
    clauses.push('a.teacher_id = @teacher_id');
    params.teacher_id = Number(req.query.teacher_id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT a.*, t.name AS teacher_name, t.grade AS teacher_grade, s.name AS school_name,
              (SELECT COUNT(*) FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'question_paper') AS question_paper_count,
              (SELECT COUNT(*) FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'response')       AS response_count
         FROM assessments a
         JOIN teachers t ON t.id = a.teacher_id
         JOIN schools  s ON s.id = a.school_id
         ${where}
         ORDER BY COALESCE(a.assessment_date, a.created_at) DESC, a.id DESC`
    )
    .all(params);

  res.json(rows);
});

router.get('/:id', (req, res) => {
  const assessment = selectAssessmentRow.get(req.params.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found.' });
  res.json(withFiles(assessment));
});

router.post('/', (req, res) => {
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(Number(req.body.teacher_id));
  if (!teacher) return res.status(400).json({ error: 'Pick a teacher for this assessment.' });

  const fields = assessmentFields(req.body);
  if (!fields.title) {
    fields.title = `Assessment - ${teacher.name}`;
  }

  const info = db
    .prepare(
      `INSERT INTO assessments (school_id, teacher_id, title, assessment_date, subject, status, notes, score, max_score)
       VALUES (@school_id, @teacher_id, @title, @assessment_date, @subject, @status, @notes, @score, @max_score)`
    )
    .run({ ...fields, school_id: teacher.school_id, teacher_id: teacher.id });

  res.status(201).json(withFiles(selectAssessmentRow.get(info.lastInsertRowid)));
});

router.put('/:id', (req, res) => {
  const assessment = selectAssessmentRow.get(req.params.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found.' });

  const fields = assessmentFields(req.body);
  if (!fields.title) return res.status(400).json({ error: 'A title is required.' });

  db.prepare(
    `UPDATE assessments
        SET title = @title, assessment_date = @assessment_date, subject = @subject, status = @status,
            notes = @notes, score = @score, max_score = @max_score, updated_at = datetime('now')
      WHERE id = @id`
  ).run({ ...fields, id: assessment.id });

  res.json(withFiles(selectAssessmentRow.get(assessment.id)));
});

router.delete('/:id', (req, res) => {
  const assessment = selectAssessmentRow.get(req.params.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found.' });

  const files = selectFiles.all(assessment.id);
  db.prepare('DELETE FROM assessments WHERE id = ?').run(assessment.id);
  for (const file of files) removeStoredFile(file.stored_name);

  res.json({ deleted: true });
});

// Upload one or more scanned pages for an assessment.
router.post('/:id/files', uploadScans.array('files', 40), (req, res) => {
  const assessment = selectAssessmentRow.get(req.params.id);
  if (!assessment) {
    for (const file of req.files ?? []) removeStoredFile(file.filename);
    return res.status(404).json({ error: 'Assessment not found.' });
  }

  const kind = String(req.body.kind ?? '');
  if (!KINDS.has(kind)) {
    for (const file of req.files ?? []) removeStoredFile(file.filename);
    return res.status(400).json({ error: 'Say whether these pages are the question paper or the response.' });
  }
  if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one scanned image.' });

  const startAt =
    db
      .prepare('SELECT COALESCE(MAX(position), 0) AS max_position FROM assessment_files WHERE assessment_id = ? AND kind = ?')
      .get(assessment.id, kind).max_position + 1;

  const insert = db.prepare(
    `INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, size_bytes, position)
     VALUES (@assessment_id, @kind, @stored_name, @original_name, @mime_type, @size_bytes, @position)`
  );

  const insertMany = db.transaction((files) => {
    files.forEach((file, index) => {
      insert.run({
        assessment_id: assessment.id,
        kind,
        stored_name: file.filename,
        original_name: file.originalname,
        mime_type: file.mimetype,
        size_bytes: file.size,
        position: startAt + index,
      });
    });
  });
  insertMany(req.files);

  db.prepare("UPDATE assessments SET updated_at = datetime('now') WHERE id = ?").run(assessment.id);

  res.status(201).json(withFiles(selectAssessmentRow.get(assessment.id)));
});

router.delete('/:id/files/:fileId', (req, res) => {
  const file = db
    .prepare('SELECT * FROM assessment_files WHERE id = ? AND assessment_id = ?')
    .get(req.params.fileId, req.params.id);
  if (!file) return res.status(404).json({ error: 'That page is no longer there.' });

  db.prepare('DELETE FROM assessment_files WHERE id = ?').run(file.id);
  removeStoredFile(file.stored_name);

  res.json(withFiles(selectAssessmentRow.get(req.params.id)));
});

export default router;
