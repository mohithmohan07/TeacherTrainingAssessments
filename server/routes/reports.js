import express from 'express';
import db from '../db.js';
import { GRADES, NEEDS, SECTION_TITLES, potentialFor, teacherResults } from '../results.js';
import {
  findReport,
  isOldLayout,
  isStale,
  questionsOf,
  queueSchoolReport,
  queueTeacherReports,
  queueTestReports,
  schoolOverview,
  schoolReportIsStale,
} from '../reports.js';
import { getFramework, schoolTraining } from '../training.js';

const router = express.Router();

const selectTeacher = db.prepare('SELECT * FROM teachers WHERE id = ?');
const selectSchool = db.prepare('SELECT id, name, logo_path, city, state FROM schools WHERE id = ?');
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');

function lookupTeacher(req, res) {
  const teacher = selectTeacher.get(Number(req.query.teacher_id ?? req.body?.teacher_id));
  const test = selectTest.get(Number(req.query.test_id ?? req.body?.test_id));
  if (!teacher || !test || test.school_id !== teacher.school_id) {
    res.status(404).json({ error: 'Teacher or test not found.' });
    return null;
  }
  return { teacher, test };
}

function lookupSchool(req, res) {
  const school = selectSchool.get(Number(req.query.school_id ?? req.body?.school_id));
  const test = selectTest.get(Number(req.query.test_id ?? req.body?.test_id));
  if (!school || !test || test.school_id !== school.id) {
    res.status(404).json({ error: 'School or test not found.' });
    return null;
  }
  return { school, test };
}

// `training` says whether growth paths are set up, and which version, so the
// page can tell when a report's training plan is missing or out of date.
function trainingState() {
  const framework = getFramework();
  return { set: Boolean(framework), version: framework?.version ?? null };
}

function teacherPayload(teacher, test) {
  const sections = teacherResults(teacher.id, test.id);
  const report = findReport('teacher', test.id, teacher.id);
  return {
    teacher,
    school: selectSchool.get(teacher.school_id),
    test,
    grades: GRADES,
    section_titles: SECTION_TITLES,
    sections: sections.map(({ questions, ...rest }) => ({ ...rest, questions: questionsOf({ questions }) })),
    potential: potentialFor(sections),
    report: report && { ...report, stale: isStale(report, sections), old_layout: isOldLayout(report) },
    training: trainingState(),
  };
}

// GET /api/reports/teacher?teacher_id=1&test_id=2
router.get('/teacher', (req, res) => {
  const found = lookupTeacher(req, res);
  if (found) res.json(teacherPayload(found.teacher, found.test));
});

router.post('/teacher', (req, res) => {
  const found = lookupTeacher(req, res);
  if (!found) return;
  const problem = queueTeacherReports(found.teacher.id, found.test.id);
  if (problem) return res.status(400).json({ error: problem });
  res.status(202).json(teacherPayload(found.teacher, found.test));
});

// The figures are live until the report is written; the page then shows the
// ones the report was written from.
function schoolPayload(school, test) {
  const overview = schoolOverview(school.id, test.id);
  const report = findReport('school', test.id, null);
  return {
    school,
    test,
    grades: GRADES,
    needs: NEEDS,
    section_titles: SECTION_TITLES,
    ...overview,
    training: schoolTraining(overview.teachers, getFramework()),
    training_state: trainingState(),
    report: report && { ...report, stale: schoolReportIsStale(report, overview), old_layout: isOldLayout(report) },
  };
}

// GET /api/reports/school?school_id=1&test_id=2
router.get('/school', (req, res) => {
  const found = lookupSchool(req, res);
  if (found) res.json(schoolPayload(found.school, found.test));
});

router.post('/school', (req, res) => {
  const found = lookupSchool(req, res);
  if (!found) return;
  const problem = queueSchoolReport(found.school.id, found.test.id);
  if (problem) return res.status(400).json({ error: problem });
  res.status(202).json(schoolPayload(found.school, found.test));
});

// Builds every teacher report in the test that is missing, failed or out of
// date. POST /api/reports/teachers { school_id, test_id }
router.post('/teachers', (req, res) => {
  const found = lookupSchool(req, res);
  if (!found) return;
  const result = queueTestReports(found.school.id, found.test.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(202).json(result);
});

export default router;
