// Reports written by OpenAI from the marks (OpenAI does extraction and
// evaluation in this app; Gemini only writes question papers).
//
// For each teacher in a test, one request writes two short reports in plain
// words from the same results: one for the teacher, supportive and practical,
// and one for the school's management, factual, with numbered findings that
// its details and training plan refer back to. The school report, on all of a
// school's teachers, is a separate request, made only when someone asks for
// it. Percentages, grades, blank answers, school stages and the potential
// identifier are worked out here (results.js), never by the model, and each
// report keeps a copy of the results it was written from, question by
// question. The management reports also carry a training plan, whose path
// and days are worked out in training.js and whose content OpenAI writes in
// the same request.
import db from './db.js';
import { OPENAI_MODEL, friendly, openaiConfigured, requestJson } from './openai.js';
import {
  GRADES,
  NEEDS,
  SECTION_TITLES,
  STAGES,
  fingerprint,
  isBlank,
  needOf,
  potentialFor,
  resultsBasis,
  sectionName,
  stageOf,
  teacherResults,
} from './results.js';
import {
  SCHOOL_PLAN_INSTRUCTIONS,
  TEACHER_PLAN_INSTRUCTIONS,
  TEACHER_PLAN_SCHEMA,
  describeSchoolTraining,
  describeTeacherPlan,
  getFramework,
  schoolTraining,
  trainingPlanFor,
  writtenPlan,
} from './training.js';

// The layout reports are written in. A report written in an earlier one is
// not shown: it counts as out of date and the page asks for a rebuild.
export const LAYOUT = 2;

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

// At most this many reports are written at once, so building every report
// in a test does not send OpenAI dozens of requests together. A report
// waiting its turn shows as being written.
const MAX_WRITING = 3;
let writing = 0;
const waiting = [];

async function inTurn(work) {
  if (writing < MAX_WRITING) writing += 1;
  else await new Promise((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    // The place goes straight to the next report waiting, if there is one.
    const next = waiting.shift();
    if (next) next();
    else writing -= 1;
  }
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
        await inTurn(work);
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

const TEACHER_INSTRUCTIONS = `You write the reports for a teacher training assessment programme run in Indian schools.

You are given one teacher's results in one test: the sections they sat, with marks, percentage and grade in each, and for every question the marks, the examiner's feedback and a short extract of what the teacher wrote. Questions left blank are marked as such. The programme has up to three sections; teachers may sit only some of them, possibly on different dates.

Write two reports from the same results, in English. Keep both simple and short: plain, everyday words and short sentences that a busy principal or teacher can read in two minutes, with no jargon. Back each point with the evidence, citing questions and marks, such as "Section A questions 2 and 3 scored 3 out of 8". Write about the teacher by name or as "the teacher", never as "he" or "she". Refer to sections exactly as given, such as "Section A".

1. teacher_report, addressed to the teacher as "you". It helps the teacher get better and never criticises.
- summary: two or three short sentences: thank the teacher for taking the test, then the main strength and the main next step.
- went_well: two to four points. Each has a title of two to five words, such as "Clear examples", and one sentence of detail from their answers.
- next_steps: two to four points in the same way. Each detail is one concrete thing to try in their own classroom next week.
- practice_ideas: three short habits or activities that fit into a normal school week.
- Never use words like poor, weak, fail, lacking or inadequate. Be realistic about large classes, heavy workloads, little time, answering in a language that may not be their first, and writing by hand against the clock.
- Do not rank the teacher, compare them with others, or mention sections they did not sit.

2. management_report, for the principal and management. Factual and neutral.
- summary: two or three short sentences on what the results show, naming the sections sat, for example "The teacher did well in Section A and needs support in Section B. The classroom examples are practical, but several answers did not say how the idea would be taught." If questions were left blank, say how many. Do not mention training days; they are added after the summary.
- findings: three to five findings, the most important first; the report numbers them. Each has:
  - title: two to five words, such as "Checking understanding";
  - summary: one or two sentences for the first page, citing questions and marks;
  - details: two or three short points from the teacher's answers, for the details page;
  - why_it_matters: one sentence on why it matters for the children or the school;
  - action: one or two sentences on what will be done about it.
  When questions were left blank, make one finding about them, such as "Questions left blank", listing them.
- school_needs: two or three things the school needs to do, such as setting aside time for the training, arranging classroom visits by an UpSchool coach, or providing teaching materials.
- roles: up to two responsibilities the evidence supports, such as mentoring colleagues in a section, each with its evidence. Leave it empty if the results do not support any.
- support: up to three kinds of support that would help, most useful first.
- Do not speculate about the teacher's personal life, health or motives. Do not treat sections not sat as weaknesses. If only one or two sections were sat, say that the picture is partial.`;

// A titled point: a few words, then a sentence.
const POINT = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'detail'],
  properties: { title: { type: 'string' }, detail: { type: 'string' } },
};

const TEACHER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['teacher_report', 'management_report'],
  properties: {
    teacher_report: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'went_well', 'next_steps', 'practice_ideas'],
      properties: {
        summary: { type: 'string' },
        went_well: { type: 'array', items: POINT },
        next_steps: { type: 'array', items: POINT },
        practice_ideas: { type: 'array', items: { type: 'string' } },
      },
    },
    management_report: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'findings', 'school_needs', 'roles', 'support'],
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'summary', 'details', 'why_it_matters', 'action'],
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              details: { type: 'array', items: { type: 'string' } },
              why_it_matters: { type: 'string' },
              action: { type: 'string' },
            },
          },
        },
        school_needs: { type: 'array', items: { type: 'string' } },
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

const marks = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The schema with a training_plan to fill in as well, asked for only when
// there is a plan to write.
const withPlan = (schema, plan) => ({
  ...schema,
  required: [...schema.required, 'training_plan'],
  properties: { ...schema.properties, training_plan: plan },
});

// The results as the report writer sees them.
function describeResults(teacher, test, sections) {
  const blank = sections.flatMap((s) => s.questions.filter(isBlank));
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
    `Questions left blank: ${blank.length ? `${blank.length}, worth ${marks(blank.reduce((sum, q) => sum + (Number(q.max_marks) || 0), 0))} marks in all` : 'none'}`,
    '',
  ];
  for (const section of sections) {
    lines.push(
      `== ${section.name}${section.title ? ` (${section.title})` : ''}: ${section.awarded} / ${section.max} marks, ${section.percent}%, grade ${section.grade} ${section.grade_label}${section.date ? `, sat on ${section.date}` : ''}`
    );
    for (const q of section.questions) {
      if (isBlank(q)) {
        lines.push(`Q${q.question}: 0 / ${q.max_marks}. Left blank.`);
        continue;
      }
      lines.push(`Q${q.question}: ${q.marks_awarded} / ${q.max_marks}. Examiner: ${clip(q.feedback, 400)}`);
      if (q.teacher_answer) lines.push(`   Teacher wrote: ${clip(q.teacher_answer, 300)}`);
    }
    lines.push('');
  }
  return lines.filter((line) => line !== null).join('\n');
}

const text = (value, max = 1200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const strings = (list, most = 8) => (Array.isArray(list) ? list.map((item) => text(item, 600)).filter(Boolean).slice(0, most) : []);
const points = (list, most = 6) =>
  (Array.isArray(list) ? list : [])
    .map((p) => ({ title: text(p?.title, 120), detail: text(p?.detail, 600) }))
    .filter((p) => p.title || p.detail)
    .slice(0, most);

// A section's questions as the reports show them: marks, the examiner's
// feedback and the start of what the teacher wrote.
export function questionsOf(section) {
  return (section.questions ?? []).map((q) => ({
    question: String(q.question ?? ''),
    max_marks: Number(q.max_marks) || 0,
    marks_awarded: Number(q.marks_awarded) || 0,
    blank: isBlank(q),
    feedback: String(q.feedback ?? '').trim(),
    teacher_answer: clip(q.teacher_answer, 400),
  }));
}

// evaluated_at is kept so that isStale() can be checked against a snapshot.
// A teacher's own reports keep the questions too, so a printed report always
// shows the marks it was written from.
function snapshot(sections, { questions = false } = {}) {
  return sections.map(({ key, name, title, awarded, max, percent, grade, grade_label, date, assessment_id, evaluated_at, ...rest }) => ({
    key, name, title, awarded, max, percent, grade, grade_label, date, assessment_id, evaluated_at,
    ...(questions ? { questions: questionsOf(rest) } : {}),
  }));
}

async function writeTeacherReports(teacherId, testId, reportId) {
  const teacher = selectTeacher.get(teacherId);
  const test = selectTest.get(testId);
  const sections = teacherResults(teacherId, testId);
  if (!teacher || !test) throw friendly('This teacher or test no longer exists.');
  if (!sections.length) throw friendly('There are no marked sections for this teacher in this test yet. Press Evaluate first.');

  const framework = getFramework();
  const plan = trainingPlanFor(sections, framework);
  const raw = await requestJson({
    instructions: TEACHER_INSTRUCTIONS + (plan?.path ? TEACHER_PLAN_INSTRUCTIONS : ''),
    content: [{ type: 'input_text', text: describeResults(teacher, test, sections) + describeTeacherPlan(plan) }],
    name: 'teacher_reports',
    schema: plan?.path ? withPlan(TEACHER_SCHEMA, TEACHER_PLAN_SCHEMA) : TEACHER_SCHEMA,
    task: 'write this report',
    retry: 'Press Build report to try again.',
  });

  const t = raw.teacher_report ?? {};
  const m = raw.management_report ?? {};
  const findings = (Array.isArray(m.findings) ? m.findings : [])
    .map((f) => ({
      title: text(f?.title, 120),
      summary: text(f?.summary, 600),
      details: strings(f?.details, 4),
      why_it_matters: text(f?.why_it_matters, 400),
      action: text(f?.action, 600),
    }))
    .filter((f) => f.title || f.summary)
    .slice(0, 6);
  const content = {
    layout: LAYOUT,
    test_name: test.name,
    stage: stageOf(teacher.grade),
    sections: snapshot(sections, { questions: true }),
    potential: potentialFor(sections),
    need: needOf(sections),
    training: writtenPlan(plan, raw.training_plan, framework, findings.length),
    teacher: {
      summary: text(t.summary),
      went_well: points(t.went_well),
      next_steps: points(t.next_steps),
      practice_ideas: strings(t.practice_ideas, 5),
    },
    management: {
      summary: text(m.summary),
      findings,
      school_needs: strings(m.school_needs, 4),
      roles: (Array.isArray(m.roles) ? m.roles : [])
        .map((r) => ({ role: text(r?.role, 200), evidence: text(r?.evidence, 400) }))
        .filter((r) => r.role)
        .slice(0, 2),
      support: strings(m.support, 4),
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

// Whether a written report is in an earlier layout, and needs rebuilding to
// be shown.
export const isOldLayout = (report) => Boolean(report?.content) && report.content.layout !== LAYOUT;

// Whether the marks have changed since the report was written.
export function isStale(report, sections) {
  return Boolean(report?.basis) && report.basis !== fingerprint(resultsBasis(sections));
}

// Whether growth paths were added or changed after the report was written,
// so its training plan is out of date.
function pathsChanged(report, framework) {
  return Boolean(report?.content && framework) && report.content.training?.version !== framework.version;
}

// Whether a report needs rebuilding, for any of those reasons: the board, the
// dashboard and the profile page go by this.
export function isOutOfDate(report, sections, framework = getFramework()) {
  return isOldLayout(report) || pathsChanged(report, framework) || isStale(report, sections);
}

// Builds every teacher report in a test that is missing, failed or out of
// date, for the button on the Assessments page. Returns how many it started,
// or the reason it could not.
export function queueTestReports(schoolId, testId) {
  const test = selectTest.get(testId);
  if (!test || test.school_id !== schoolId) return { error: 'Test not found for this school.' };
  if (!openaiConfigured()) return { error: 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.' };
  const framework = getFramework();
  let started = 0;
  for (const teacher of selectTeachersOfSchool.all(schoolId)) {
    const sections = teacherResults(teacher.id, testId);
    if (!sections.length) continue;
    const report = findReport('teacher', testId, teacher.id);
    const due = !report || report.status === 'failed' || (report.status === 'done' && isOutOfDate(report, sections, framework));
    if (due && !queueTeacherReports(teacher.id, testId)) started += 1;
  }
  return { started };
}

/* ------------------------------------------------------- the school report */

// A group of teachers' figures: how many there are, their average in each
// section among those who sat it, and how many are on track, developing or
// in need of support.
function groupFigures(members, keys) {
  const averages = {};
  const sat = {};
  for (const key of keys) {
    const percents = members.flatMap((t) => t.sections.filter((s) => s.key === key && s.percent !== null).map((s) => s.percent));
    sat[key] = percents.length;
    averages[key] = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null;
  }
  const needs = Object.fromEntries(NEEDS.map((n) => [n.key, members.filter((t) => t.need === n.key).length]));
  return { teachers: members.length, averages, sat, needs };
}

// The school's stages, youngest first, each with its teachers' figures. Only
// stages with assessed teachers are listed; teachers whose classes name no
// stage come last.
const NO_STAGE = { key: null, name: 'Stage Not Given', classes: '' };

function stageStats(assessed, keys) {
  return [...STAGES, NO_STAGE]
    .map((stage) => {
      const members = assessed.filter((t) => t.stage === stage.key);
      return members.length ? { key: stage.key, name: stage.name, classes: stage.classes, ...groupFigures(members, keys) } : null;
    })
    .filter(Boolean);
}

const stageName = (key) => STAGES.find((stage) => stage.key === key)?.name ?? null;

// Figures for the school report, worked out from the marks: each teacher's
// sections, stage and need, how each section went across the school and in
// each stage, and who could help whom.
export function schoolOverview(schoolId, testId) {
  const teachers = selectTeachersOfSchool.all(schoolId).map((teacher) => {
    const sections = teacherResults(teacher.id, testId);
    return {
      id: teacher.id,
      name: teacher.name,
      grade: teacher.grade,
      subjects: teacher.subjects,
      stage: stageOf(teacher.grade),
      sections: snapshot(sections),
      potential: potentialFor(sections),
      need: needOf(sections),
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
    stage_stats: stageStats(assessed, keys),
    whole: groupFigures(assessed, keys),
    assessed: assessed.length,
    not_assessed: teachers.filter((t) => !t.sections.length).map((t) => t.name),
    mentors: assessed.filter((t) => t.potential?.level === 'mentor').map((t) => t.name),
    support: assessed.filter((t) => t.potential?.level === 'support').map((t) => t.name),
  };
}

const SCHOOL_INSTRUCTIONS = `You write the school report for a teacher training assessment programme run in Indian schools: one short report on all the teachers of one school, for the principal and management.

You are given every assessed teacher's results in one test, with figures by section, by need and by school stage (Pre-Primary, Primary, Middle School, High School and PUC), a rule-based potential identifier for each teacher and, where available, the main findings from their own reports. Teachers may have sat only some sections, so only compare teachers within a section.

Write in English that is simple and short: plain, everyday words and short sentences that a busy principal can read in two minutes, with no jargon. Base every statement on the figures given and cite them, such as "In Primary, 5 of 9 teachers are at Grade C in Section C". Be factual and neutral. Write about teachers by name, never as "he" or "she". Refer to sections exactly as given, such as "Section A".
- summary: two or three short sentences: how many teachers took the test, how many need support, and the main pattern by stage or section.
- findings: three to five findings, the most important first; the report numbers them. Each has a title of three to eight words that states the finding, such as "Primary teachers are strong in Section C", and a detail of one or two sentences with the figures. Look for patterns by stage and by section, and name teachers who are strong in a section and could help others.
- actions: three to five things UpSchool's team and the school will do, the most important first, each one sentence, such as "Hold workshops on Section B for the 6 teachers at Grade D, with Middle School and High School teachers in separate groups." Give each a timing such as "Weeks 1–2", or "" when there is none. Pair teachers strong in a section with those who need help in it, in the same stage where possible.
- school_needs: two or three things the school needs to do, such as fixing the training calendar, freeing time for teachers who mentor colleagues, or arranging classroom visits by UpSchool coaches.
- Do not rank teachers against each other beyond what the figures show, and do not speculate about personal circumstances.`;

const SCHOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'actions', 'school_needs'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: POINT },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['timing', 'action'],
        properties: { timing: { type: 'string' }, action: { type: 'string' } },
      },
    },
    school_needs: { type: 'array', items: { type: 'string' } },
  },
};

// What the school report is written from: each teacher's stage and results.
function schoolBasis(overview) {
  return fingerprint(overview.teachers.map((t) => [t.id, t.stage, t.sections.map((s) => [s.key, s.assessment_id, s.percent])]));
}

// The main findings of a teacher's own report, for the school report.
function findingsOf(report) {
  const m = report?.content?.management;
  if (!m) return [];
  if (Array.isArray(m.findings)) return m.findings.map((f) => `${f.title}: ${f.summary}`);
  return (m.sections ?? []).flatMap((s) => (s.gaps ?? []).map((g) => `${s.section}: ${g}`));
}

async function writeSchoolReport(schoolId, testId, reportId) {
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(schoolId);
  const test = selectTest.get(testId);
  const overview = schoolOverview(schoolId, testId);
  if (!overview.assessed) throw friendly('No teacher in this test has marked sections yet.');

  const keys = overview.section_stats.map((s) => s.key);
  const teachers = (n) => `${n} teacher${n === 1 ? '' : 's'}`;
  const averages = (figures) => keys.map((key) => `${sectionName(key)} ${figures.averages[key] === null ? 'not sat' : `${figures.averages[key]}%`}`).join(', ');
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
    'Teachers by need, from their lowest grade:',
    ...NEEDS.map((n) => `- ${n.label} (${n.meaning}): ${overview.whole.needs[n.key]}`),
    '',
    'By school stage (stage averages are among that stage\'s teachers who sat the section):',
    ...overview.stage_stats.map(
      (s) => `- ${s.name}${s.classes ? ` (${s.classes})` : ''}: ${teachers(s.teachers)}; ${averages(s)}; ${NEEDS.map((n) => `${n.label} ${s.needs[n.key]}`).join(', ')}`
    ),
    `- Whole school: ${teachers(overview.whole.teachers)}; ${averages(overview.whole)}`,
    '',
    'Teachers:',
  ];
  for (const teacher of overview.teachers.filter((t) => t.sections.length)) {
    const found = findingsOf(findReport('teacher', testId, teacher.id));
    const about = [stageName(teacher.stage), teacher.grade, teacher.subjects].filter(Boolean).join(', ');
    lines.push(
      `- ${teacher.name}${about ? ` (${about})` : ''}: ` +
        teacher.sections.map((s) => `${s.name} ${s.percent}% (${s.grade})`).join(', ') +
        `. Potential: ${teacher.potential?.headline ?? '—'}.` +
        (found.length ? ` Main findings: ${found.slice(0, 4).map((f) => clip(f, 160)).join('; ')}` : '')
    );
  }
  if (overview.not_assessed.length) lines.push('', `Not yet assessed in this test: ${overview.not_assessed.join(', ')}`);

  const training = schoolTraining(overview.teachers, getFramework());
  const planning = Boolean(training?.paths.length);
  const raw = await requestJson({
    instructions: SCHOOL_INSTRUCTIONS + (planning ? SCHOOL_PLAN_INSTRUCTIONS : ''),
    content: [{ type: 'input_text', text: lines.join('\n') + describeSchoolTraining(training, stageName) }],
    name: 'school_report',
    schema: SCHOOL_SCHEMA,
    task: 'write this report',
    retry: 'Press Build report to try again.',
  });

  const content = {
    layout: LAYOUT,
    test_name: test.name,
    ...overview,
    summary: text(raw.summary),
    findings: points(raw.findings),
    actions: (Array.isArray(raw.actions) ? raw.actions : [])
      .map((a) => ({ timing: text(a?.timing, 60), action: text(a?.action, 600) }))
      .filter((a) => a.action)
      .slice(0, 6),
    school_needs: strings(raw.school_needs, 4),
    training,
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
