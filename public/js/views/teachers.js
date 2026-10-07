// A teacher's profile: who they are, and what every test they have sat shows,
// section by section, with how each section has moved from test to test.
import { h, mount, formatDate, statusBadge, percentChip, potentialBadge, emptyState, logoFor, titleCase } from '../ui.js';
import { teachersApi } from '../api.js';
import { writingChip } from '../writing.js';

export async function renderTeacherProfile(root, id) {
  const { teacher, school, grades, tests } = await teachersApi.profile(id);
  const latest = [...tests].reverse().find((t) => t.sections.length);

  mount(
    root,
    h(
      'div',
      { class: 'breadcrumb' },
      h('a', { href: `#/schools/${school.id}` }, school.name),
      ' · ',
      h('a', { href: `#/assessments?school=${school.id}` }, 'Assessments')
    ),
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'detail-head' },
        logoFor(school),
        h(
          'div',
          {},
          h('h1', {}, teacher.name),
          h('p', {}, [teacher.grade, teacher.subjects, school.name].filter(Boolean).join(' · ')),
          [teacher.email, teacher.phone].filter(Boolean).length ? h('p', {}, [teacher.email, teacher.phone].filter(Boolean).join(' · ')) : null
        )
      ),
      latest?.potential ? h('div', { class: 'page-actions' }, potentialBadge(latest.potential)) : null
    ),
    tests.length
      ? [progressCard(tests, grades), ...[...tests].reverse().map((entry) => testCard(teacher, entry))]
      : h('div', { class: 'card' }, emptyState('This teacher has not sat any tests yet.', h('a', { class: 'btn btn-primary', href: `#/assessments?school=${school.id}`, style: 'margin-top:12px' }, 'Go to Assessments')))
  );
}

// Each test in a row, each section in a column, with the change in
// percentage points since the previous test that included that section.
function progressCard(tests, grades) {
  const keys = [...new Set(tests.flatMap((t) => t.sections.map((s) => s.key)))].sort();
  if (!keys.length) return null;
  const previous = {};
  const rows = tests.map((entry) => {
    const cells = keys.map((key) => {
      const s = entry.sections.find((x) => x.key === key);
      if (!s) return h('td', {}, h('span', { class: 'hint' }, 'not sat'));
      const change = previous[key] !== undefined && s.percent !== null ? s.percent - previous[key] : null;
      if (s.percent !== null) previous[key] = s.percent;
      return h(
        'td',
        {},
        percentChip(s),
        change ? h('span', { class: `change ${change > 0 ? 'up' : 'down'}` }, `${change > 0 ? '+' : ''}${change}`) : null
      );
    });
    return h('tr', {}, h('td', {}, h('strong', {}, entry.test.name)), cells, h('td', {}, potentialBadge(entry.potential)));
  });

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Progress'),
    h('p', { class: 'hint' }, `Each section is graded on its own: ${grades.map((g) => `${g.grade} ${g.label} (${g.min}%+)`).join(' · ')}. Changes are in percentage points since the previous test.`),
    h(
      'div',
      { class: 'table-wrap' },
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Test'), keys.map((key) => h('th', {}, key ? `Section ${key}` : 'Paper')), h('th', {}, 'Potential Identifier'))), h('tbody', {}, rows))
    )
  );
}

function testCard(teacher, entry) {
  const { test, sections, potential, sittings, report } = entry;
  const reportLink = (audience, label) =>
    h('a', { class: 'btn btn-sm', href: `#/teachers/${teacher.id}/report/${test.id}${audience === 'management' ? '?for=management' : ''}` }, label);
  const reportNote = !report
    ? null
    : report.status === 'running'
      ? 'The reports are being written.'
      : report.status === 'failed'
        ? `The last report could not be written: ${report.error}`
        : report.old_layout
          ? 'These reports were written in the earlier layout; open them to rebuild in the simpler one.'
          : report.no_answers
            ? 'These reports were written before they showed each question’s answers; open them to rebuild.'
            : report.stale
              ? 'These reports are out of date: new marks have come in or the growth paths have changed. Open them to rebuild.'
              : report.written_at
                ? `Reports written ${formatDate(report.written_at)}.`
                : null;

  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'scan-group-head' },
      h('h2', { style: 'margin:0' }, test.name),
      sections.length ? h('div', { class: 'page-actions' }, reportLink('teacher', 'Teacher Report'), reportLink('management', 'Management Report')) : null
    ),
    sections.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Section'), h('th', {}, 'Date Sat'), h('th', { class: 'right' }, 'Marks'), h('th', {}, 'Result'))),
            h(
              'tbody',
              {},
              sections.map((s) =>
                h(
                  'tr',
                  { style: 'cursor:pointer', onclick: () => window.navigate(`/assessments/${s.assessment_id}`) },
                  h('td', {}, h('strong', {}, titleCase(s.name)), s.title ? h('div', { class: 'hint' }, s.title) : null),
                  h('td', {}, formatDate(s.date) || '—'),
                  h('td', { class: 'right' }, `${s.awarded} / ${s.max}`, s.marking === 'lenient' ? h('div', { class: 'hint' }, s.left_out ? `Lenient: ${s.left_out} not attempted left out` : 'Lenient') : null),
                  h('td', {}, percentChip(s), s.grade_label ? h('span', { class: 'hint' }, ` ${s.grade_label}`) : null)
                )
              )
            )
          )
        )
      : h('p', { class: 'hint' }, 'Nothing has been evaluated in this test yet.'),
    sections.length ? h('div', { class: 'chips', style: 'margin-top:8px' }, writingChip(sections, { teacherName: teacher.name })) : null,
    potential ? h('p', {}, h('strong', {}, 'Potential Identifier: '), potentialBadge(potential), ' ', h('span', { class: 'hint' }, `${potential.meaning} ${potential.evidence}`)) : null,
    report?.teacher?.practice_ideas?.length
      ? h('div', {}, h('h3', { class: 'subhead' }, 'Practice Ideas from the Teacher’s Report'), h('ul', {}, report.teacher.practice_ideas.map((idea) => h('li', {}, idea))))
      : null,
    report?.management?.support?.length
      ? h('div', {}, h('h3', { class: 'subhead' }, 'Support Recommended to Management'), h('ul', {}, report.management.support.map((item) => h('li', {}, item))))
      : null,
    reportNote ? h('p', { class: 'hint' }, reportNote) : null,
    h(
      'details',
      { class: 'sittings' },
      h('summary', {}, `Sittings (${sittings.length})`),
      h(
        'ul',
        {},
        sittings.map((sitting) =>
          h(
            'li',
            {},
            h('a', { href: `#/assessments/${sitting.id}` }, formatDate(sitting.assessment_date) || formatDate(sitting.created_at)),
            ' ',
            sitting.ai_status === 'running' ? h('span', { class: 'badge running' }, 'Marking…') : statusBadge(sitting.status)
          )
        )
      )
    )
  );
}
