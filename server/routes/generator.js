import express from 'express';
import db from '../db.js';
import { GEMINI_MODEL, geminiConfigured, GeminiError } from '../gemini.js';
import { generatePaper, readRequest } from '../generator.js';
import { LANGUAGES } from '../languages.js';
import { LEVELS, SECTION_KEYS, TEACHER_TYPES, sectionFormats, sectionMarks } from '../paper-formats.js';

const router = express.Router();

function toPaper(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    grade: row.grade,
    total_marks: row.total_marks,
    created_at: row.created_at,
    request: JSON.parse(row.request),
    paper: JSON.parse(row.paper),
  };
}

// What the Generator page needs before it can show its form.
router.get('/config', (_req, res) => {
  const describe = (teacherType) =>
    sectionFormats(teacherType, SECTION_KEYS).map((format) => ({ key: format.key, heading: format.heading, marks: sectionMarks(format) }));
  res.json({
    configured: geminiConfigured(),
    model: GEMINI_MODEL,
    teacher_types: TEACHER_TYPES,
    levels: Object.entries(LEVELS).map(([value, level]) => ({ value, label: `${level.name} (${level.classes})` })),
    languages: LANGUAGES.map((language) => language.name),
    sections: { subject: describe('subject'), specialist: describe('specialist') },
  });
});

router.get('/', (_req, res) => {
  res.json(
    db
      .prepare('SELECT id, title, subject, grade, total_marks, created_at FROM generated_papers ORDER BY id DESC LIMIT 200')
      .all()
  );
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM generated_papers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Paper not found.' });
  res.json(toPaper(row));
});

router.post('/', async (req, res, next) => {
  const { request, problems } = readRequest(req.body);
  if (problems.length) return res.status(400).json({ error: `Please give ${problems.join(', ')}.` });

  let paper;
  try {
    paper = await generatePaper(request);
  } catch (error) {
    if (error instanceof GeminiError) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  if (!paper.sections.some((section) => section.questions.some((question) => question.scenario))) {
    return res.status(502).json({ error: 'Gemini returned a paper with no questions. Please try again.' });
  }

  const info = db
    .prepare(
      `INSERT INTO generated_papers (title, subject, grade, total_marks, request, paper)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(paper.title, request.subject, request.grade, paper.total_marks, JSON.stringify(request), JSON.stringify(paper));

  res.status(201).json(toPaper(db.prepare('SELECT * FROM generated_papers WHERE id = ?').get(info.lastInsertRowid)));
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM generated_papers WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Paper not found.' });
  res.json({ ok: true });
});

export default router;
