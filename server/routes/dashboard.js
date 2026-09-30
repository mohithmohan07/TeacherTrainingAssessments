import express from 'express';
import db from '../db.js';
import { GRADES, testFor } from '../results.js';
import { findReport, isStale, schoolOverview, schoolReportIsStale } from '../reports.js';

const router = express.Router();

const selectSchools = db.prepare('SELECT id, name, logo_path, city, state FROM schools ORDER BY name COLLATE NOCASE');
const selectSchool = db.prepare('SELECT id, name, logo_path, city, state FROM schools WHERE id = ?');
const selectTests = db.prepare('SELECT id, name FROM tests WHERE school_id = ? ORDER BY id DESC');

// Each teacher's current sitting in the test, as on the Assessments board.
const selectCurrentSittings = db.prepare(`
  SELECT t.id AS teacher_id, a.id AS assessment_id, a.status, a.ai_status,
         (SELECT COUNT(*) FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'response') AS response_count
    FROM teachers t
    LEFT JOIN assessments a ON a.id = (
      SELECT a2.id FROM assessments a2 WHERE a2.teacher_id = t.id AND a2.test_id = @test_id ORDER BY a2.id DESC LIMIT 1
    )
   WHERE t.school_id = @school_id
`);

const POTENTIAL_LEVELS = [
  { level: 'mentor', headline: 'Mentor potential' },
  { level: 'strong', headline: 'Strong performer' },
  { level: 'emerging', headline: 'Strength to build on' },
  { level: 'developing', headline: 'Developing steadily' },
  { level: 'support', headline: 'Priority for support' },
];

// One school's picture in one test: what is waiting to be done, and how its
// teachers are doing section by section. Grades only, never an overall percentage.
function schoolSummary(school, test) {
  const overview = schoolOverview(school.id, test.id);
  const sittings = new Map(selectCurrentSittings.all({ school_id: school.id, test_id: test.id }).map((row) => [row.teacher_id, row]));
  const person = (t) => ({ id: t.id, name: t.name });

  const waiting = { not_started: [], to_evaluate: [], marking: [], failed: [], reports_to_build: [] };
  for (const teacher of overview.teachers) {
    const sitting = sittings.get(teacher.id);
    const hasResults = teacher.sections.length > 0;
    const open = sitting?.assessment_id && sitting.status !== 'evaluated';

    if (open && sitting.ai_status === 'running') waiting.marking.push(person(teacher));
    else if (open && sitting.ai_status === 'failed') waiting.failed.push(person(teacher));
    else if (open && sitting.response_count > 0) waiting.to_evaluate.push(person(teacher));
    else if (!hasResults) waiting.not_started.push(person(teacher));

    if (hasResults) {
      const report = findReport('teacher', test.id, teacher.id);
      if (!report || report.status === 'failed' || (report.status === 'done' && isStale(report, teacher.sections))) {
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
