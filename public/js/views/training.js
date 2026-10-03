// The growth paths UpSchool offers, which the training plan in each management
// report is drawn from. They are typed in here, or read by OpenAI from a
// proposal, and kept on this server only.
import { h, mount, field, toast, confirmAction, formatDate } from '../ui.js';
import { trainingApi } from '../api.js';

const blankPath = () => ({ name: '', scope: '', min_days: '', max_days: '' });

export async function renderTraining(root) {
  const data = await trainingApi.get();
  const state = {
    saved: data.framework,
    form: formFrom(data.framework),
    rules: data.rules,
    openai: data.openai,
    reading: false,
  };
  const container = h('div', {});

  function draw() {
    mount(
      container,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, 'Training Paths'),
          h(
            'p',
            {},
            'The growth paths UpSchool offers. Each teacher’s management report recommends one from their section grades, with a day-by-day training plan, and the report on all teachers plans the training for the whole school. These are kept on this server only.'
          )
        )
      ),
      readCard(state, draw),
      formCard(state, draw)
    );
  }

  draw();
  mount(root, container);
}

function formFrom(framework) {
  return {
    programme: framework?.programme ?? '',
    paths: framework?.paths?.length ? framework.paths.map((p) => ({ ...p })) : [blankPath(), blankPath(), blankPath()],
    exit_assessment: framework?.exit_assessment ?? '',
    continuity: framework?.continuity ?? '',
  };
}

function readCard(state, draw) {
  const fileInput = h('input', { type: 'file', accept: '.pdf,application/pdf' });
  const button = h('button', { class: 'btn btn-primary', type: 'button', disabled: state.reading || !state.openai }, state.reading ? 'Reading…' : 'Read PDF');
  button.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast('Choose the PDF first.', 'error');
      return;
    }
    const body = new FormData();
    body.append('file', file);
    state.reading = true;
    draw();
    try {
      const { framework } = await trainingApi.read(body);
      state.form = formFrom(framework);
      toast('Read. Check the paths below, then press Save.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.reading = false;
      draw();
    }
  });

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Read From a Document'),
    h(
      'p',
      { class: 'hint' },
      state.openai
        ? 'Choose the training proposal as a PDF. OpenAI fills in the paths, their days and what follows the training below, leaving out prices and names. Nothing is saved until you press Save, and the PDF is not kept.'
        : 'OpenAI is not set up on the server, so type the paths in below.'
    ),
    h('div', { class: 'form-actions', style: 'margin-top:0' }, fileInput, button),
    state.reading ? h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), 'OpenAI is reading the document. This can take up to a minute.') : null
  );
}

function formCard(state, draw) {
  const { form } = state;
  const bind = (target, key) => (event) => {
    target[key] = event.target.value;
  };
  const text = (target, key, attrs = {}) => h('input', { type: 'text', value: target[key] ?? '', oninput: bind(target, key), ...attrs });
  const days = (target, key, label) =>
    h('input', { type: 'number', min: 1, max: 120, step: 1, value: target[key] ?? '', oninput: bind(target, key), class: 'days-input', 'aria-label': label });

  const rows = form.paths.map((path, i) =>
    h(
      'tr',
      {},
      h('td', { class: 'nowrap hint' }, i + 1),
      h('td', {}, text(path, 'name', { placeholder: 'Path name', 'aria-label': 'Path name' })),
      h('td', {}, text(path, 'scope', { placeholder: 'What it covers', 'aria-label': 'What it covers' })),
      h('td', {}, h('div', { class: 'days-pair' }, days(path, 'min_days', 'Days from'), h('span', { class: 'hint' }, 'to'), days(path, 'max_days', 'Days to'))),
      h(
        'td',
        { class: 'right' },
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          title: 'Remove this path',
          onclick: () => {
            form.paths.splice(i, 1);
            draw();
          },
        }, 'Remove')
      )
    )
  );

  const save = async (event) => {
    event.preventDefault();
    try {
      const { framework } = await trainingApi.save(form);
      state.saved = framework;
      state.form = formFrom(framework);
      toast('Saved. Rebuild a report to bring its training plan up to date.', 'success');
      draw();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const clear = async () => {
    if (!confirmAction('Remove the growth paths? Reports built after this will have no training plan.')) return;
    try {
      await trainingApi.clear();
      state.saved = null;
      state.form = formFrom(null);
      toast('Removed.', 'success');
      draw();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  return h(
    'form',
    { class: 'card', onsubmit: save },
    h('h2', {}, 'Growth Paths'),
    h('p', { class: 'hint' }, 'List them from the shortest to the longest, with the days each one runs for. How a teacher’s path is picked:'),
    h('ul', { class: 'rules-list' }, state.rules.map((rule) => h('li', {}, rule))),
    h(
      'p',
      { class: 'hint' },
      'Within its path, a section at grade D gets more days than one at C, and every plan ends with classroom application and a review day before the exit assessment.'
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'paths-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Path'), h('th', {}, 'What It Covers'), h('th', {}, 'Days'), h('th', {}))),
        h('tbody', {}, rows)
      )
    ),
    h(
      'div',
      { class: 'form-actions', style: 'margin-top:10px' },
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => {
          form.paths.push(blankPath());
          draw();
        },
      }, 'Add a path')
    ),
    h(
      'div',
      { class: 'form-grid', style: 'margin-top:18px' },
      field('Programme name', text(form, 'programme', { id: 'f-programme' }), {
        hint: 'Optional. Shown with the path on reports.',
      }),
      field(
        'Exit assessment',
        h('textarea', { id: 'f-exit', oninput: bind(form, 'exit_assessment') }, form.exit_assessment),
        { span: true, hint: 'What happens after the training, in a sentence or two. Shown on every training plan.' }
      ),
      field(
        'Support after the training',
        h('textarea', { id: 'f-continuity', oninput: bind(form, 'continuity') }, form.continuity),
        { span: true, hint: 'Optional: any ongoing support offered once a plan is finished.' }
      )
    ),
    h(
      'div',
      { class: 'form-actions' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      state.saved ? h('button', { class: 'btn btn-danger', type: 'button', onclick: clear }, 'Remove paths') : null,
      h(
        'span',
        { class: 'hint' },
        state.saved
          ? `Saved ${formatDate(state.saved.updated_at)}. Reports built since then include a training plan; rebuild older ones to add it.`
          : 'Not saved yet: reports have no training plan until the paths are saved.'
      )
    )
  );
}
