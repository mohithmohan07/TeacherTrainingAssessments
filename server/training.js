// The training plan in the management reports, drawn from UpSchool's growth
// paths.
//
// The paths (their names, what each covers and how many days it takes) are
// kept on this server, typed in on the Training paths page or read by OpenAI from a
// proposal, and never in the code: they come from documents written for one
// school. From a teacher's section grades the plan picks a path and shares
// its days out between the sections that need support, classroom application
// and a review day, by fixed rules, so every teacher is planned the same way
// and the days always add up. OpenAI then writes what each block of days
// covers for that teacher, and how UpSchool's team would run it.
import db from './db.js';
import { friendly, requestJson } from './openai.js';
import { GRADES, SECTION_TITLES, fingerprint } from './results.js';

const MAX_PATHS = 6;
const MAX_DAYS = 120;

const selectSetting = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?');
const upsertSetting = db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
const deleteSetting = db.prepare('DELETE FROM settings WHERE key = ?');

const text = (value, max = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const strings = (list) => (Array.isArray(list) ? list.map((item) => text(item)).filter(Boolean) : []);
const wholeNumber = (value) => {
  const n = Math.round(Number(value));
  return value === '' || value === null || value === undefined || !Number.isFinite(n) ? null : n;
};
const listing = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const dayRange = (from, to) => (from === to ? `Day ${from}` : `Days ${from}–${to}`);

/* ------------------------------------------------------------- the paths */

export function getFramework() {
  const row = selectSetting.get('training');
  if (!row) return null;
  try {
    return { ...JSON.parse(row.value), updated_at: row.updated_at };
  } catch {
    return null;
  }
}

// Blank rows are dropped and the rest tidied; saveFramework() checks them.
export function cleanFramework(body) {
  const paths = (Array.isArray(body?.paths) ? body.paths : [])
    .map((path) => {
      let min = wholeNumber(path?.min_days);
      let max = wholeNumber(path?.max_days);
      if (min === null) min = max;
      if (max === null) max = min;
      return { name: text(path?.name, 80), scope: text(path?.scope, 240), min_days: min, max_days: max };
    })
    .filter((path) => path.name || path.scope || path.min_days !== null);
  return {
    programme: text(body?.programme, 80),
    paths,
    exit_assessment: text(body?.exit_assessment, 700),
    continuity: text(body?.continuity, 700),
  };
}

export function saveFramework(body) {
  const framework = cleanFramework(body);
  if (!framework.paths.length) throw friendly('Add at least one growth path.');
  if (framework.paths.length > MAX_PATHS) throw friendly(`Keep it to ${MAX_PATHS} paths or fewer.`);
  for (const path of framework.paths) {
    if (!path.name) throw friendly('Give every path a name.');
    if (path.min_days === null || path.min_days < 1) throw friendly(`Give "${path.name}" its length in days.`);
    if (path.max_days < path.min_days) throw friendly(`"${path.name}" ends at fewer days than it starts: check its days.`);
    if (path.max_days > MAX_DAYS) throw friendly(`"${path.name}" is longer than ${MAX_DAYS} days: check its days.`);
  }
  // Shortest first: the order is what ties a path to the need it is for.
  framework.paths.sort((a, b) => a.min_days - b.min_days || a.max_days - b.max_days);
  framework.version = fingerprint(framework);
  upsertSetting.run('training', JSON.stringify(framework));
  return getFramework();
}

export function clearFramework() {
  deleteSetting.run('training');
}

// How a path is picked, for the Training paths page. trainingPlanFor() follows it.
export const PATH_RULES = [
  'A teacher who is Proficient (grade B) or better in every section sat needs no growth path.',
  'One section at grade C or D: the first path.',
  'Two or more sections at grade C or D, but fewer than two at D: the second path.',
  'Two or more sections at grade D: the third path.',
  'With fewer paths than that, the longest one stands in for the missing ones; any after the third are not used.',
];

const READ_INSTRUCTIONS = `You read a document about UpSchool's teacher training, such as a proposal to a school, and pick out the training paths it offers, so that teachers' reports can recommend one of them.

Return:
- programme: the name the document gives the training programme the paths belong to, or "" if it gives none.
- paths: every training path or pathway, from the shortest to the longest. For each: its name as written; what it covers, in one short sentence; and its length in days as min_days and max_days (both the same when one length is given). Count a week as five days.
- exit_assessment: one or two sentences on any assessment after the training, or "".
- continuity: one or two sentences on any support offered after the training, naming the systems or tools it uses, or "".

Leave out prices, fees, payment terms, and the names of people and schools.`;

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['programme', 'paths', 'exit_assessment', 'continuity'],
  properties: {
    programme: { type: 'string' },
    paths: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'scope', 'min_days', 'max_days'],
        properties: {
          name: { type: 'string' },
          scope: { type: 'string' },
          min_days: { type: 'integer' },
          max_days: { type: 'integer' },
        },
      },
    },
    exit_assessment: { type: 'string' },
    continuity: { type: 'string' },
  },
};

// OpenAI reads the paths out of a PDF for the Training page to show. Nothing
// is saved, and the document itself is not kept.
export async function readFramework(buffer, filename) {
  const raw = await requestJson({
    instructions: READ_INSTRUCTIONS,
    content: [
      { type: 'input_text', text: 'The document, as a PDF:' },
      { type: 'input_file', filename: String(filename || 'document.pdf'), file_data: `data:application/pdf;base64,${buffer.toString('base64')}` },
    ],
    name: 'training_paths',
    schema: READ_SCHEMA,
    task: 'read this document',
    retry: 'Try again, or type the paths in.',
  });
  const framework = cleanFramework(raw);
  if (!framework.paths.length) throw friendly('OpenAI found no training paths in that document. Type them in instead.');
  framework.paths.sort((a, b) => (a.min_days ?? 0) - (b.min_days ?? 0));
  return framework;
}

/* -------------------------------------------------- one teacher's plan */

// The days a section that needs support asks for before the plan is fitted
// to its path: more for a section at Beginning than at Developing.
const SECTION_DAYS = { D: 6, C: 4 };
const TARGET = GRADES.find((band) => band.grade === 'B');

// Shares `total` days out in proportion to `weights` (largest remainder), and
// gives every block a day before any block gets a second.
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => (total * w) / sum);
  const parts = shares.map(Math.floor);
  const left = total - parts.reduce((a, b) => a + b, 0);
  const order = shares.map((share, i) => [share - parts[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < left; k += 1) parts[order[k][1]] += 1;
  for (let i = 0; i < parts.length; i += 1) {
    while (parts[i] === 0) {
      const donor = parts.indexOf(Math.max(...parts));
      if (parts[donor] <= 1) break;
      parts[donor] -= 1;
      parts[i] += 1;
    }
  }
  return parts;
}

const about = (s) => `${s.name} (${s.grade_label}, ${s.percent}%)`;
const summarise = ({ key, name, title, grade, grade_label, percent }) => ({ key, name, title, grade, grade_label, percent });

// A teacher's plan from their section results, or null when no paths are set
// up or nothing has been graded. Blocks run in order: the sections that need
// most support first, then classroom application with coaching, then a day
// to review progress before the exit assessment.
export function trainingPlanFor(sections, framework) {
  if (!framework?.paths?.length) return null;
  const graded = sections.filter((s) => s.percent !== null && s.percent !== undefined && s.grade);
  if (!graded.length) return null;

  const focus = graded
    .filter((s) => s.grade in SECTION_DAYS)
    .sort((a, b) => (a.grade !== b.grade ? (a.grade === 'D' ? -1 : 1) : a.percent - b.percent || a.key.localeCompare(b.key)));
  const strengths = graded.filter((s) => !(s.grade in SECTION_DAYS));
  const areas = Object.keys(SECTION_TITLES);
  const sat = graded.filter((s) => areas.includes(s.key)).length;

  const plan = {
    version: framework.version,
    focus: focus.map(summarise),
    strengths: strengths.map(summarise),
    partial: sat && sat < areas.length ? `Based on ${sat} of ${areas.length} sections so far; the plan may change when the others are assessed.` : null,
  };
  if (!focus.length) {
    return {
      ...plan,
      path: null,
      days: 0,
      blocks: [],
      reason: `Proficient or better in every section sat: ${listing(strengths.map(about))}. No growth path is needed.`,
    };
  }

  const beginning = focus.filter((s) => s.grade === 'D').length;
  const tier = focus.length === 1 ? 1 : beginning >= 2 ? 3 : 2;
  const index = Math.min(tier, framework.paths.length) - 1;
  const path = framework.paths[index];
  const wanted = focus.reduce((sum, s) => sum + SECTION_DAYS[s.grade], 0) + focus.length + 1;
  const days = Math.min(path.max_days, Math.max(path.min_days, wanted));

  const review = days >= 3 ? 1 : 0;
  const parts = apportion(days - review, [...focus.map((s) => SECTION_DAYS[s.grade]), focus.length]);
  const blocks = [
    ...focus.map((s, i) => ({
      kind: 'section',
      key: s.key,
      title: s.title ? `${s.name}: ${s.title}` : s.name,
      grade: s.grade,
      grade_label: s.grade_label,
      days: parts[i],
    })),
    { kind: 'practice', key: null, title: 'Classroom Application with Coaching', days: parts[focus.length] },
    { kind: 'review', key: null, title: 'Review and Exit Assessment Readiness', days: review },
  ].filter((block) => block.days > 0);
  let day = 1;
  for (const [i, block] of blocks.entries()) {
    Object.assign(block, { number: i + 1, from: day, to: day + block.days - 1 });
    day += block.days;
  }

  return {
    ...plan,
    path: { ...path },
    path_index: index,
    days,
    blocks,
    reason:
      `${listing(focus.map(about))} ${focus.length === 1 ? 'needs' : 'need'} support` +
      (strengths.length ? `, while ${listing(strengths.map(about))} ${strengths.length === 1 ? 'is already a strength' : 'are already strengths'}.` : '.'),
    target: `${TARGET.label} (${TARGET.min}% or more) or better in ${listing(focus.map((s) => s.name))} at the exit assessment.`,
  };
}

// What OpenAI is told about the plan when it writes a teacher's reports.
export function describeTeacherPlan(plan) {
  if (!plan?.path) return '';
  return [
    '',
    `TRAINING PLAN (fixed): ${plan.path.name}${plan.path.scope ? `, for ${plan.path.scope.replace(/\.$/, '').toLowerCase()}` : ''}. ${plan.days} days in all.`,
    `Why: ${plan.reason}`,
    ...plan.blocks.map((b) => `Block ${b.number}, ${dayRange(b.from, b.to)} (${plural(b.days, 'day')}): ${b.title}${b.grade ? `, grade ${b.grade} ${b.grade_label}` : ''}`),
  ].join('\n');
}

export const TEACHER_PLAN_INSTRUCTIONS = `

3. training_plan, for the management report, from the TRAINING PLAN given after the results. Its path, blocks and days are fixed: never change them.
- blocks: for each block, by its number:
  - focus: three to five specific things to work on in those days. For a section, take them from this teacher's answers and the examiner's feedback, citing question numbers where it helps. For classroom application, what the teacher will practise in their own lessons and what the coach will look for. For the review, how progress is checked before the exit assessment.
  - delivery: how UpSchool's team runs those days, in one or two sentences: for example workshops in school led by UpSchool trainers, demonstration lessons, lessons observed by an UpSchool coach with feedback, or online practice tasks.
  - outcome: what the teacher should be able to do by the end of the block, in one sentence.
- summary: two or three sentences for management on why this path suits the teacher and what it should achieve. Do not repeat the day counts.
- execution: four to six steps for how UpSchool's team would carry out the plan with the school, from agreeing the dates to the exit assessment, each with a short stage name and one or two sentences of detail.
- exit_focus: what the exit assessment should look for in this teacher, in one or two sentences.
- With a training plan, management_report.support lists only support beyond the plan, such as mentoring by a colleague, classroom resources or arrangements the school can make: two to four items.
- Never mention a proposal, a framework document, prices, fees or payments.`;

export const TEACHER_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'blocks', 'execution', 'exit_focus'],
  properties: {
    summary: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['block', 'focus', 'delivery', 'outcome'],
        properties: {
          block: { type: 'integer' },
          focus: { type: 'array', items: { type: 'string' } },
          delivery: { type: 'string' },
          outcome: { type: 'string' },
        },
      },
    },
    execution: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'detail'],
        properties: { stage: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    exit_focus: { type: 'string' },
  },
};

const steps = (list) =>
  (Array.isArray(list) ? list : []).map((step) => ({ stage: text(step?.stage, 120), detail: text(step?.detail) })).filter((step) => step.detail);

// The plan as the report keeps it: the fixed path and days, what OpenAI wrote
// for each block, and the framework's own words on what follows the plan.
export function writtenPlan(plan, written, framework) {
  if (!plan) return null;
  const byNumber = new Map((written?.blocks ?? []).map((block) => [Number(block.block), block]));
  return {
    ...plan,
    programme: framework?.programme ?? '',
    exit_assessment: framework?.exit_assessment ?? '',
    continuity: framework?.continuity ?? '',
    summary: text(written?.summary),
    blocks: plan.blocks.map((block) => {
      const w = byNumber.get(block.number) ?? {};
      return { ...block, focus: strings(w.focus), delivery: text(w.delivery), outcome: text(w.outcome) };
    }),
    execution: steps(written?.execution),
    exit_focus: text(written?.exit_focus),
  };
}

/* ------------------------------------------------ the whole school's plan */

// Every assessed teacher's path and days, the totals per path, and cohorts of
// teachers who need support in the same section, who can be trained together.
export function schoolTraining(teachers, framework) {
  if (!framework?.paths?.length) return null;
  const planned = teachers
    .filter((t) => t.sections.length)
    .map((t) => ({ id: t.id, name: t.name, plan: trainingPlanFor(t.sections, framework) }))
    .filter((t) => t.plan);
  const onPath = planned.filter((t) => t.plan.path);

  const paths = framework.paths
    .map((path, index) => {
      const members = onPath.filter((t) => t.plan.path_index === index);
      return {
        ...path,
        teachers: members.map((t) => ({ id: t.id, name: t.name, days: t.plan.days, focus: t.plan.focus.map((f) => f.name) })),
        teacher_days: members.reduce((sum, t) => sum + t.plan.days, 0),
      };
    })
    .filter((path) => path.teachers.length);

  const keys = [...new Set(onPath.flatMap((t) => t.plan.focus.map((f) => f.key)))].sort();
  const cohorts = keys.map((key) => {
    const members = onPath
      .map((t) => ({ t, focus: t.plan.focus.find((f) => f.key === key), block: t.plan.blocks.find((b) => b.key === key) }))
      .filter((m) => m.focus);
    return {
      key,
      name: members[0].focus.name,
      title: members[0].focus.title ?? '',
      teachers: members.map(({ t, focus, block }) => ({ id: t.id, name: t.name, grade: focus.grade, days: block?.days ?? 0 })),
    };
  });

  const lengths = onPath.map((t) => t.plan.days);
  return {
    version: framework.version,
    programme: framework.programme,
    exit_assessment: framework.exit_assessment,
    continuity: framework.continuity,
    assessed: planned.length,
    on_path: onPath.length,
    teacher_days: lengths.reduce((a, b) => a + b, 0),
    shortest: lengths.length ? Math.min(...lengths) : 0,
    longest: lengths.length ? Math.max(...lengths) : 0,
    paths,
    cohorts,
    none: planned.filter((t) => !t.plan.path).map(({ id, name }) => ({ id, name })),
    by_teacher: Object.fromEntries(planned.map((t) => [t.id, t.plan.path ? { path: t.plan.path.name, days: t.plan.days } : null])),
  };
}

export function describeSchoolTraining(training) {
  if (!training?.paths.length) return '';
  return [
    '',
    'TRAINING PATHS (fixed for each teacher):',
    ...training.paths.map(
      (p) => `- ${p.name}${p.scope ? ` (${p.scope.replace(/\.$/, '')})` : ''}: ${p.teachers.map((t) => `${t.name}, ${plural(t.days, 'day')} on ${listing(t.focus)}`).join('; ')}`
    ),
    training.none.length ? `- No growth path needed: ${training.none.map((t) => t.name).join(', ')}` : null,
    'Teachers who need support in the same section:',
    ...training.cohorts.map(
      (c) => `- ${c.name}${c.title ? ` (${c.title})` : ''}: ${c.teachers.map((t) => `${t.name}, grade ${t.grade}, ${plural(t.days, 'day')}`).join('; ')}`
    ),
    training.exit_assessment ? `Exit assessment: ${training.exit_assessment}` : null,
    training.continuity ? `Support after the training: ${training.continuity}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export const SCHOOL_PLAN_INSTRUCTIONS = `
- training_plan, from the TRAINING PATHS given at the end. Each teacher's path and days are fixed: never change them.
  - summary: two or three sentences on the training the staff needs as a whole.
  - phases: four to six phases of a plan of action for the school, in order. Train teachers who need support in the same section together as a cohort where their plans allow. For each: timing (for example "Weeks 1–2"), a short title, who takes part (named teachers or a cohort), what they work on, and how UpSchool's team delivers it.
  - execution: four to six steps for how UpSchool's team would carry out the plan with the school, from agreeing the timetable to the exit assessments, each with a short stage name and one or two sentences of detail.
  - Never mention a proposal, a framework document, prices, fees or payments.`;

export const SCHOOL_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'phases', 'execution'],
  properties: {
    summary: { type: 'string' },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['timing', 'title', 'who', 'what', 'delivery'],
        properties: {
          timing: { type: 'string' },
          title: { type: 'string' },
          who: { type: 'string' },
          what: { type: 'string' },
          delivery: { type: 'string' },
        },
      },
    },
    execution: TEACHER_PLAN_SCHEMA.properties.execution,
  },
};

export function writtenSchoolPlan(training, written) {
  if (!training) return null;
  return {
    ...training,
    summary: text(written?.summary),
    phases: (Array.isArray(written?.phases) ? written.phases : [])
      .map((p) => ({ timing: text(p?.timing, 60), title: text(p?.title, 120), who: text(p?.who), what: text(p?.what), delivery: text(p?.delivery) }))
      .filter((p) => p.title || p.what),
    execution: steps(written?.execution),
  };
}
