// The reports written from the marks: a teacher's own report and the
// management report on that teacher (one page, two versions), and the
// management report on all of a school's teachers. Each prints on its own.
import { h, mount, toast, formatDate, logoFor, percentChip, potentialBadge, emptyState } from '../ui.js';
import { reportsApi } from '../api.js';

const SECTION_KEYS = ['A', 'B', 'C'];

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
  if (report.stale) {
    return h('div', { class: 'notice no-print' }, 'Marks have changed or new sections have been evaluated since this report was written. Rebuild it to take them in. ', building);
  }
  return null;
}

function resultsTable(sections) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'report-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Section'), h('th', {}, 'Date sat'), h('th', { class: 'right' }, 'Marks'), h('th', { class: 'right' }, 'Percentage'), h('th', {}, 'Grade'))),
      h(
        'tbody',
        {},
        sections.map((s) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', {}, s.name), s.title ? h('div', { class: 'hint' }, s.title) : null),
            h('td', {}, formatDate(s.date) || '—'),
            h('td', { class: 'right' }, `${s.awarded} / ${s.max}`),
            h('td', { class: 'right' }, s.percent === null ? '—' : `${s.percent}%`),
            h('td', {}, s.grade ? h('span', { class: `grade-chip grade-${s.grade}` }, `${s.grade} · ${s.grade_label}`) : '—')
          )
        )
      )
    )
  );
}

function sheetHeader(school, title, lines) {
  return h(
    'header',
    { class: 'report-head' },
    h('div', { class: 'report-school' }, logoFor(school), h('div', {}, h('strong', {}, school.name), h('div', { class: 'hint' }, title))),
    h('div', { class: 'report-meta' }, lines.filter(Boolean).map((line) => h('div', {}, line)))
  );
}

const bullets = (items) => (items?.length ? h('ul', {}, items.map((item) => h('li', {}, item))) : null);

function gradeKey(grades) {
  return h('p', { class: 'hint report-key' }, `Grades: ${grades.map((g) => `${g.grade} ${g.label} (${g.min}%+)`).join(' · ')}. Each section is graded on its own; there is no overall percentage.`);
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
    const content = report?.content ?? null;
    const running = report?.status === 'running';
    const buildButton = h(
      'button',
      { class: `btn ${content ? '' : 'btn-primary'}`, type: 'button', disabled: running || !data.sections.length, onclick: build },
      running ? 'Writing…' : content ? 'Rebuild report' : 'Build report'
    );
    const inlineBuild = h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report');

    const toggle = h(
      'div',
      { class: 'segmented' },
      [['teacher', 'For the teacher'], ['management', 'For management']].map(([value, label]) =>
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
      sheet = h(
        'article',
        { class: 'report-sheet' },
        sheetHeader(school, 'Results so far', [teacher.name, test.name]),
        resultsTable(data.sections),
        gradeKey(data.grades),
        running ? null : h('p', { class: 'hint no-print' }, 'The written report has not been built yet. Press Build report.')
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
        h('div', {}, h('h1', {}, `${teacher.name}: reports`), h('p', {}, `${test.name}${report?.written_at ? ` · written ${formatDate(report.written_at)}` : ''}`)),
        h('div', { class: 'page-actions' }, toggle, buildButton, h('button', { class: 'btn btn-primary', onclick: () => window.print(), disabled: !content }, 'Print'))
      ),
      reportState(report, { building: inlineBuild, what: `${teacher.name}’s reports` }),
      sheet
    );
  }

  draw();
  mount(root, container);
  watch();
}

function teacherSheet(data, content) {
  const { teacher, school, test } = data;
  const t = content.teacher;
  // Only for papers in the programme's sections; a paper marked as a whole has none.
  const sectioned = content.sections.every((s) => SECTION_KEYS.includes(s.key));
  const notSat = sectioned ? SECTION_KEYS.filter((key) => !content.sections.some((s) => s.key === key)) : [];
  return h(
    'article',
    { class: 'report-sheet' },
    sheetHeader(school, 'Teacher development report', [teacher.name, [teacher.grade, teacher.subjects].filter(Boolean).join(' · '), test.name]),
    t.opening ? h('p', { class: 'report-lead' }, t.opening) : null,
    h('h3', {}, 'Your results'),
    resultsTable(content.sections),
    gradeKey(data.grades),
    t.sections.map((s) =>
      h(
        'section',
        { class: 'report-section' },
        h('h3', {}, s.section),
        h('div', { class: 'report-cols' }, h('div', {}, h('h4', {}, 'What went well'), bullets(s.went_well)), h('div', {}, h('h4', {}, 'Your next steps'), bullets(s.next_steps)))
      )
    ),
    t.practice_ideas.length ? h('section', { class: 'report-section' }, h('h3', {}, 'Ideas to practise this term'), bullets(t.practice_ideas)) : null,
    notSat.length
      ? h('p', { class: 'hint' }, `You have not sat ${notSat.map((k) => `Section ${k}`).join(' or ')} in this test yet. When you do, it will be added to this report.`)
      : null,
    t.closing ? h('p', { class: 'report-lead' }, t.closing) : null
  );
}

function potentialBox(potential, aiRoles) {
  if (!potential) return null;
  const areas = [
    ['Strengths', potential.strengths],
    ['Developing', potential.developing],
    ['Support priority', potential.support],
  ].filter(([, list]) => list.length);
  // OpenAI's roles cite the answers; the rule-based ones are a fallback.
  const roles = aiRoles.length
    ? aiRoles
    : potential.roles.map((r) => ({ role: `Could take on ${r.role}`, evidence: `Exemplary in ${r.section}.` }));
  return h(
    'section',
    { class: 'potential-box' },
    h('div', { class: 'potential-head' }, h('span', { class: 'hint' }, 'Potential identifier'), potentialBadge(potential)),
    h('p', {}, potential.meaning, ' ', h('span', { class: 'hint' }, potential.evidence)),
    areas.length ? h('p', { class: 'hint' }, areas.map(([label, list]) => `${label}: ${list.join(', ')}`).join(' · ')) : null,
    roles.length ? h('div', {}, h('h4', {}, 'Responsibilities the evidence supports'), h('ul', {}, roles.map((r) => h('li', {}, h('strong', {}, r.role), r.evidence ? ` — ${r.evidence}` : '')))) : null
  );
}

function managementSheet(data, content) {
  const { teacher, school, test } = data;
  const m = content.management;
  return h(
    'article',
    { class: 'report-sheet' },
    sheetHeader(school, 'Management report: teacher profile', [teacher.name, [teacher.grade, teacher.subjects].filter(Boolean).join(' · '), test.name]),
    m.summary ? h('p', { class: 'report-lead' }, m.summary) : null,
    resultsTable(content.sections),
    gradeKey(data.grades),
    potentialBox(content.potential, m.roles),
    m.sections.map((s) =>
      h(
        'section',
        { class: 'report-section' },
        h('h3', {}, s.section),
        s.evidence ? h('p', {}, s.evidence) : null,
        h('div', { class: 'report-cols' }, h('div', {}, h('h4', {}, 'Strengths'), bullets(s.strengths)), h('div', {}, h('h4', {}, 'Gaps'), bullets(s.gaps)))
      )
    ),
    m.support.length ? h('section', { class: 'report-section' }, h('h3', {}, 'Recommended support'), bullets(m.support)) : null
  );
}

/* ------------------------------------------------- the whole school's report */

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
    const written = report?.content ?? null;
    // Figures come from the report once it is written, so they match its text.
    const figures = written ?? data;
    const running = report?.status === 'running';

    const buildButton = h(
      'button',
      { class: `btn ${written ? '' : 'btn-primary'}`, type: 'button', disabled: running || !data.assessed, onclick: build },
      running ? 'Writing…' : written ? 'Rebuild report' : 'Build report'
    );

    const keys = figures.section_stats.map((s) => s.key);
    const assessed = figures.teachers.filter((t) => t.sections.length);

    const sheet = h(
      'article',
      { class: 'report-sheet' },
      sheetHeader(school, 'Management report: all teachers', [test.name, `${figures.assessed} of ${figures.teachers.length} teachers assessed`, written && report.written_at ? `Written ${formatDate(report.written_at)}` : null]),
      written?.overview ? h('p', { class: 'report-lead' }, written.overview) : null,

      h('h3', {}, 'Sections across the school'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Section'), h('th', { class: 'right' }, 'Teachers'), h('th', { class: 'right' }, 'Average'), data.grades.map((g) => h('th', { class: 'right' }, g.grade)))),
          h(
            'tbody',
            {},
            figures.section_stats.map((s) =>
              h(
                'tr',
                {},
                h('td', {}, h('strong', {}, s.name), s.title ? h('div', { class: 'hint' }, s.title) : null),
                h('td', { class: 'right' }, s.sat),
                h('td', { class: 'right' }, s.average === null ? '—' : `${s.average}%`),
                data.grades.map((g) => h('td', { class: 'right' }, s.counts[g.grade] || '·'))
              )
            )
          )
        )
      ),
      gradeKey(data.grades),

      written?.section_insights?.length
        ? h('section', { class: 'report-section' }, h('h3', {}, 'What the sections show'), written.section_insights.map((s) =>
            h('div', { class: 'insight' }, h('h4', {}, s.section), h('p', {}, s.pattern), s.training_priority ? h('p', {}, h('strong', {}, 'Training priority: '), s.training_priority) : null)
          ))
        : null,

      h('h3', {}, 'Teachers'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Teacher'), keys.map((key) => h('th', {}, key ? `Section ${key}` : 'Paper')), h('th', {}, 'Potential'))),
          h(
            'tbody',
            {},
            assessed.map((t) =>
              h(
                'tr',
                {},
                h('td', {}, h('a', { href: `#/teachers/${t.id}/report/${test.id}?for=management` }, t.name), [t.grade, t.subjects].filter(Boolean).length ? h('div', { class: 'hint' }, [t.grade, t.subjects].filter(Boolean).join(' · ')) : null),
                keys.map((key) => {
                  const s = t.sections.find((x) => x.key === key);
                  return h('td', {}, s ? percentChip(s) : h('span', { class: 'hint' }, 'not sat'));
                }),
                h('td', {}, potentialBadge(t.potential), t.potential?.provisional ? h('div', { class: 'hint' }, t.potential.evidence) : null)
              )
            )
          )
        )
      ),
      figures.not_assessed.length ? h('p', { class: 'hint' }, `Not yet assessed in this test: ${figures.not_assessed.join(', ')}.`) : null,

      h(
        'div',
        { class: 'report-cols' },
        h('section', {}, h('h4', {}, 'Mentor potential'), figures.mentors.length ? bullets(figures.mentors) : h('p', { class: 'hint' }, 'No one is exemplary in every section they sat yet.')),
        h('section', {}, h('h4', {}, 'Priority for support'), figures.support.length ? bullets(figures.support) : h('p', { class: 'hint' }, 'No one needs priority support.'))
      ),

      figures.section_stats.some((s) => s.helpers.length && s.needs.length)
        ? h(
            'section',
            { class: 'report-section' },
            h('h3', {}, 'Peer support'),
            h('p', { class: 'hint' }, 'Colleagues strong in a section alongside those who need support in it.'),
            h('ul', {}, figures.section_stats.filter((s) => s.helpers.length && s.needs.length).map((s) =>
              h('li', {}, h('strong', {}, `${s.name}: `), `${s.helpers.join(', ')} could support ${s.needs.join(', ')}.`)
            ))
          )
        : null,

      written?.recommendations?.length ? h('section', { class: 'report-section' }, h('h3', {}, 'Recommendations'), h('ol', {}, written.recommendations.map((r) => h('li', {}, r)))) : null,
      !written && !running ? h('p', { class: 'hint no-print' }, 'The figures above are live. Press Build report to add OpenAI’s written analysis and recommendations.') : null
    );

    mount(
      container,
      h('div', { class: 'breadcrumb no-print' }, h('a', { href: `#/assessments?school=${school.id}&test=${test.id}` }, '← Assessments')),
      h(
        'div',
        { class: 'page-head no-print' },
        h('div', {}, h('h1', {}, `${school.name}: all teachers`), h('p', {}, `${test.name}. Figures are per section; teachers are only compared within a section they sat.`)),
        h('div', { class: 'page-actions' }, buildButton, h('button', { class: 'btn btn-primary', onclick: () => window.print() }, 'Print'))
      ),
      reportState(report, { building: h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report'), what: 'the report on all teachers' }),
      data.assessed ? sheet : emptyState('No teacher has been evaluated in this test yet.')
    );
  }

  draw();
  mount(root, container);
  watch();
}
