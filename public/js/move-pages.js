// "Move to another teacher", for pages filed under the wrong teacher. The
// dialog asks which teacher, and which pages when the sitting has both a
// question paper and an answer paper, then moves them to that teacher's
// current sitting in the same test, for the same full paper or section, after
// any pages it already has. Nothing is marked.
import { h, field, select, toast } from './ui.js';
import { teachersApi, assessmentsApi } from './api.js';

const KIND_NAMES = { question_paper: 'question paper', response: 'answer paper' };
const pageCount = (n) => `${n} page${n === 1 ? '' : 's'}`;

// `sitting` is { id, teacher_id, teacher_name, school_id, question_paper_count,
// response_count }. `kind` is the pages being looked at, ticked to start with.
// Resolves with what the server moved, or null if nothing was.
export async function movePages({ sitting, kind = null }) {
  let teachers;
  try {
    teachers = (await teachersApi.list({ school_id: sitting.school_id })).filter((t) => t.id !== sitting.teacher_id);
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
  if (!teachers.length) {
    toast('This school has no other teachers to move the pages to.', 'error');
    return null;
  }

  const counts = { question_paper: sitting.question_paper_count, response: sitting.response_count };
  const present = Object.keys(KIND_NAMES).filter((key) => counts[key] > 0);

  return new Promise((resolve) => {
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    const teacherChoice = select(
      'teacher_id',
      [
        { value: '', label: 'Choose the teacher these pages belong to…' },
        ...teachers.map((t) => ({ value: String(t.id), label: [t.name, t.grade, t.subjects].filter(Boolean).join(' · ') })),
      ],
      { id: 'move-teacher' }
    );

    // With both kinds of pages, a tick for each; with one, a line saying what goes.
    const ticks = present.map((key) => {
      const box = h('input', { type: 'checkbox', value: key });
      box.checked = present.length === 1 || !kind || key === kind;
      return box;
    });
    const which = present.length > 1
      ? h(
          'div',
          { class: 'check-row' },
          ticks.map((box) => h('label', { class: 'inline' }, box, `The ${KIND_NAMES[box.value]} (${pageCount(counts[box.value])})`))
        )
      : h('p', { class: 'hint' }, `The ${KIND_NAMES[present[0]]}: ${pageCount(counts[present[0]])}.`);

    const move = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Move pages');
    const update = () => {
      move.disabled = !teacherChoice.value || !ticks.some((box) => box.checked);
    };
    teacherChoice.addEventListener('change', update);
    for (const box of ticks) box.addEventListener('change', update);

    move.addEventListener('click', async () => {
      move.disabled = true;
      move.textContent = 'Moving…';
      try {
        const result = await assessmentsApi.move(sitting.id, Number(teacherChoice.value), ticks.filter((box) => box.checked).map((box) => box.value));
        const what = result.kinds.length === 1 ? `’s ${KIND_NAMES[result.kinds[0]]}` : '';
        toast(`Moved ${pageCount(result.moved)} to ${result.teacher.name}${what}.`, 'success');
        close(result);
      } catch (error) {
        toast(error.message, 'error');
        move.textContent = 'Move pages';
        update();
      }
    });

    const overlay = h(
      'div',
      { class: 'modal-backdrop', onclick: (event) => { if (event.target === overlay) close(null); } },
      h(
        'div',
        { class: 'modal move-pages', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Move pages to another teacher' },
        h(
          'div',
          { class: 'modal-head' },
          h(
            'div',
            {},
            h('h2', {}, `Move ${sitting.teacher_name}’s pages to another teacher`),
            h('p', { class: 'hint' }, 'For pages filed under the wrong teacher. They go after any pages that teacher already has in this test. Nothing is marked.')
          ),
          h('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: () => close(null) }, '×')
        ),
        h('div', { class: 'move-pages-body' }, field('Teacher', teacherChoice), field('Pages', which)),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'), move)
      )
    );

    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    teacherChoice.focus();
  });
}
