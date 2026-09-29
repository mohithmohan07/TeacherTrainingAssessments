// Reports written by OpenAI from the marks (OpenAI does extraction and
// evaluation in this app; Gemini only writes question papers).
//
// For each teacher in a test, one request writes two reports from the same
// results: one for the teacher, supportive and practical, and one for the
// school's management, factual and evidence-based. The management report on
// all of a school's teachers is a separate request, made only when someone
// asks for it. Percentages, grades and the potential identifier are worked
// out here (results.js), never by the model, and each report keeps a copy of
// the results it was written from.
import db from './db.js';
import { OPENAI_MODEL, friendly, openaiConfigured, requestJson } from './openai.js';
import {
  GRADES,
  SECTION_TITLES,
  fingerprint,
  potentialFor,
  resultsBasis,
  sectionKey,
  teacherResults,
} from './results.js';

const selectTeacher = db.prepare(
  `SELECT t.*, s.name AS school_name FROM teachers t JOIN schools s ON s.id = t.school_id WHERE t.id = ?`
);
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');
const selectTeachersOfSchool = db.prepare('SELECT * FROM teachers WHERE school_id = ? ORDER BY name COLLATE NOCASE');

const selectReport = db.prepare(
  'SELECT * FROM reports WHERE kind = ? AND test_id = ? AND teacher_id IS ? ORDER BY id DESC LIMIT 1'
);
const insertReport = db.prepare(
  `INSERT INTO reports (kind, school_id, test_id, teacher_id, status) VALUES (@kind, @school_id, @test_id, @teacher_id, 'running')`
);
const markRunning = db.prepare(`UPDATE reports SET status = 'running', error = NULL, updated_at = datetime('now') WHERE id = ?`);
const markFailed = db.prepare(`UPDATE reports SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`);
const saveReport = db.prepare(
  `UPDATE reports SET status = 'done', error = NULL, content = @content, basis = @basis, model = @model,
          written_at = datetime('now'), updated_at = datetime('now')
    WHERE id = @id`
);

export function findReport(kind, testId, teacherId = null) {
  const row = selectReport.get(kind, testId, teacherId);
  if (!row) return null;
  return { ...row, content: row.content ? JSON.parse(row.content) : null };
}

// Starts a report, or marks the one already being written to go round again
// once it finishes, so marks that arrive mid-way are never left out.
const building = new Map();

function queue(key, reportRow, work) {
  if (building.has(key)) {
    building.get(key).again = true;
    return;
  }
  const job = { again: false };
  building.set(key, job);
  (async () => {
    do {
      job.again = false;
      markRunning.run(reportRow.id);
      try {
        await work();
      } catch (error) {
        console.error(`Writing report ${reportRow.id} failed:`, error);
        markFailed.run(error.userMessage ?? `The report could not be written: ${error.message}`, reportRow.id);
      }
    } while (job.again);
    building.delete(key);
  })();
}

function reportRowFor(kind, schoolId, testId, teacherId) {
  const existing = selectReport.get(kind, testId, teacherId);
  if (existing) return existing;
  const info = insertReport.run({ kind, school_id: schoolId, test_id: testId, teacher_id: teacherId });
  return { id: info.lastInsertRowid };
}

/* ------------------------------------------------------ one teacher's reports */

const TEACHER_INSTRUCTIONS = `You write the feedback reports for a teacher training assessment programme run in Indian schools.

You are given one teacher's results in one test: the sections they sat, their percentage and grade in each, and for every question the marks, the examiner's feedback and a short extract of what the teacher wrote. The programme has up to three sections; teachers may sit only some of them, possibly on different dates.

Write two reports from the same results, both in English.

1. teacher_report, addressed to the teacher as "you". Its purpose is to help the teacher get better, never to criticise them.
- Begin by recognising the effort it takes to sit an assessment alongside a full teaching load.
- Be realistic about the challenges teachers face: large and mixed-ability classes, heavy workloads, limited time and devices, answering in a language that may not be their first, and writing long answers by hand against the clock. Where the marks suggest one of these got in the way, say so kindly rather than treating it as a failing.
- For each section sat, name what went well with specific examples from their answers, then give next steps: concrete things they can try in their own classroom next week, not general advice.
- Never use words like poor, weak, fail, lacking or inadequate. Describe gaps as next steps.
- practice_ideas: three to five small habits or activities the teacher can realistically fit into a normal school week.
- Do not mention percentages beyond those given, rank the teacher, compare them to others, or mention sections they did not sit.
- Write about the teacher without gender. Keep the whole report warm, respectful and easy to read.

2. management_report, for the school's principal and management. Factual and neutral.
- summary: two to four sentences on what the results show, naming the sections sat.
- For each section sat: evidence (what the marks show, citing question numbers and marks), strengths and gaps as short factual points.
- roles: responsibilities this teacher could take on that the evidence supports (for example mentoring colleagues in an area, leading parent communication, or championing digital teaching). Give the evidence for each. Leave it empty if the results do not support any.
- support: specific training, mentoring or classroom support that would help, most useful first.
- Do not speculate about the teacher's personal life, health or motives. Do not treat unsat sections as weaknesses. If only one or two sections were sat, say that the picture is partial.

Refer to sections exactly as given, for example "Section A".`;

const TEACHER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['teacher_report', 'management_report'],
  properties: {
    teacher_report: {
      type: 'object',
      additionalProperties: false,
      required: ['opening', 'sections', 'practice_ideas', 'closing'],
      properties: {
        opening: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['section', 'went_well', 'next_steps'],
            properties: {
              section: { type: 'string' },
              went_well: { type: 'array', items: { type: 'string' } },
              next_steps: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        practice_ideas: { type: 'array', items: { type: 'string' } },
        closing: { type: 'string' },
      },
    },
    management_report: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'sections', 'roles', 'support'],
      properties: {
        summary: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['section', 'evidence', 'strengths', 'gaps'],
            properties: {
              section: { type: 'string' },
              evidence: { type: 'string' },
              strengths: { type: 'array', items: { type: 'string' } },
              gaps: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        roles: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'evidence'],
            properties: { role: { type: 'string' }, evidence: { type: 'string' } },
          },
        },
        support: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const clip = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

// The results as the report writer sees them.
function describeResults(teacher, test, sections) {
  const lines = [
    `Teacher: ${teacher.name}`,
    teacher.grade ? `Teaches: ${teacher.grade}` : null,
    teacher.subjects ? `Subjects: ${teacher.subjects}` : null,
    `School: ${teacher.school_name}`,
    `Test: ${test.name}`,
    `Grade bands: ${GRADES.map((g) => `${g.grade} ${g.label} (${g.min}%+)`).join(', ')}`,
    `Sections sat: ${sections.map((s) => s.name).join(', ')}`,
    `Sections not sat (do not comment on them): ${Object.keys(SECTION_TITLES)
      .filter((key) => !sections.some((s) => s.key === key))
      .map((key) => `Section ${key}`)
      .join(', ') || 'none'}`,
    '',
  ];
  for (const section of sections) {
    lines.push(
      `== ${section.name}${section.title ? ` (${section.title})` : ''}: ${section.awarded} / ${section.max} marks, ${section.percent}%, grade ${section.grade} ${section.grade_label}${section.date ? `, sat on ${section.date}` : ''}`
    );
    for (const q of section.questions) {
      lines.push(`Q${q.question}: ${q.marks_awarded} / ${q.max_marks}. Examiner: ${clip(q.feedback, 400)}`);
      if (q.teacher_answer) lines.push(`   Teacher wrote: ${clip(q.teacher_answer, 300)}`);
    }
    lines.push('');
  }
  return lines.filter((line) => line !== null).join('\n');
}

// Keeps only sections the teacher actually sat, in their order, and fills in
// the name each one should carry.
function matchSections(items, sections) {
  const byKey = new Map();
  for (const item of items ?? []) {
    const key = sectionKey(item.section);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return sections.filter((s) => byKey.has(s.key)).map((s) => ({ ...byKey.get(s.key), section: s.name }));
}

const strings = (list) => (Array.isArray(list) ? list.map((item) => String(item).trim()).filter(Boolean) : []);

function snapshot(sections) {
  return sections.map(({ key, name, title, awarded, max, percent, grade, grade_label, date, assessment_id }) => ({
    key, name, title, awarded, max, percent, grade, grade_label, date, assessment_id,
  }));
}

async function writeTeacherReports(teacherId, testId, reportId) {
  const teacher = selectTeacher.get(teacherId);
  const test = selectTest.get(testId);
  const sections = teacherResults(teacherId, testId);
  if (!teacher || !test) throw friendly('This teacher or test no longer exists.');
  if (!sections.length) throw friendly('There are no marked sections for this teacher in this test yet. Press Evaluate first.');

  const raw = await requestJson({
    instructions: TEACHER_INSTRUCTIONS,
    content: [{ type: 'input_text', text: describeResults(teacher, test, sections) }],
    name: 'teacher_reports',
    schema: TEACHER_SCHEMA,
    task: 'write this report',
    retry: 'Press Build report to try again.',
  });

  const t = raw.teacher_report ?? {};
  const m = raw.management_report ?? {};
  const content = {
    test_name: test.name,
    sections: snapshot(sections),
    potential: potentialFor(sections),
    teacher: {
      opening: String(t.opening ?? '').trim(),
      sections: matchSections(t.sections, sections).map((s) => ({
        section: s.section,
        went_well: strings(s.went_well),
        next_steps: strings(s.next_steps),
      })),
      practice_ideas: strings(t.practice_ideas),
      closing: String(t.closing ?? '').trim(),
    },
    management: {
      summary: String(m.summary ?? '').trim(),
      sections: matchSections(m.sections, sections).map((s) => ({
        section: s.section,
        evidence: String(s.evidence ?? '').trim(),
        strengths: strings(s.strengths),
        gaps: strings(s.gaps),
      })),
      roles: (m.roles ?? [])
        .map((r) => ({ role: String(r.role ?? '').trim(), evidence: String(r.evidence ?? '').trim() }))
        .filter((r) => r.role),
      support: strings(m.support),
    },
  };

  saveReport.run({
    id: reportId,
    content: JSON.stringify(content),
    basis: fingerprint(resultsBasis(sections)),
    model: OPENAI_MODEL,
  });
}

// Writes (or rewrites) a teacher's two reports in the background. Returns an
// error message if it cannot start.
export function queueTeacherReports(teacherId, testId) {
  const teacher = selectTeacher.get(teacherId);
  const test = selectTest.get(testId);
  if (!teacher || !test) return 'Teacher or test not found.';
  if (!openaiConfigured()) return 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.';
  if (!teacherResults(teacherId, testId).length) return 'There are no marked sections for this teacher in this test yet. Press Evaluate first.';

  const row = reportRowFor('teacher', teacher.school_id, testId, teacherId);
  queue(`teacher:${teacherId}:${testId}`, row, () => writeTeacherReports(teacherId, testId, row.id));
  return null;
}

// Whether the marks have changed since the report was written.
export function isStale(report, sections) {
  return Boolean(report?.basis) && report.basis !== fingerprint(resultsBasis(sections));
}

/* ------------------------------------------------- the whole school's report */

// Figures for the management report on all teachers, worked out from the
// marks: each teacher's sections, how each section went across the school,
// and who could help whom.
export function schoolOverview(schoolId, testId) {
  const teachers = selectTeachersOfSchool.all(schoolId).map((teacher) => {
    const sections = teacherResults(teacher.id, testId);
    return {
      id: teacher.id,
      name: teacher.name,
      grade: teacher.grade,
      subjects: teacher.subjects,
      sections: snapshot(sections),
      potential: potentialFor(sections),
    };
  });

  const keys = [...new Set(teachers.flatMap((t) => t.sections.map((s) => s.key)))].sort();
  const sectionStats = keys.map((key) => {
    const results = teachers.flatMap((t) => t.sections.filter((s) => s.key === key && s.percent !== null).map((s) => ({ teacher: t, s })));
    const counts = Object.fromEntries(GRADES.map((g) => [g.grade, 0]));
    for (const { s } of results) counts[s.grade] += 1;
    return {
      key,
      name: results[0]?.s.name ?? key,
      title: SECTION_TITLES[key] ?? '',
      sat: results.length,
      average: results.length ? Math.round(results.reduce((sum, r) => sum + r.s.percent, 0) / results.length) : null,
      counts,
      // Colleagues strong in a section alongside those who need support in it.
      helpers: results.filter((r) => r.s.grade === 'A' || r.s.grade === 'B').map((r) => r.teacher.name),
      needs: results.filter((r) => r.s.grade === 'D').map((r) => r.teacher.name),
    };
  });

  const assessed = teachers.filter((t) => t.sections.length);
  return {
    teachers,
    section_stats: sectionStats,
    assessed: assessed.length,
    not_assessed: teachers.filter((t) => !t.sections.length).map((t) => t.name),
    mentors: assessed.filter((t) => t.potential?.level === 'mentor').map((t) => t.name),
    support: assessed.filter((t) => t.potential?.level === 'support').map((t) => t.name),
  };
}

const SCHOOL_INSTRUCTIONS = `You write the management report on all the teachers of one school in a teacher training assessment programme run in Indian schools.

You are given every assessed teacher's results in one test, section by section, with a rule-based potential identifier for each teacher and, where available, the gaps noted in their individual reports. Teachers may have sat only some sections, so only compare teachers within a section.

Write for the principal and management, in English. Be factual and neutral, and base every statement on the figures given.
- overview: one short paragraph on how the staff did overall in each section, and how complete the picture is.
- section_insights: for each section with results, the pattern across teachers and the single most useful training priority for that section.
- recommendations: four to six concrete actions for the school's professional development plan over the next term, most important first. Where some teachers are strong in a section and others need support in it, suggest peer mentoring by name.
- Do not rank teachers against each other beyond what the figures show, and do not speculate about personal circumstances.`;

const SCHOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'section_insights', 'recommendations'],
  properties: {
    overview: { type: 'string' },
    section_insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'pattern', 'training_priority'],
        properties: {
          section: { type: 'string' },
          pattern: { type: 'string' },
          training_priority: { type: 'string' },
        },
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

function schoolBasis(overview) {
  return fingerprint(overview.teachers.map((t) => [t.id, t.sections.map((s) => [s.key, s.assessment_id, s.percent])]));
}

async function writeSchoolReport(schoolId, testId, reportId) {
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(schoolId);
  const test = selectTest.get(testId);
  const overview = schoolOverview(schoolId, testId);
  if (!overview.assessed) throw friendly('No teacher in this test has marked sections yet.');

  const lines = [
    `School: ${school.name}`,
    `Test: ${test.name}`,
    `Teachers assessed: ${overview.assessed} of ${overview.teachers.length}`,
    `Grade bands: ${GRADES.map((g) => `${g.grade} ${g.label} (${g.min}%+)`).join(', ')}`,
    '',
    'Section averages across the teachers who sat each section:',
    ...overview.section_stats.map(
      (s) => `${s.name}${s.title ? ` (${s.title})` : ''}: ${s.sat} sat, average ${s.average}%, grades ${Object.entries(s.counts).map(([g, n]) => `${g}: ${n}`).join(', ')}`
    ),
    '',
    'Teachers:',
  ];
  for (const teacher of overview.teachers.filter((t) => t.sections.length)) {
    const report = findReport('teacher', testId, teacher.id);
    const gaps = report?.content?.management?.sections?.flatMap((s) => s.gaps.map((g) => `${s.section}: ${g}`)) ?? [];
    lines.push(
      `- ${teacher.name}${teacher.subjects ? ` (${teacher.subjects}${teacher.grade ? `, ${teacher.grade}` : ''})` : ''}: ` +
        teacher.sections.map((s) => `${s.name} ${s.percent}% (${s.grade})`).join(', ') +
        `. Potential: ${teacher.potential?.headline ?? '—'}.` +
        (gaps.length ? ` Noted gaps: ${gaps.slice(0, 4).map((g) => clip(g, 160)).join('; ')}` : '')
    );
  }
  if (overview.not_assessed.length) lines.push('', `Not yet assessed in this test: ${overview.not_assessed.join(', ')}`);

  const raw = await requestJson({
    instructions: SCHOOL_INSTRUCTIONS,
    content: [{ type: 'input_text', text: lines.join('\n') }],
    name: 'school_report',
    schema: SCHOOL_SCHEMA,
    task: 'write this report',
    retry: 'Press Build report to try again.',
  });

  const content = {
    test_name: test.name,
    ...overview,
    overview: String(raw.overview ?? '').trim(),
    section_insights: matchSections(raw.section_insights, overview.section_stats).map((s) => ({
      section: s.section,
      pattern: String(s.pattern ?? '').trim(),
      training_priority: String(s.training_priority ?? '').trim(),
    })),
    recommendations: strings(raw.recommendations),
  };
  saveReport.run({ id: reportId, content: JSON.stringify(content), basis: schoolBasis(overview), model: OPENAI_MODEL });
}

export function queueSchoolReport(schoolId, testId) {
  const test = selectTest.get(testId);
  if (!test || test.school_id !== schoolId) return 'Test not found for this school.';
  if (!openaiConfigured()) return 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.';
  if (!schoolOverview(schoolId, testId).assessed) return 'No teacher in this test has marked sections yet.';

  const row = reportRowFor('school', schoolId, testId, null);
  queue(`school:${testId}`, row, () => writeSchoolReport(schoolId, testId, row.id));
  return null;
}

export function schoolReportIsStale(report, overview) {
  return Boolean(report?.basis) && report.basis !== schoolBasis(overview);
}
