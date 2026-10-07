// Written Expression: how well a teacher writes, section by section, apart
// from the marks (server/writing.js). A chip shows each section's score out
// of 10; clicking it opens the errors found in the teacher's answers, each
// with what the teacher wrote, what is wrong and the correction. The reports
// carry the same list in a short table.
import { h } from './ui.js';

export const WRITING_NAME = 'Written Expression';

const LEVEL_CLASSES = { Excellent: 'w-excellent', Good: 'w-good', Fair: 'w-fair', 'Needs Practice': 'w-practice' };
export const levelClass = (w) => LEVEL_CLASSES[w?.level] ?? 'w-none';
const short = (name) => (/^Section [A-Z]$/.test(name) ? name.slice(8) : name);
const scoreText = (w) => (w?.judged ? `${w.score} / 10` : '—');

// Sections whose writing was checked.
export const checkedSections = (sections) => sections.filter((s) => s.writing?.checked);

// "7.5 / 10 · Good", or why there is no score.
export function writingLine(w) {
  if (!w) return 'Not checked yet';
  if (!w.checked) return 'Could not be checked';
  if (!w.judged) return 'Too little writing to judge';
  return `${w.score} / 10 · ${w.level}`;
}

// One chip for a teacher's sections: "Written Expression A 7.5 · B 6". It
// opens the error report. Null when no section has been checked.
export function writingChip(sections, { teacherName = '' } = {}) {
  const checked = checkedSections(sections);
  if (!checked.length) return null;
  const worst = [...checked].filter((s) => s.writing.judged).sort((a, b) => a.writing.score - b.writing.score)[0];
  return h(
    'button',
    {
      type: 'button',
      class: `writing-chip ${levelClass(worst?.writing)}`,
      title: `${WRITING_NAME}: click to see the errors in the writing`,
      onclick: (event) => {
        event.stopPropagation();
        openWritingReport({ teacherName, sections: checked });
      },
    },
    h('span', { class: 'writing-chip-name' }, WRITING_NAME),
    checked.map((s) => ` ${checked.length > 1 ? `${short(s.name)} ` : ''}${s.writing.judged ? s.writing.score : '—'}`).join(' ·')
  );
}

// The four scores out of 5, as small labelled bars.
function criteriaBars(criteria) {
  return h(
    'div',
    { class: 'writing-criteria' },
    criteria.map((c) =>
      h(
        'div',
        { class: 'writing-criterion' },
        h('span', {}, c.label),
        h('span', { class: 'writing-dots', 'aria-label': `${c.score} out of 5` }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= c.score ? 'on' : null }))),
        h('b', {}, `${c.score}/5`)
      )
    )
  );
}

// The errors as a table: question, the kind of error, what was written and
// the correction, with what is wrong under it.
export function errorsTable(errors, { forTeacher = false } = {}) {
  if (!errors.length) return h('p', { class: 'hint' }, 'No errors found in the writing.');
  const wrote = forTeacher ? 'You Wrote' : 'The Teacher Wrote';
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'report-table writing-errors' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Question'), h('th', {}, 'Error'), h('th', {}, wrote), h('th', {}, 'Correction'))),
      h(
        'tbody',
        {},
        errors.map((e) =>
          h(
            'tr',
            {},
            h('td', { class: 'nowrap' }, h('strong', {}, e.question || '—')),
            h('td', {}, h('span', { class: 'error-type' }, e.type), e.problem ? h('div', { class: 'hint' }, e.problem) : null),
            h('td', { 'data-label': wrote }, h('span', { class: 'error-wrote', dir: 'auto' }, e.wrote)),
            h('td', { 'data-label': 'Correction' }, h('span', { class: 'error-fixed', dir: 'auto' }, e.correction))
          )
        )
      )
    )
  );
}

// One section's score, four scores, sentence and errors.
function sectionBlock(s, { forTeacher = false, heading = 'h3' } = {}) {
  const w = s.writing;
  return h(
    'div',
    { class: 'writing-block' },
    h(
      'div',
      { class: 'writing-block-head' },
      h(heading, {}, s.name),
      h('span', { class: `writing-score ${levelClass(w)}` }, writingLine(w))
    ),
    !w.checked ? h('p', { class: 'hint' }, w.problem) : null,
    w.judged ? criteriaBars(w.criteria) : null,
    w.summary ? h('p', { class: 'writing-summary' }, w.summary) : null,
    w.judged || w.errors?.length ? errorsTable(w.errors ?? [], { forTeacher }) : null
  );
}

// "Scored out of 10 from …" with the bands.
export function writingKey() {
  return h(
    'p',
    { class: 'report-note' },
    h('strong', {}, `${WRITING_NAME}: `),
    'how well the answers are written, judged in the language they are written in, apart from the marks. Scored out of 10 from Sentence Formation, Grammar, Spelling and Punctuation, and Word Choice, each out of 5. Excellent 8.5 and above · Good 7–8 · Fair 5–6.5 · Needs Practice below 5.'
  );
}

// The dialog the chips open.
export function openWritingReport({ teacherName = '', sections }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const overlay = h(
    'div',
    { class: 'modal-backdrop', onclick: (event) => { if (event.target === overlay) close(); } },
    h(
      'div',
      { class: 'modal writing-report', role: 'dialog', 'aria-modal': 'true', 'aria-label': WRITING_NAME },
      h(
        'div',
        { class: 'modal-head' },
        h('div', {}, h('h2', {}, `${WRITING_NAME}${teacherName ? `: ${teacherName}` : ''}`), h('p', { class: 'hint' }, 'Errors in sentence formation, grammar, spelling, punctuation and word choice found in the written answers. The marks are not affected.')),
        h('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: close }, '×')
      ),
      h('div', { class: 'writing-report-body' }, sections.map((s) => sectionBlock(s)), writingKey()),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'))
    )
  );
  document.addEventListener('keydown', onKey);
  // Following a link, such as a teacher's name behind it, closes it.
  window.addEventListener('hashchange', close);
  document.body.append(overlay);
}

// The section in a teacher's two reports. Null when no section was checked.
export function writingSection(sections, { forTeacher = false } = {}) {
  const checked = checkedSections(sections);
  if (!checked.length) return null;
  return h(
    'section',
    { class: 'report-writing', id: 'written-expression' },
    h('h2', {}, WRITING_NAME, h('small', {}, forTeacher ? 'How well your answers are written, and what to correct' : 'How well the teacher’s answers are written, and the errors found')),
    checked.map((s) => sectionBlock(s, { forTeacher })),
    writingKey()
  );
}
