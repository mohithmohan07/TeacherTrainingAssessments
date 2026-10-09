import { h, mount, toast, logoFor, emptyState } from '../ui.js';
import { dashboardApi } from '../api.js';
import { evaluateAllButton, failedReasons } from '../unmarked.js';

// The dashboard: for each school, in its newest test (or another picked on the
// card), what is waiting to be done and how its teachers are doing. Each
// section is graded on its own; there is no overall percentage.
export async function renderDashboard(root) {
  const { totals, schools, grades } = await dashboardApi.get();

  // The same groups as the Waiting rows below; papers being marked and
  // markings that failed only when there are some.
  const stats = [
    { label: 'Schools', value: totals.schools },
    { label: 'Teachers', value: totals.teachers },
    { label: 'Nothing uploaded yet', value: totals.not_started },
    { label: 'Waiting for Evaluate', value: totals.to_evaluate },
    totals.marking ? { label: 'Being marked', value: totals.marking } : null,
    totals.failed ? { label: 'Marking failed', value: totals.failed } : null,
    { label: 'Reports to build', value: totals.reports_to_build },
  ].filter(Boolean);

  mount(
    root,
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Dashboard'), h('p', {}, 'What is waiting at each school, and how its teachers are doing section by section.'))
    ),
    h('div', { class: 'stat-row' }, stats.map((stat) => h('div', { class: 'stat' }, h('div', { class: 'value' }, stat.value), h('div', { class: 'label' }, stat.label)))),
    h('div', { style: 'height:18px' }),
    schools.length
      ? schools.map((summary) => schoolCard(summary, grades))
      : h(
          'div',
          { class: 'card' },
          emptyState(
            'Nothing here yet. Add a school and its teachers, then scan their papers on the Assessments page.',
            h('a', { class: 'btn btn-primary', href: '#/schools', style: 'margin-top:12px' }, 'Add a school')
          )
        )
  );
}

// While papers are being marked, the card checks back every few seconds, so
// they move along as they finish.
function schoolCard(summary, grades) {
  const card = h('div', { class: 'card dash-school' });
  let shown = summary;
  let timer = null;
  // Whether "Why they failed" is open, kept when the card is drawn again.
  const reasons = { open: false };
  const draw = (data) => {
    shown = data;
    mount(card, ...schoolCardContent(data, grades, switchTest, refresh, reasons));
    clearTimeout(timer);
    if (data.waiting?.marking.length) timer = setTimeout(() => card.isConnected && refresh(), 8000);
  };
  const switchTest = async (testId) => {
    try {
      draw(await dashboardApi.school(summary.school.id, testId));
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  const refresh = () => switchTest(shown.test.id);
  draw(summary);
  return card;
}

function schoolCardContent(data, grades, switchTest, refresh, reasons) {
  const { school, test, tests } = data;
  const board = `#/assessments?school=${school.id}&test=${test.id}`;

  const testPicker =
    tests.length > 1
      ? h(
          'select',
          { class: 'dash-test', 'aria-label': 'Test', onchange: (event) => switchTest(event.target.value) },
          tests.map((t) => h('option', { value: t.id, selected: t.id === test.id }, t.name))
        )
      : h('span', { class: 'hint' }, test.name);

  const head = h(
    'div',
    { class: 'dash-head' },
    h(
      'a',
      { class: 'dash-school-name', href: `#/schools/${school.id}` },
      logoFor(school),
      h('div', {}, h('strong', {}, school.name), h('div', { class: 'hint' }, [school.city, school.state].filter(Boolean).join(', ') || `${data.teacher_count} teachers`))
    ),
    h(
      'div',
      { class: 'dash-actions' },
      testPicker,
      h('a', { class: 'btn btn-sm', href: board }, 'Open board'),
      h('a', { class: 'btn btn-sm', href: `#/schools/${school.id}/report/${test.id}` }, 'School report')
    )
  );

  if (!data.teacher_count) {
    return [head, emptyState('No teachers yet. Add them on the school page, one by one or from Excel.', h('a', { class: 'btn btn-sm', href: `#/schools/${school.id}`, style: 'margin-top:10px' }, 'Add teachers'))];
  }

  return [head, h('div', { class: 'grid-2 dash-body' }, waitingPanel(data, board, refresh, reasons), resultsPanel(data, grades))];
}

// Teacher names linking to their profiles, the first few then "and N more".
function names(teachers, moreHref, max = 6) {
  const shown = teachers.slice(0, max);
  const parts = [];
  shown.forEach((t, i) => {
    if (i) parts.push(', ');
    parts.push(h('a', { href: `#/teachers/${t.id}` }, t.name));
  });
  if (teachers.length > max) parts.push(' and ', h('a', { href: moreHref }, `${teachers.length - max} more`));
  return h('div', { class: 'dash-names' }, parts);
}

// The rows of papers waiting for Evaluate and of papers whose marking failed
// each have a button that evaluates all of them at once.
function waitingPanel(data, board, refresh, reasons) {
  const { waiting, test, school } = data;
  const rows = [
    { list: waiting.not_started, label: 'Nothing uploaded yet', tone: 'muted', href: board },
    { list: waiting.to_evaluate, label: 'Scanned, waiting for Evaluate', tone: 'warn', href: board, which: 'waiting' },
    { list: waiting.marking, label: 'Being marked by OpenAI', tone: 'info', href: board },
    { list: waiting.failed, label: 'Marking failed, press Evaluate again', tone: 'danger', href: board, which: 'failed' },
    { list: waiting.reports_to_build, label: 'Marked, report not built or out of date', tone: 'info', href: board },
  ].filter((row) => row.list.length);

  const actions = (which) => {
    const sittings = data.unmarked?.[which] ?? [];
    if (!sittings.length) return null;
    return h(
      'div',
      { class: 'dash-wait-actions' },
      evaluateAllButton({ schoolId: school.id, testId: test.id, which, count: sittings.length, after: refresh }),
      which === 'failed' ? failedReasons(sittings, { open: reasons.open, onToggle: (open) => (reasons.open = open) }) : null
    );
  };

  const report = data.school_report;
  let reportLine;
  if (!data.assessed) reportLine = null;
  else if (!report || report.status === 'none') reportLine = 'The school report has not been built for this test.';
  else if (report.status === 'running') reportLine = 'The school report is being written.';
  else if (report.status === 'failed') reportLine = 'The school report could not be written. Open it to try again.';
  else if (report.old_layout) reportLine = 'The school report was written in the earlier layout. Rebuild it for the simpler one.';
  else if (report.old_words) reportLine = 'The school report was written before reports used plain words. Rebuild it to get them.';
  else if (report.stale) reportLine = 'New marks have come in since the school report was written.';

  return h(
    'div',
    { class: 'dash-panel' },
    h('h3', {}, 'Waiting'),
    rows.length
      ? rows.map((row) =>
          h(
            'div',
            { class: `dash-wait tone-${row.tone}` },
            h('div', { class: 'dash-wait-head' }, h('span', { class: 'dash-count' }, row.list.length), h('span', {}, row.label)),
            names(row.list, row.href),
            row.which ? actions(row.which) : null
          )
        )
      : h('p', { class: 'hint' }, 'Nothing waiting. Every teacher in this test is marked and has a current report.'),
    reportLine
      ? h('p', { class: 'hint dash-report-line' }, reportLine, ' ', h('a', { href: `#/schools/${school.id}/report/${test.id}` }, 'Open the report'))
      : null
  );
}

function resultsPanel(data, grades) {
  const { sections, potential } = data;
  const board = `#/assessments?school=${data.school.id}&test=${data.test.id}`;
  return h(
    'div',
    { class: 'dash-panel' },
    h('h3', {}, 'How teachers are doing'),
    h('p', { class: 'hint' }, `${data.assessed} of ${data.teacher_count} teachers have marked sections in ${data.test.name}.`),
    sections.length
      ? sections.map((s) => sectionRow(s, grades))
      : h('p', { class: 'hint' }, 'No sections have been marked yet.'),
    potential.some((p) => p.teachers.length)
      ? h(
          'div',
          { class: 'dash-potential' },
          h('h4', {}, 'Strengths and Potential'),
          potential
            .filter((p) => p.teachers.length)
            .map((p) =>
              h(
                'details',
                {},
                h('summary', {}, h('span', { class: `potential potential-${p.level}` }, p.headline), h('span', { class: 'dash-count' }, p.teachers.length)),
                names(p.teachers, board, 12)
              )
            )
        )
      : null
  );
}

// Names linking to the teachers' profiles, inline.
const nameLinks = (teachers) => teachers.flatMap((t, i) => [i ? ', ' : '', h('a', { href: `#/teachers/${t.id}` }, t.name)]);

// A section's figures count the papers marked: a teacher of two subjects can
// have two Section B papers. Under them, the papers still to mark and the
// teachers with no answers for the section, so the counts add up to the
// teachers whose answers are in.
function sectionRow(section, grades) {
  const total = section.papers || section.sat || 1;
  const toMark = section.to_mark ?? { papers: 0, teachers: [] };
  const missing = section.no_answers ?? [];
  return h(
    'div',
    { class: 'dash-section' },
    h(
      'div',
      { class: 'dash-section-head' },
      h('strong', {}, section.name),
      h('span', { class: 'hint' }, `${section.sat} marked${section.papers > section.sat ? ` (${section.papers} papers)` : ''} · average ${section.average}%`)
    ),
    section.title ? h('div', { class: 'hint dash-section-title' }, section.title) : null,
    h(
      'div',
      { class: 'grade-bar', role: 'img', 'aria-label': grades.map((g) => `${g.grade}: ${section.counts[g.grade]}`).join(', ') },
      grades
        .filter((g) => section.counts[g.grade])
        .map((g) => h('span', { class: `grade-${g.grade}`, style: `flex:${section.counts[g.grade] / total}`, title: `${g.grade} ${g.label}: ${section.counts[g.grade]}` }, section.counts[g.grade]))
    ),
    h(
      'div',
      { class: 'grade-legend' },
      grades.map((g) => h('span', {}, h('i', { class: `grade-${g.grade}` }), `${g.grade} ${g.label} ${section.counts[g.grade]}`))
    ),
    toMark.papers
      ? h('div', { class: 'dash-section-note' }, 'Still to mark, so not counted yet: ', nameLinks(toMark.teachers), '.')
      : null,
    missing.length ? h('div', { class: 'dash-section-note' }, 'No answers uploaded for this section: ', nameLinks(missing), '.') : null
  );
}
