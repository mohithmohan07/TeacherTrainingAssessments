import express from 'express';
import db from '../db.js';
import { GRADES, testFor } from '../results.js';
import { findReport, isOldLayout, isOutOfDate, lacksPlainWords, schoolOverview, schoolReportIsStale } from '../reports.js';

const router = express.Router();

const selectSchools = db.prepare('SELECT id, name, logo_path, city, state FROM schools ORDER BY name COLLATE NOCASE');
const selectSchool = db.prepare('SELECT id, name, logo_path, city, state FROM schools WHERE id = ?');
const selectTests = db.prepare('SELECT id, name FROM tests WHERE school_id = ? ORDER BY id DESC');

// What each teacher's sittings in the test that are not evaluated yet are
// waiting on. A teacher can have more than one open at a time when sections
// are uploaded one by one, so every open sitting counts, not only the latest.
const selectOpenSittings = db.prepare(`
  SELECT a.teacher_id,
         MAX(a.ai_status = 'running') AS marking,
         MAX(a.ai_status = 'failed')  AS failed,
         MAX(a.ai_status NOT IN ('running', 'failed') AND EXISTS (
           SELECT 1 FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'response'
         )) AS to_evaluate
    FROM assessments a
   WHERE a.test_id = @test_id AND a.school_id = @school_id AND a.status != 'evaluated'
   GROUP BY a.teacher_id
`);

const POTENTIAL_LEVELS = [
  { level: 'mentor', headline: 'Can Guide Other Teachers' },
  { level: 'strong', headline: 'Strong in Every Section' },
  { level: 'emerging', headline: 'Strong in Some Sections' },
  { level: 'developing', headline: 'Fair in Every Section' },
  { level: 'support', headline: 'Needs Help First' },
];

// One school's picture in one test: what is waiting to be done, and how its
// teachers are doing section by section. Grades only, never an overall percentage.
function schoolSummary(school, test) {
  const overview = schoolOverview(school.id, test.id);
  const openSittings = new Map(selectOpenSittings.all({ school_id: school.id, test_id: test.id }).map((row) => [row.teacher_id, row]));
  const person = (t) => ({ id: t.id, name: t.name });

  const waiting = { not_started: [], to_evaluate: [], marking: [], failed: [], reports_to_build: [] };
  for (const teacher of overview.teachers) {
    const open = openSittings.get(teacher.id);
    const hasResults = teacher.sections.length > 0;

    if (open?.marking) waiting.marking.push(person(teacher));
    else if (open?.failed) waiting.failed.push(person(teacher));
    else if (open?.to_evaluate) waiting.to_evaluate.push(person(teacher));
    else if (!hasResults) waiting.not_started.push(person(teacher));

    if (hasResults) {
      const report = findReport('teacher', test.id, teacher.id);
      if (!report || report.status === 'failed' || (report.status === 'done' && isOutOfDate(report, teacher.sections))) {
        waiting.reports_to_build.push(person(teacher));
      }
    }
  }

  const potential = POTENTIAL_LEVELS.map(({ level, headline }) => ({
    level,
    headline,
    teachers: overview.teachers.filter((t) => t.potential?.level === level).map(person),
  }));

  const schoolReport = findReport('school', test.id, null);
  return {
    school,
    test,
    tests: selectTests.all(school.id),
    teacher_count: overview.teachers.length,
    assessed: overview.assessed,
    waiting,
    sections: overview.section_stats.map(({ helpers, needs, ...stat }) => stat),
    potential,
    school_report: schoolReport && {
      status: schoolReport.status,
      written_at: schoolReport.written_at,
      stale: schoolReportIsStale(schoolReport, overview),
      old_layout: isOldLayout(schoolReport),
      old_words: lacksPlainWords(schoolReport),
    },
  };
}

// GET /api/dashboard: every school in its newest test, plus totals.
router.get('/', (_req, res) => {
  const schools = selectSchools.all().map((school) => schoolSummary(school, testFor(school.id)));
  const sum = (pick) => schools.reduce((n, s) => n + pick(s), 0);
  res.json({
    grades: GRADES,
    totals: {
      schools: schools.length,
      teachers: sum((s) => s.teacher_count),
      not_started: sum((s) => s.waiting.not_started.length),
      to_evaluate: sum((s) => s.waiting.to_evaluate.length + s.waiting.failed.length),
      reports_to_build: sum((s) => s.waiting.reports_to_build.length),
    },
    schools,
  });
});

// GET /api/dashboard/school?school_id=1&test_id=2: one school in another test.
router.get('/school', (req, res) => {
  const school = selectSchool.get(Number(req.query.school_id));
  if (!school) return res.status(404).json({ error: 'School not found.' });
  res.json(schoolSummary(school, testFor(school.id, req.query.test_id)));
});

export default router;
