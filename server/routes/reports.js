import express from 'express';
import db from '../db.js';
import { GRADES, NEEDS, SECTION_TITLES, potentialFor, teacherResults } from '../results.js';
import {
  findReport,
  isOldLayout,
  isStale,
  lacksAnswers,
  lacksPlainWords,
  lacksWritingScore,
  questionsOf,
  queueSchoolReport,
  queueTeacherReports,
  queueTestReports,
  schoolOverview,
  schoolReportIsStale,
  withCurrentNames,
} from '../reports.js';
import { getFramework, schoolTraining } from '../training.js';
import { sittingPapers } from '../papers.js';
import { startZip, zipFile, zipState } from '../bundle.js';

const router = express.Router();

const selectTeacher = db.prepare('SELECT * FROM teachers WHERE id = ?');
const selectSchool = db.prepare('SELECT id, name, logo_path, city, state FROM schools WHERE id = ?');
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');
const selectSitting = db.prepare('SELECT id, assessment_date FROM assessments WHERE id = ? AND teacher_id = ?');
const selectSittingFiles = db.prepare('SELECT kind, stored_name, mime_type FROM assessment_files WHERE assessment_id = ? ORDER BY position, id');

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

// The papers behind a teacher's results, for the evidence at the end of the
// reports: for each sitting, the question paper (any confirmed from the
// library, then any scanned) and the teacher's answer paper. The sittings are
// those behind the results now and behind the written report, so the page
// has them whichever it shows.
function evidenceFor(teacherId, ...sectionLists) {
  const ids = [...new Set(sectionLists.flat().flatMap((s) => s.assessment_ids ?? [s.assessment_id]).filter(Boolean))];
  return ids.flatMap((id) => {
    const sitting = selectSitting.get(id, teacherId);
    if (!sitting) return [];
    const files = selectSittingFiles.all(id);
    const pages = (kind) => files.filter((f) => f.kind === kind).map((f) => ({ url: `/uploads/${f.stored_name}`, type: f.mime_type }));
    return [{
      assessment_id: id,
      date: sitting.assessment_date,
      papers: sittingPapers(id).map((p) => ({ url: `/uploads/${p.stored_name}`, sections: String(p.sections).split(',').filter(Boolean) })),
      question_paper: pages('question_paper'),
      response: pages('response'),
    }];
  });
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
    sections: sections.map(({ questions, ...rest }) => ({ ...rest, questions: questionsOf({ questions, marking: rest.marking }) })),
    potential: potentialFor(sections),
    report: report && {
      ...report,
      content: withCurrentNames(report.content),
      stale: isStale(report, sections),
      old_layout: isOldLayout(report),
      no_answers: lacksAnswers(report),
      no_writing: lacksWritingScore(report),
      old_words: lacksPlainWords(report),
    },
    training: trainingState(),
    evidence: evidenceFor(teacher.id, sections, report?.content?.sections ?? []),
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
    report: report && { ...report, content: withCurrentNames(report.content), stale: schoolReportIsStale(report, overview), old_layout: isOldLayout(report), old_words: lacksPlainWords(report) },
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

// Every report of the test in one zip, printed to PDF on the server. GET says
// how the zip is getting on, POST starts it, and /file downloads it once
// ready. POST /api/reports/zip { school_id, test_id, time_zone, locale }
router.get('/zip', (req, res) => {
  const found = lookupSchool(req, res);
  if (found) res.json({ job: zipState(found.school.id, found.test.id) });
});

router.post('/zip', (req, res) => {
  const found = lookupSchool(req, res);
  if (!found) return;
  const problem = startZip(found.school.id, found.test.id, { time_zone: req.body?.time_zone, locale: req.body?.locale });
  if (problem) return res.status(400).json({ error: problem });
  res.status(202).json({ job: zipState(found.school.id, found.test.id) });
});

router.get('/zip/file', (req, res) => {
  const found = lookupSchool(req, res);
  if (!found) return;
  const gone = () =>
    res.status(404).json({
      error:
        zipState(found.school.id, found.test.id)?.status === 'running'
          ? 'The zip is still being made. It downloads from the Assessments page when it is ready.'
          : 'This zip is no longer on the server. Press Download all reports to make it again.',
    });
  const zip = zipFile(found.school.id, found.test.id);
  if (!zip) return gone();
  res.set('Cache-Control', 'no-store');
  res.download(zip.file, zip.name, (error) => {
    if (error && !res.headersSent) gone();
  });
});

export default router;
