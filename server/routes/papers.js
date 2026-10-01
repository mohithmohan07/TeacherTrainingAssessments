import express from 'express';
import db from '../db.js';
import { uploadPaper, uploadPack } from '../uploads.js';
import { removeStoredFile } from '../scans.js';
import { LEVELS } from '../paper-formats.js';
import {
  PAPER_SECTIONS, addPaper, allPapers, fullPaperPlan, importPack, isPdf, paperLabelsFrom, presentPaper, rankPapers, teacherProfile,
} from '../papers.js';

const router = express.Router();

const selectPaper = db.prepare('SELECT * FROM papers WHERE id = ?');
const countUses = db.prepare('SELECT COUNT(*) AS n FROM assessment_papers WHERE paper_id = ?');

// GET /api/papers: every paper in the library, with how many sittings use it,
// and the levels the labels can name.
router.get('/', (_req, res) => {
  const uses = new Map(
    db.prepare('SELECT paper_id, COUNT(*) AS n FROM assessment_papers GROUP BY paper_id').all().map((row) => [row.paper_id, row.n])
  );
  res.json({
    papers: allPapers().map((paper) => ({ ...presentPaper(paper), used_by: uses.get(paper.id) ?? 0 })),
    levels: Object.entries(LEVELS).map(([key, level]) => ({ key, name: level.name, classes: level.classes })),
    sections: PAPER_SECTIONS,
  });
});

// GET /api/papers/choices?teacher_id=1&section=B: the library's papers for
// each section the teacher is being asked about, best fit first, so the board
// can ask "is this the paper?" and offer the others. With no section, A, B
// and C are each offered, for a full paper.
router.get('/choices', (req, res) => {
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(Number(req.query.teacher_id));
  if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(teacher.school_id);
  const profile = teacherProfile(teacher, school);
  const papers = allPapers();
  const section = PAPER_SECTIONS.includes(req.query.section) ? req.query.section : '';
  // For the full paper, the suggestions are made as a set, so a paper holding
  // two sections is suggested for both.
  const plan = section ? null : fullPaperPlan(papers, profile);

  res.json({
    teacher: { id: teacher.id, name: teacher.name, grade: teacher.grade, subjects: teacher.subjects },
    slots: (section ? [section] : PAPER_SECTIONS).map((key) => {
      const { ranked, suggested } = rankPapers(papers, profile, key);
      return {
        section: key,
        suggested_id: (plan ? plan.get(key) : suggested)?.id ?? null,
        papers: ranked.map(({ paper, score, reasons }) => ({ ...presentPaper(paper), score, reasons })),
      };
    }),
  });
});

// Add one paper: a PDF plus its labels.
router.post('/', uploadPaper.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose the paper’s PDF file.' });
  if (!isPdf(req.file.buffer)) return res.status(400).json({ error: 'That file is not a PDF. In Word, use File → Save As → PDF first.' });
  const labels = paperLabelsFrom(req.body);
  if (!labels.title) return res.status(400).json({ error: 'Give the paper a title.' });
  if (!labels.sections) return res.status(400).json({ error: 'Tick the sections this paper has.' });

  const { paper, added } = addPaper(labels, { pdf: req.file.buffer, originalName: req.file.originalname });
  if (!added) return res.status(409).json({ error: `This PDF is already in the library as “${paper.title}”.` });
  res.status(201).json(presentPaper(paper));
});

// Import a paper pack: a zip of PDFs with a manifest of their labels.
router.post('/import', uploadPack.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Choose the paper pack .zip file.' });
  try {
    res.json(await importPack(req.file.buffer));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.put('/:id', (req, res) => {
  const paper = selectPaper.get(req.params.id);
  if (!paper) return res.status(404).json({ error: 'That paper is no longer in the library.' });
  const labels = paperLabelsFrom({ priority: paper.priority, ...req.body });
  if (!labels.title) return res.status(400).json({ error: 'Give the paper a title.' });
  if (!labels.sections) return res.status(400).json({ error: 'Tick the sections this paper has.' });

  db.prepare(
    `UPDATE papers SET title = @title, sections = @sections, subject = @subject, levels = @levels, board = @board,
            language = @language, total_marks = @total_marks, notes = @notes, priority = @priority
      WHERE id = @id`
  ).run({ ...labels, id: paper.id });
  res.json(presentPaper(selectPaper.get(paper.id)));
});

// A paper a sitting was marked against stays, so its marks can be checked.
router.delete('/:id', (req, res) => {
  const paper = selectPaper.get(req.params.id);
  if (!paper) return res.status(404).json({ error: 'That paper is no longer in the library.' });
  const { n } = countUses.get(paper.id);
  if (n) {
    return res.status(400).json({
      error: `${n} sitting${n === 1 ? ' uses' : 's use'} this paper as the question paper, so it stays. Change their question paper first.`,
    });
  }
  db.prepare('DELETE FROM papers WHERE id = ?').run(paper.id);
  removeStoredFile(paper.stored_name);
  removeStoredFile(paper.preview_name);
  res.json({ deleted: true });
});

export default router;
