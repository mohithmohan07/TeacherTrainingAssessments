import { h, mount, statusBadge, formatDate, emptyState } from '../ui.js';
import { statsApi } from '../api.js';

// The dashboard is deliberately a placeholder for now: a few counts and the
// most recent assessments, so there is something to land on.
export async function renderDashboard(root) {
  const { counts, recent } = await statsApi.get();

  const stats = [
    { label: 'Schools', value: counts.schools },
    { label: 'Teachers', value: counts.teachers },
    { label: 'Assessments', value: counts.assessments },
    { label: 'Evaluated', value: counts.evaluated },
    { label: 'Scanned pages', value: counts.scanned_pages },
  ];

  const recentCard = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Recent assessments'),
    recent.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Assessment'), h('th', {}, 'Teacher'), h('th', {}, 'School'), h('th', {}, 'Date'), h('th', {}, 'Status'))),
            h(
              'tbody',
              {},
              recent.map((row) =>
                h(
                  'tr',
                  { style: 'cursor:pointer', onclick: () => window.navigate(`/assessments/${row.id}`) },
                  h('td', {}, row.title),
                  h('td', {}, row.teacher_name),
                  h('td', {}, row.school_name),
                  h('td', {}, formatDate(row.assessment_date) || '—'),
                  h('td', {}, statusBadge(row.status))
                )
              )
            )
          )
        )
      : emptyState(
          'Nothing here yet. Add a school and its teachers, then start an assessment.',
          h('a', { class: 'btn btn-primary', href: '#/schools', style: 'margin-top:12px' }, 'Add a school')
        )
  );

  mount(root, 
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Dashboard'), h('p', {}, 'An overview of your schools, teachers and assessments.'))
    ),
    h('div', { class: 'stat-row' }, stats.map((stat) => h('div', { class: 'stat' }, h('div', { class: 'value' }, stat.value), h('div', { class: 'label' }, stat.label)))),
    h('div', { style: 'height:18px' }),
    recentCard,
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'What goes here next'),
      h('p', { class: 'hint' }, 'This screen is a placeholder for now. Tell me what you want to see at a glance — pending evaluations, scores by school, teachers due for assessment — and I will build it here.')
    )
  );
}
