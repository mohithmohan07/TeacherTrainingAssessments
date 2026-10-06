// The reports written from the marks: a teacher's own report and the
// management report on that teacher (one page, two versions), and the school
// report on all of a school's teachers. Each is short and in plain words, with
// bar charts of the scores; the school report adds a pie chart and splits the
// figures by school stage, Pre-Primary to PUC. Each prints on its own, with
// the school's logo at the top of every page and UpSchool's at the foot. The
// management reports carry a training plan when growth paths are set up, and
// a teacher's reports end with the marks for every question.
import { h, mount, toast, formatDate, logoFor, potentialBadge, emptyState, titleCase, upschoolLogo, printFrame } from '../ui.js';
import { reportsApi } from '../api.js';
import { donut, legend, scoreBar, stackedBar } from '../charts.js';

const SECTION_KEYS = ['A', 'B', 'C'];

// The layout the server writes reports in (LAYOUT in server/reports.js). A
// report in an earlier layout is not shown; the page asks for a rebuild.
const LAYOUT = 2;
const writtenContent = (report) => (report?.content?.layout === LAYOUT ? report.content : null);

// Checks back every few seconds while OpenAI is writing, then redraws.
function pollWhileRunning(container, load, isRunning, onDone) {
  (async () => {
    while (container.isConnected) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (!container.isConnected) return;
      let data;
      try {
        data = await load();
      } catch {
        continue;
      }
      if (!isRunning(data)) {
        onDone(data);
        return;
      }
    }
  })();
}

function reportState(report, { building, what }) {
  if (!report) return null;
  if (report.status === 'running') {
    return h('div', { class: 'marking-state no-print' }, h('span', { class: 'spinner' }), `OpenAI is writing ${what}. This usually takes under a minute; you can leave this page and come back.`);
  }
  if (report.status === 'failed') {
    return h('div', { class: 'marking-state error no-print' }, report.error || 'The report could not be written.', ' ', building);
  }
  if (report.old_layout) {
    return h('div', { class: 'notice no-print' }, 'This report was written in the earlier, longer layout. Rebuild it to get the simpler one. ', building);
  }
  if (report.stale) {
    return h('div', { class: 'notice no-print' }, 'Marks have changed or new sections have been evaluated since this report was written. Rebuild it to take them in. ', building);
  }
  return null;
}

const bullets = (items) => (items?.length ? h('ul', {}, items.map((item) => h('li', {}, item))) : null);
const numbered = (items, render) => (items?.length ? h('ol', { class: 'report-points' }, items.map((item) => h('li', {}, render(item)))) : null);
// "Checking Understanding. In Section A…"
const point = (p) => [p.title ? h('strong', {}, `${titleCase(p.title.replace(/[.:]$/, ''))}. `) : null, p.detail ?? ''];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listing = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const marks = (n) => String(Math.round(Number(n) * 100) / 100);
const share = (n, total) => (total ? Math.round((100 * n) / total) : 0);
const gradeChip = (s) => (s.grade ? h('span', { class: `grade-chip grade-${s.grade}` }, `${s.grade} · ${s.grade_label}`) : '—');

// "Lenient marking: questions not attempted are left out of the marks and
// the total. Left out: Section B, 2 questions worth 5 marks." Only when a
// section was marked leniently.
function lenientKey(sections, { forTeacher = false } = {}) {
  const lenient = sections.filter((s) => s.marking === 'lenient');
  if (!lenient.length) return null;
  const which = lenient.filter((s) => s.left_out).map((s) => `${titleCase(s.name)}, ${plural(s.left_out, 'question')} worth ${marks(s.left_out_marks)} marks`);
  return h(
    'p',
    { class: 'report-note' },
    h('strong', {}, 'Lenient marking: '),
    forTeacher ? 'questions you did not attempt are left out of your marks and the total' : 'questions not attempted are left out of the marks and the total',
    lenient.length < sections.length ? ` in ${listing(lenient.map((s) => titleCase(s.name)))}.` : '.',
    which.length ? ` Left out: ${which.join('; ')}.` : ' Every question was attempted, so nothing is left out.'
  );
}

// Each section's result as a bar on the grade bands. Sections of the
// programme the teacher has not taken yet are listed too.
function resultsTable(sections, { grades, section_titles: titles = {} }, { forTeacher = false } = {}) {
  const sectioned = sections.length > 0 && sections.every((s) => SECTION_KEYS.includes(s.key));
  const notTaken = sectioned ? SECTION_KEYS.filter((key) => !sections.some((s) => s.key === key)) : [];
  return [h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'report-table results-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part of the Test'), h('th', { class: 'right' }, 'Marks'), h('th', { class: 'score-col' }, 'Score'), h('th', {}, 'Grade'))),
      h(
        'tbody',
        {},
        sections.map((s) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', {}, titleCase(s.name)), s.title ? h('div', { class: 'hint' }, s.title) : null, s.date ? h('div', { class: 'hint' }, `Taken ${formatDate(s.date)}`) : null),
            h('td', { class: 'right nowrap' }, `${marks(s.awarded)} / ${marks(s.max)}`, s.marking === 'lenient' ? h('div', { class: 'hint' }, 'Lenient') : null),
            h('td', { class: 'score-col' }, scoreBar(s.percent, grades, { label: s.name })),
            h('td', {}, gradeChip(s))
          )
        ),
        notTaken.map((key) =>
          h(
            'tr',
            { class: 'not-taken' },
            h('td', {}, h('strong', {}, `Section ${key}`), titles[key] ? h('div', { class: 'hint' }, titles[key]) : null),
            h('td', { class: 'hint', colspan: 3 }, 'Not taken yet')
          )
        )
      )
    )
  ), lenientKey(sections, { forTeacher })];
}

// One printed report: the school's letterhead (at the top of every printed
// page), the report's title and details, its body, and UpSchool's footer (at
// the foot of every printed page).
function reportSheet({ school, audience, title, details }, ...body) {
  return h(
    'article',
    { class: 'report-sheet' },
    printFrame(
      h(
        'header',
        { class: 'report-letterhead' },
        logoFor(school),
        h('div', {}, h('div', { class: 'report-programme' }, 'Teacher Training Assessment'), h('div', { class: 'report-school-name' }, school.name))
      ),
      h(
        'div',
        { class: 'report-title-block' },
        audience ? h('p', { class: 'report-audience' }, audience) : null,
        h('h1', { class: 'report-title' }, title),
        detailsList(details)
      ),
      body
    ),
    h('footer', { class: 'report-footer' }, h('span', {}, 'Report generated by'), upschoolLogo())
  );
}

// Who and what the report is about, in a row under its title.
function detailsList(pairs) {
  const shown = pairs.filter(([, value]) => value);
  return shown.length ? h('dl', { class: 'report-details' }, shown.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))) : null;
}

const teacherDetails = (teacher, test, report) => [
  ['Teacher', teacher.name],
  ['Teaches', [teacher.grade, teacher.subjects].filter(Boolean).join(' · ')],
  ['Test', test.name],
  ['Report Date', formatDate(report?.written_at)],
];

// "A Exemplary, 85% and above · B Proficient, 70–84% · …"
function gradeKey(grades) {
  const bands = [...grades].sort((a, b) => b.min - a.min);
  const range = (g, i) => (i === 0 ? `${g.min}% and above` : g.min === 0 ? `below ${bands[i - 1].min}%` : `${g.min}–${bands[i - 1].min - 1}%`);
  return h(
    'p',
    { class: 'report-key' },
    h('strong', {}, 'Grades: '),
    bands.map((g, i) => `${g.grade} ${g.label}, ${range(g, i)}`).join(' · '),
    '. Each section is graded on its own; there is no overall percentage.'
  );
}

/* ---------------------------------------------------- marks for every question */

// The questions behind each section: from the report when it kept them, so a
// printed report shows the marks it was written from, otherwise as marked now.
function withQuestions(sections, live) {
  return sections.map((s) => (s.questions ? s : { ...s, questions: live.find((l) => l.key === s.key)?.questions ?? [] }));
}

const isBlank = (q) => q.blank ?? (!String(q.teacher_answer ?? '').trim() && !(Number(q.marks_awarded) > 0));
// Lenient marking leaves the questions not attempted out of the totals.
const notCounted = (q) => q.counted === false;
const markTone = (q) => (notCounted(q) ? 'q-skip' : q.max_marks > 0 && q.marks_awarded >= q.max_marks ? 'q-full' : q.marks_awarded > 0 ? 'q-part' : 'q-none');
const questionLabel = (q) => q.question || '—';

// The marks for every question as one grid, a row per question and a column
// per section, when the sections share their numbering as the programme's
// papers do; otherwise a small table per section, side by side.
function marksGrid(sections) {
  const shown = sections.filter((s) => s.questions?.length);
  if (!shown.length) return null;
  const labels = [...new Set(shown.flatMap((s) => s.questions.map(questionLabel)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const shared = labels.filter((l) => shown.filter((s) => s.questions.some((q) => questionLabel(q) === l)).length > 1);
  const unique = shown.every((s) => new Set(s.questions.map(questionLabel)).size === s.questions.length);
  const cell = (q) =>
    q
      ? [h('span', { class: `q-marks ${markTone(q)}` }, `${marks(q.marks_awarded)} / ${marks(q.max_marks)}`), isBlank(q) ? h('span', { class: 'q-blank' }, notCounted(q) ? 'not counted' : 'blank') : null]
      : h('span', { class: 'hint' }, '—');
  const total = (s) => h('strong', {}, `${marks(s.awarded)} / ${marks(s.max)}`);

  if (unique && (shown.length === 1 || shared.length * 2 >= labels.length)) {
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table marks-grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Question'), shown.map((s) => h('th', {}, titleCase(s.name))))),
        h(
          'tbody',
          {},
          labels.map((l) => h('tr', {}, h('td', {}, h('strong', {}, l)), shown.map((s) => h('td', {}, cell(s.questions.find((q) => questionLabel(q) === l)))))),
          h('tr', { class: 'total-row' }, h('td', {}, h('strong', {}, 'Total')), shown.map((s) => h('td', {}, total(s))))
        )
      )
    );
  }
  return h(
    'div',
    { class: 'marks-grids' },
    shown.map((s) =>
      h(
        'table',
        { class: 'report-table marks-grid' },
        h('thead', {}, h('tr', {}, h('th', {}, titleCase(s.name)), h('th', {}, 'Marks'))),
        h(
          'tbody',
          {},
          s.questions.map((q) => h('tr', {}, h('td', {}, h('strong', {}, questionLabel(q))), h('td', {}, cell(q)))),
          h('tr', { class: 'total-row' }, h('td', {}, h('strong', {}, 'Total')), h('td', {}, total(s)))
        )
      )
    )
  );
}

function marksSection(sections, { forTeacher }) {
  const grid = marksGrid(sections);
  if (!grid) return null;
  const all = sections.flatMap((s) => s.questions ?? []);
  const blanks = all.filter((q) => isBlank(q) && !notCounted(q));
  const skipped = all.filter(notCounted);
  const worth = (list) => marks(list.reduce((sum, q) => sum + (Number(q.max_marks) || 0), 0));
  return h(
    'section',
    { class: 'report-marks' },
    h('h2', {}, 'Marks for Every Question'),
    h(
      'p',
      { class: 'report-note' },
      h('span', { class: 'q-marks q-full' }, 'Full marks'),
      ' ',
      h('span', { class: 'q-marks q-part' }, 'Some marks'),
      ' ',
      h('span', { class: 'q-marks q-none' }, 'No marks'),
      skipped.length ? [' ', h('span', { class: 'q-marks q-skip' }, 'Not counted')] : null,
      blanks.length
        ? ` ${forTeacher ? `You left ${plural(blanks.length, 'question')}` : `${plural(blanks.length, 'question')} ${blanks.length === 1 ? 'was' : 'were'} left`} blank, worth ${worth(blanks)} marks.`
        : '',
      skipped.length
        ? ` ${plural(skipped.length, 'question')} ${forTeacher ? 'you did not attempt' : 'not attempted'}, worth ${worth(skipped)} marks, ${skipped.length === 1 ? 'is' : 'are'} not counted (lenient marking).`
        : ''
    ),
    grid
  );
}

/* ------------------------------------------------------------- training */

const dayRange = (b) => (b.from === b.to ? `Day ${b.from}` : `Days ${b.from}–${b.to}`);
const dayNumbers = (b) => (b.from === b.to ? `${b.from}` : `${b.from}–${b.to}`);
// "Days 1–9 and 18–20", for the blocks that work on one finding.
const daysOf = (blocks) => (!blocks.length ? '' : blocks.length === 1 ? dayRange(blocks[0]) : `Days ${listing(blocks.map(dayNumbers))}`);
// Each section keeps its colour across the plan; the shared blocks have their own.
const toneOf = (b) => (b.kind === 'section' ? `tone-${b.key || 'paper'}` : `tone-${b.kind}`);
const shortTitle = (b) => (b.kind === 'section' ? b.title.split(':')[0] : b.title);

// What the report says about training when the growth paths are missing or
// have changed since it was written. Screen only.
function trainingNotice(state, written, rebuild) {
  if (!state.set) {
    return h('div', { class: 'notice no-print' }, 'To recommend training in this report, add UpSchool’s growth paths on the ', h('a', { href: '#/training' }, 'Training paths'), ' page, then rebuild it.');
  }
  if (!written) return null;
  if (!written.training) return h('div', { class: 'notice no-print' }, 'This report was written before the growth paths were added, so it has no training plan. ', rebuild);
  if (written.training.version !== state.version) return h('div', { class: 'notice no-print' }, 'The growth paths have changed since this report was written. Rebuild it to bring the training plan up to date. ', rebuild);
  return null;
}

// The training the plan recommends, in one line under the summary.
function trainingLine(plan) {
  if (!plan) return null;
  return h(
    'p',
    { class: 'report-callout' },
    h('strong', {}, 'Recommended Training: '),
    plan.path ? `${plan.path.name}, ${plural(plan.days, 'day')}.` : 'None needed. Grade B or better in every section taken.',
    plan.partial ? h('span', { class: 'hint' }, ` ${plan.partial}`) : null
  );
}

function dayStrip(plan) {
  return h(
    'div',
    { class: 'day-strip-wrap' },
    h(
      'div',
      { class: 'day-strip', style: `grid-template-columns: repeat(${plan.days}, minmax(0, 1fr))` },
      plan.blocks.flatMap((b) => Array.from({ length: b.days }, (_, i) => h('span', { class: `day ${toneOf(b)}`, title: b.title }, b.from + i)))
    ),
    h('div', { class: 'day-legend' }, plan.blocks.map((b) => h('span', {}, h('i', { class: toneOf(b) }), h('strong', {}, dayRange(b)), ` ${shortTitle(b)}`)))
  );
}

// The plan of action for one teacher: the days, what is worked on in them,
// how UpSchool's team runs them, and the findings they answer.
function planSection(plan) {
  if (!plan?.path) return null;
  return h(
    'section',
    { class: 'report-plan' },
    h('h2', {}, `${plan.days}-Day Training Plan`, h('small', {}, plan.programme ? `${plan.path.name} · ${plan.programme}` : plan.path.name)),
    plan.order ? h('p', {}, plan.order) : null,
    dayStrip(plan),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table plan-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Days'), h('th', {}, 'What the Teacher Works On'), h('th', {}, 'How We Do It'), h('th', { class: 'right' }, 'Point'))),
        h(
          'tbody',
          {},
          plan.blocks.map((b) =>
            h(
              'tr',
              {},
              h('td', { class: 'nowrap' }, h('span', { class: `plan-block-days ${toneOf(b)}` }, dayNumbers(b))),
              h('td', {}, h('strong', {}, shortTitle(b)), b.works_on ? h('div', {}, b.works_on) : null),
              h('td', {}, b.how || '—'),
              h('td', { class: 'right' }, b.points?.length ? b.points.join(', ') : '—')
            )
          )
        )
      )
    ),
    plan.partial ? h('p', { class: 'report-note' }, plan.partial) : null,
    plan.exit_assessment ? h('p', { class: 'report-note' }, h('strong', {}, 'Final Test: '), plan.exit_assessment) : null,
    plan.continuity ? h('p', { class: 'report-note' }, h('strong', {}, 'After the Plan: '), plan.continuity) : null
  );
}

/* ------------------------------------------------------ one teacher's reports */

export async function renderTeacherReport(root, teacherId, testId, query = new URLSearchParams()) {
  let data = await reportsApi.teacher(teacherId, testId);
  let audience = query.get('for') === 'management' ? 'management' : 'teacher';
  const container = h('div', {});

  const build = async () => {
    try {
      data = await reportsApi.buildTeacher(teacherId, testId);
      draw();
      watch();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const watch = () => {
    if (data.report?.status !== 'running') return;
    pollWhileRunning(container, () => reportsApi.teacher(teacherId, testId), (d) => d.report?.status === 'running', (d) => {
      data = d;
      draw();
      toast(d.report.status === 'done' ? 'Report written.' : 'The report could not be written.', d.report.status === 'done' ? 'success' : 'error');
    });
  };

  function draw() {
    const { teacher, school, test, report } = data;
    const content = writtenContent(report);
    const running = report?.status === 'running';
    const buildButton = h(
      'button',
      { class: `btn ${content ? '' : 'btn-primary'}`, type: 'button', disabled: running || !data.sections.length, onclick: build },
      running ? 'Writing…' : report?.content ? 'Rebuild report' : 'Build report'
    );
    const inlineBuild = h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report');

    const toggle = h(
      'div',
      { class: 'segmented' },
      [['teacher', 'For the Teacher'], ['management', 'For Management']].map(([value, label]) =>
        h('button', {
          type: 'button',
          class: audience === value ? 'active' : null,
          onclick: () => {
            audience = value;
            draw();
          },
        }, label)
      )
    );

    let sheet;
    if (!data.sections.length) {
      sheet = emptyState('No sections have been evaluated for this teacher in this test yet. Scan their papers and press Evaluate on the Assessments page.');
    } else if (!content) {
      sheet = reportSheet(
        { school, audience: audience === 'teacher' ? 'For the Teacher' : 'For Management', title: 'Results So Far', details: teacherDetails(teacher, test, null) },
        resultsTable(data.sections, data),
        running || report?.content ? null : h('p', { class: 'hint no-print' }, 'The written report has not been built yet. Press Build report.'),
        marksSection(data.sections, { forTeacher: audience === 'teacher' }),
        gradeKey(data.grades)
      );
    } else {
      sheet = audience === 'teacher' ? teacherSheet(data, content) : managementSheet(data, content);
    }

    mount(
      container,
      h(
        'div',
        { class: 'breadcrumb no-print' },
        h('a', { href: `#/assessments?school=${teacher.school_id}&test=${test.id}` }, '← Assessments'),
        ' · ',
        h('a', { href: `#/teachers/${teacher.id}` }, `${teacher.name}’s profile`)
      ),
      h(
        'div',
        { class: 'page-head no-print' },
        h('div', {}, h('h1', {}, `${teacher.name}: Reports`), h('p', {}, `${test.name}${report?.written_at ? ` · written ${formatDate(report.written_at)}` : ''}`)),
        h('div', { class: 'page-actions' }, toggle, buildButton, h('button', { class: 'btn btn-primary', onclick: () => window.print(), disabled: !data.sections.length }, 'Print'))
      ),
      reportState(report, { building: inlineBuild, what: `${teacher.name}’s reports` }),
      audience === 'management' && !running ? trainingNotice(data.training, content, h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report')) : null,
      sheet
    );
  }

  draw();
  mount(root, container);
  watch();
}

function teacherSheet(data, content) {
  const { teacher, school, test, report } = data;
  const t = content.teacher;
  return reportSheet(
    { school, audience: 'For the Teacher', title: 'Teacher Report', details: teacherDetails(teacher, test, report) },
    h('h2', {}, 'Summary'),
    t.summary ? h('p', { class: 'report-lead' }, t.summary) : null,
    resultsTable(content.sections, data, { forTeacher: true }),
    t.went_well.length ? [h('h2', {}, 'What Went Well'), numbered(t.went_well, point)] : null,
    t.next_steps.length ? [h('h2', {}, 'Your Next Steps'), numbered(t.next_steps, point)] : null,
    t.practice_ideas.length ? [h('h2', {}, 'Ideas to Practise'), bullets(t.practice_ideas)] : null,
    marksSection(withQuestions(content.sections, data.sections), { forTeacher: true }),
    gradeKey(data.grades)
  );
}

// The potential identifier, in a short box under the results.
function potentialBox(potential, aiRoles) {
  if (!potential) return null;
  // OpenAI's roles cite the answers; the rule-based ones are a fallback.
  const roles = aiRoles?.length ? aiRoles.map((r) => r.role) : potential.roles.map((r) => r.role.replace(/^\p{Ll}/u, (c) => c.toUpperCase()));
  return h(
    'div',
    { class: 'potential-box' },
    h('div', { class: 'potential-head' }, h('h3', {}, 'Potential Identifier'), potentialBadge(potential)),
    h('p', {}, potential.meaning, ' ', h('span', { class: 'hint' }, potential.evidence)),
    roles.length ? h('p', { class: 'potential-areas' }, h('strong', {}, 'Could Take On: '), roles.map((r) => r.replace(/\.$/, '')).join('; '), '.') : null
  );
}

// What will be done: the plan's blocks of days when there is a plan,
// otherwise the support recommended.
function whatWeWillDo(plan, m) {
  if (plan?.path) {
    return [h('h3', {}, 'What We Will Do'), numbered(plan.blocks, (b) => [h('strong', {}, `${dayRange(b)}: `), b.summary || b.title])];
  }
  return m.support.length ? [h('h3', {}, 'What We Recommend'), bullets(m.support)] : null;
}

// Each finding in full, numbered as on the first page, with the days of the
// plan that work on it.
function findingDetails(findings, plan) {
  if (!findings.length) return null;
  return h(
    'section',
    { class: 'report-findings' },
    h('h2', {}, 'Details'),
    h('p', { class: 'report-note' }, 'Each finding keeps its number from the summary.'),
    findings.map((f, i) => {
      const days = plan?.path ? daysOf(plan.blocks.filter((b) => b.points?.includes(i + 1))) : '';
      return h(
        'div',
        { class: 'finding' },
        h('h3', {}, `${i + 1}. ${titleCase(f.title)}`),
        f.details.length
          ? [h('p', { class: 'finding-label' }, h('strong', {}, 'What We Found:')), bullets(f.details)]
          : f.summary
            ? h('p', {}, h('strong', {}, 'What We Found: '), f.summary)
            : null,
        f.why_it_matters ? h('p', {}, h('strong', {}, 'Why It Matters: '), f.why_it_matters) : null,
        f.action ? h('p', {}, h('strong', {}, `What We Will Do${days ? ` (${days})` : ''}: `), f.action) : null
      );
    })
  );
}

function managementSheet(data, content) {
  const { teacher, school, test, report } = data;
  const m = content.management;
  const plan = content.training;
  return reportSheet(
    { school, audience: 'For Management', title: 'Teacher Report', details: teacherDetails(teacher, test, report) },
    h('h2', {}, 'Summary'),
    m.summary ? h('p', { class: 'report-lead' }, m.summary) : null,
    trainingLine(plan),
    resultsTable(content.sections, data),
    potentialBox(content.potential, m.roles),
    m.findings.length ? [h('h3', {}, 'What We Found'), numbered(m.findings, (f) => point({ title: f.title, detail: f.summary }))] : null,
    whatWeWillDo(plan, m),
    m.school_needs.length ? [h('h3', {}, 'What We Need from the School'), bullets(m.school_needs)] : null,
    plan?.goal ? h('p', { class: 'report-callout' }, h('strong', {}, 'Goal for the Final Test: '), plan.goal) : null,
    findingDetails(m.findings, plan),
    planSection(plan),
    marksSection(withQuestions(content.sections, data.sections), { forTeacher: false }),
    gradeKey(data.grades)
  );
}

/* ------------------------------------------------------------ the school report */

// The pie: how many teachers are on track, developing or need support.
function glance(figures, needs) {
  const whole = figures.whole;
  if (!whole?.teachers) return null;
  const slices = needs.map((n) => ({ key: n.key, label: n.label, value: whole.needs[n.key] ?? 0 }));
  return h(
    'div',
    { class: 'chart-block' },
    h('h3', {}, 'Teachers at a Glance'),
    h(
      'div',
      { class: 'glance' },
      donut(slices, { size: 132, total: whole.teachers, caption: whole.teachers === 1 ? 'teacher' : 'teachers' }),
      h(
        'table',
        { class: 'glance-table' },
        h(
          'tbody',
          {},
          needs.map((n) =>
            h(
              'tr',
              {},
              h('td', {}, h('i', { class: `swatch fill-${n.key}` })),
              h('td', {}, h('strong', {}, n.label), h('div', { class: 'hint' }, n.meaning)),
              h('td', { class: 'right glance-count' }, whole.needs[n.key] ?? 0),
              h('td', { class: 'right hint nowrap' }, `${share(whole.needs[n.key] ?? 0, whole.teachers)}%`)
            )
          )
        )
      )
    )
  );
}

const sectionHead = (key) => (key ? `Section ${key}` : 'Paper');

// Bar charts of each stage's average in every section, Pre-Primary to PUC,
// with the whole school below.
function stageTable(figures, keys, grades) {
  if (!figures.stage_stats?.length) return null;
  const row = (s, whole = false) =>
    h(
      'tr',
      { class: whole ? 'total-row' : null },
      h('td', {}, h('strong', {}, s.name), s.classes ? h('div', { class: 'hint' }, s.classes) : null),
      h('td', { class: 'right' }, s.teachers),
      keys.map((key) => h('td', { class: 'score-col' }, scoreBar(s.averages[key], grades, { label: `${s.name}, ${sectionHead(key)}` }))),
      h('td', { class: 'right nowrap' }, `${s.needs.support} of ${s.teachers}`)
    );
  return h(
    'div',
    { class: 'chart-block' },
    h('h3', {}, 'Average Score by Stage'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table stage-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', { class: 'right' }, 'Teachers'), keys.map((key) => h('th', { class: 'score-col' }, sectionHead(key))), h('th', { class: 'right' }, 'Need Support'))),
        h('tbody', {}, figures.stage_stats.map((s) => row(s)), row({ name: 'Whole School', classes: '', ...figures.whole }, true))
      )
    ),
    h('p', { class: 'report-key' }, 'Each bar is the average score of the stage’s teachers who took that section; the tints behind it are the grade bands, D to A. Need Support counts teachers with a section at Grade D.'),
    figures.stage_stats.some((s) => s.key === null)
      ? h('p', { class: 'report-note no-print' }, 'Teachers under “Stage Not Given” have no class saved. Add the classes they teach on Schools & teachers, then rebuild, to place them in a stage.')
      : null
  );
}

// A stacked bar per section: how many teachers got each grade.
function sectionGrades(figures, grades) {
  const stats = figures.section_stats.filter((s) => s.sat);
  if (!stats.length) return null;
  const bands = [...grades].sort((a, b) => b.min - a.min);
  return h(
    'div',
    { class: 'chart-block' },
    h('h3', {}, 'Grades in Each Section'),
    h(
      'div',
      { class: 'grade-rows' },
      stats.map((s) =>
        h(
          'div',
          { class: 'grade-row' },
          h('div', { class: 'grade-row-name' }, h('strong', {}, titleCase(s.name)), h('div', { class: 'hint' }, `${s.sat} took it · average ${s.average}%`)),
          stackedBar(bands.map((g) => ({ key: g.grade, label: `Grade ${g.grade}, ${g.label}`, value: s.counts[g.grade] ?? 0 })), { label: s.name })
        )
      )
    ),
    legend(bands.map((g) => ({ key: g.grade, label: `${g.grade} ${g.label}` })))
  );
}

// "Section A: Interpersonal & Instructional Communication Skills · …"
function sectionTitles(stats) {
  const titled = stats.filter((s) => s.title);
  return titled.length ? h('p', { class: 'report-key' }, titled.map((s, i) => [i ? ' · ' : '', h('strong', {}, `${titleCase(s.name)}: `), s.title])) : null;
}

const dayCount = (p) => (p.days_min === p.days_max ? plural(p.days_min, 'day') : `${p.days_min} to ${p.days_max} days`);

// The school's training in a line: how many teachers are on each growth
// path, the days in all, and how many need none. Each teacher's own plan is
// in their management report.
function trainingTotal(training) {
  if (!training) return null;
  if (!training.paths.length) {
    return h('p', { class: 'report-callout' }, h('strong', {}, 'Training: '), 'every teacher assessed so far is at Grade B or better in each section taken, so no growth path is needed.');
  }
  const paths = training.paths.map((p, i) => `${i ? p.teachers.length : plural(p.teachers.length, 'teacher')} on ${p.name} (${dayCount(p)} each)`);
  return h(
    'p',
    { class: 'report-callout' },
    h('strong', {}, 'In Total: '),
    `${listing(paths)}: ${plural(training.teacher_days, 'training day')} in all.`,
    training.none.length ? ` ${training.none.length === 1 ? 'One teacher needs' : `${training.none.length} teachers need`} no growth path.` : ''
  );
}

// The teachers whose sections were marked leniently, so their percentages
// cover only the questions they attempted.
function lenientTeachers(figures) {
  const lenient = figures.teachers
    .map((t) => ({ t, keys: t.sections.filter((s) => s.marking === 'lenient').map((s) => s.key || 'paper') }))
    .filter(({ keys }) => keys.length);
  if (!lenient.length) return null;
  return h(
    'p',
    { class: 'report-note' },
    h('strong', {}, 'Lenient marking: '),
    'questions not attempted are left out of the marks and the total for ',
    lenient.map(({ t, keys }, i) => [i ? ', ' : '', t.name, h('span', { class: 'hint' }, ` (${keys.join(', ')})`)]),
    '.'
  );
}

// Who is on track, developing or in need of support in each stage, with the
// sections that put them there.
function teachersByStage(figures, needs, test) {
  const assessed = figures.teachers.filter((t) => t.sections.length);
  if (!assessed.length || !figures.stage_stats?.length) return null;
  const columns = [...needs].reverse();
  const gradeFor = { developing: 'C', support: 'D' };
  const who = (t, need) => {
    const keys = gradeFor[need] ? t.sections.filter((s) => s.grade === gradeFor[need]).map((s) => s.key || 'paper') : [];
    return [h('a', { href: `#/teachers/${t.id}/report/${test.id}?for=management` }, t.name), keys.length ? h('span', { class: 'hint' }, ` (${keys.join(', ')})`) : null];
  };
  return h(
    'section',
    { class: 'report-teachers' },
    h('h2', {}, 'Teachers by Stage'),
    h('p', { class: 'report-note' }, 'The letters in brackets are the sections at Grade D for Needs Support, and at Grade C for Developing. Each name has its own report.'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table needs-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), columns.map((n) => h('th', {}, h('i', { class: `swatch fill-${n.key}` }), ` ${n.label}`)))),
        h(
          'tbody',
          {},
          figures.stage_stats.map((stage) => {
            const members = assessed.filter((t) => (t.stage ?? null) === stage.key);
            return h(
              'tr',
              {},
              h('td', {}, h('strong', {}, stage.name), stage.classes ? h('div', { class: 'hint' }, stage.classes) : null),
              columns.map((n) => {
                const list = members.filter((t) => t.need === n.key);
                return h('td', {}, list.length ? list.map((t, i) => [i ? ', ' : '', who(t, n.key)]) : h('span', { class: 'hint' }, '—'));
              })
            );
          })
        )
      )
    )
  );
}

export async function renderSchoolReport(root, schoolId, testId) {
  let data = await reportsApi.school(schoolId, testId);
  const container = h('div', {});

  const build = async () => {
    try {
      data = await reportsApi.buildSchool(schoolId, testId);
      draw();
      watch();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const watch = () => {
    if (data.report?.status !== 'running') return;
    pollWhileRunning(container, () => reportsApi.school(schoolId, testId), (d) => d.report?.status === 'running', (d) => {
      data = d;
      draw();
      toast(d.report.status === 'done' ? 'Report written.' : 'The report could not be written.', d.report.status === 'done' ? 'success' : 'error');
    });
  };

  function draw() {
    const { school, test, report } = data;
    const written = writtenContent(report);
    // Figures come from the report once it is written, so they match its text.
    const figures = written ?? data;
    const running = report?.status === 'running';

    const buildButton = h(
      'button',
      { class: `btn ${written ? '' : 'btn-primary'}`, type: 'button', disabled: running || !data.assessed, onclick: build },
      running ? 'Writing…' : report?.content ? 'Rebuild report' : 'Build report'
    );
    const keys = figures.section_stats.map((s) => s.key);

    const sheet = reportSheet(
      {
        school,
        audience: 'For Management',
        title: 'School Report',
        details: [
          ['Test', test.name],
          ['Teachers Assessed', `${figures.assessed} of ${figures.teachers.length}`],
          ['Report Date', written ? formatDate(report.written_at) : null],
        ],
      },
      h('h2', {}, 'Summary'),
      written?.summary ? h('p', { class: 'report-lead' }, written.summary) : null,
      glance(figures, data.needs),
      stageTable(figures, keys, data.grades),
      sectionGrades(figures, data.grades),
      sectionTitles(figures.section_stats),
      written?.findings.length ? [h('h3', {}, 'What We Found'), numbered(written.findings, point)] : null,
      written?.actions.length ? [h('h3', {}, 'What We Will Do'), numbered(written.actions, (a) => [a.timing ? h('strong', {}, `${a.timing}: `) : null, a.action])] : null,
      trainingTotal(figures.training),
      written?.school_needs.length ? [h('h3', {}, 'What We Need from the School'), bullets(written.school_needs)] : null,
      !written && !running ? h('p', { class: 'hint no-print' }, 'The charts and figures are live. Press Build report to add the summary, findings and plan of action.') : null,
      teachersByStage(figures, data.needs, test),
      lenientTeachers(figures),
      figures.not_assessed.length ? h('p', { class: 'report-note' }, `Not yet assessed in this test: ${figures.not_assessed.join(', ')}.`) : null,
      gradeKey(data.grades)
    );

    mount(
      container,
      h('div', { class: 'breadcrumb no-print' }, h('a', { href: `#/assessments?school=${school.id}&test=${test.id}` }, '← Assessments')),
      h(
        'div',
        { class: 'page-head no-print' },
        h('div', {}, h('h1', {}, `${school.name}: School Report`), h('p', {}, `${test.name}. Figures are per section; teachers are only compared within a section they took.`)),
        h('div', { class: 'page-actions' }, buildButton, h('button', { class: 'btn btn-primary', onclick: () => window.print() }, 'Print'))
      ),
      reportState(report, { building: h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report'), what: 'the school report' }),
      data.assessed && !running ? trainingNotice(data.training_state, written, h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report')) : null,
      data.assessed ? sheet : emptyState('No teacher has been evaluated in this test yet.')
    );
  }

  draw();
  mount(root, container);
  watch();
}
