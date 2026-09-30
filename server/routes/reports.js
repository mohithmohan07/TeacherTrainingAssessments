import express from 'express';
import db from '../db.js';
import { GRADES, potentialFor, teacherResults } from '../results.js';
import {
  findReport,
  isStale,
  queueSchoolReport,
  queueTeacherReports,
  schoolOverview,
  schoolReportIsStale,
} from '../reports.js';

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

function teacherPayload(teacher, test) {
  const sections = teacherResults(teacher.id, test.id);
  const report = findReport('teacher', test.id, teacher.id);
  return {
    teacher,
    school: selectSchool.get(teacher.school_id),
    test,
    grades: GRADES,
    sections: sections.map(({ questions, ...rest }) => rest),
    potential: potentialFor(sections),
    report: report && { ...report, stale: isStale(report, sections) },
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

function schoolPayload(school, test) {
  const overview = schoolOverview(school.id, test.id);
  const report = findReport('school', test.id, null);
  return {
    school,
    test,
    grades: GRADES,
    ...overview,
    report: report && { ...report, stale: schoolReportIsStale(report, overview) },
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

export default router;
