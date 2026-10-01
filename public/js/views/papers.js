import { h, mount, field, input, textarea, select, toast, confirmAction, emptyState } from '../ui.js';
import { papersApi } from '../api.js';
import { paperFacts, paperThumb } from '../paper-picker.js';

const BOARDS = ['CBSE', 'ICSE', 'Karnataka State', 'Karnataka Pre-University'];

// The question paper library: the papers the board suggests for each teacher.
// Papers come in one at a time, or many at once from a paper pack (a zip of
// PDFs with their labels).
export async function renderPapers(root) {
  const state = { papers: [], levels: [], sections: [], editing: null, filter: { section: '', level: '', board: '', text: '' } };
  const container = h('div', {});

  async function load() {
    const data = await papersApi.list();
    state.papers = data.papers;
    state.levels = data.levels;
    state.sections = data.sections;
    draw();
  }

  function draw() {
    mount(
      container,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, 'Paper Library'),
          h(
            'p',
            {},
            'The question papers teachers sit, kept once as PDFs. On the Assessments board each teacher is offered the paper that fits their level, subject and board, and you confirm it before uploading their answer paper.'
          )
        )
      ),
      importCard(load),
      paperForm(state, load, draw),
      libraryCard(state, load, draw)
    );
  }

  mount(root, container);
  await load();
}

/* ------------------------------------------------------------------ import */

function importCard(reload) {
  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip' });
  const button = h('button', { class: 'btn btn-primary', type: 'button' }, 'Import');
  const report = h('div', { class: 'import-report' });

  button.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast('Choose the paper pack .zip file first.', 'error');
      return;
    }
    const data = new FormData();
    data.set('file', file);
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const result = await papersApi.importPack(data);
      toast(
        result.added
          ? `Added ${result.added} paper${result.added === 1 ? '' : 's'} to the library.`
          : 'Every paper in this pack is already in the library.',
        'success'
      );
      await reload();
      // The page has been redrawn; show what happened in the new card.
      const box = document.querySelector('.import-card .import-report');
      if (box) mount(box, importSummary(result));
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Import';
    }
  });

  return h(
    'div',
    { class: 'card import-card' },
    h('h2', {}, 'Import a Paper Pack'),
    h(
      'p',
      { class: 'hint' },
      'A paper pack is a .zip of question papers with their labels. Importing the same pack again only adds papers that are not already here.'
    ),
    h('div', { class: 'test-picker' }, fileInput, button),
    report
  );
}

function importSummary(result) {
  return h(
    'div',
    {},
    h('strong', {}, `${result.added} added, ${result.already} already in the library.`),
    result.problems?.length
      ? h('ul', {}, result.problems.map((problem) => h('li', {}, problem)))
      : null
  );
}

/* ------------------------------------------------------- add or edit a paper */

function paperForm(state, reload, redraw) {
  const paper = state.editing;
  const checks = (name, options, chosen) =>
    h(
      'div',
      { class: 'check-row' },
      options.map((option) =>
        h(
          'label',
          { class: 'inline' },
          h('input', { type: 'checkbox', name, value: option.value, checked: chosen.includes(option.value) }),
          option.label
        )
      )
    );

  const form = h(
    'form',
    {},
    h(
      'div',
      { class: 'form-grid' },
      paper
        ? null
        : field('PDF', h('input', { type: 'file', name: 'file', accept: 'application/pdf,.pdf', required: true }), {
            hint: 'For a Word paper, save it as PDF first (File → Save As → PDF).',
          }),
      field('Title', input('title', { value: paper?.title ?? '', required: true, placeholder: 'ICSE Middle School Science · Section B' })),
      field('Sections', checks('sections', state.sections.map((s) => ({ value: s, label: `Section ${s}` })), paper?.sections ?? []), {
        hint: 'Tick each section the paper holds.',
      }),
      field('Subject', input('subject', { value: paper?.subject ?? '', placeholder: 'Leave empty for a paper any subject teacher sits' })),
      field('Levels', checks('levels', state.levels.map((l) => ({ value: l.key, label: l.name })), paper?.levels ?? []), {
        span: true,
        hint: 'Leave all unticked for a paper any level sits.',
      }),
      field('Board', select('board', [{ value: '', label: 'Any board' }, ...BOARDS.map((b) => ({ value: b, label: b }))], { value: paper?.board ?? '' })),
      field('Language', input('language', { value: paper?.language ?? '', placeholder: 'English' })),
      field('Total marks', input('total_marks', { type: 'number', value: paper?.total_marks ?? '' })),
      field('Notes', textarea('notes', { value: paper?.notes ?? '', placeholder: 'Anything to check before using it' }), { span: true })
    ),
    h(
      'div',
      { class: 'form-actions' },
      paper ? h('button', { class: 'btn', type: 'button', onclick: () => { state.editing = null; redraw(); } }, 'Cancel') : null,
      h('button', { class: 'btn btn-primary', type: 'submit' }, paper ? 'Save changes' : 'Add to the library')
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      if (paper) {
        await papersApi.update(paper.id, {
          title: data.get('title'),
          sections: data.getAll('sections'),
          subject: data.get('subject'),
          levels: data.getAll('levels'),
          board: data.get('board'),
          language: data.get('language'),
          total_marks: data.get('total_marks'),
          notes: data.get('notes'),
        });
        toast('Saved.', 'success');
        state.editing = null;
      } else {
        const added = await papersApi.add(data);
        toast(`Added “${added.title}” to the library.`, 'success');
      }
      await reload();
    } catch (error) {
      toast(error.message, 'error');
      submit.disabled = false;
    }
  });

  const card = h('div', { class: 'card paper-form-card' }, h('h2', {}, paper ? `Edit “${paper.title}”` : 'Add a Paper'), form);
  if (paper) return card;
  // Adding one paper at a time is the rarer job, so it starts folded away.
  return h(
    'details',
    { class: 'card paper-form-card' },
    h('summary', {}, h('h2', { style: 'display:inline' }, 'Add a Paper')),
    h('div', { style: 'margin-top:14px' }, form)
  );
}

/* ----------------------------------------------------------------- the list */

function libraryCard(state, reload, redraw) {
  const { filter } = state;
  const sectionFilter = select('f_section', [{ value: '', label: 'All sections' }, ...state.sections.map((s) => ({ value: s, label: `Section ${s}` }))], { value: filter.section });
  const levelFilter = select('f_level', [{ value: '', label: 'All levels' }, ...state.levels.map((l) => ({ value: l.key, label: l.name }))], { value: filter.level });
  const boardFilter = select('f_board', [{ value: '', label: 'All boards' }, ...BOARDS.map((b) => ({ value: b, label: b }))], { value: filter.board });
  const textFilter = input('f_text', { value: filter.text, placeholder: 'Search titles and subjects' });

  const list = h('div', {});
  const drawList = () => {
    const text = filter.text.trim().toLowerCase();
    const shown = state.papers.filter(
      (paper) =>
        (!filter.section || paper.sections.includes(filter.section)) &&
        // A paper with no levels suits any level.
        (!filter.level || !paper.levels.length || paper.levels.includes(filter.level)) &&
        (!filter.board || !paper.board || paper.board === filter.board) &&
        (!text || `${paper.title} ${paper.subject} ${paper.language}`.toLowerCase().includes(text))
    );
    mount(
      list,
      shown.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Paper'), h('th', {}, 'Used by'), h('th', { class: 'right' }, ''))),
              h(
                'tbody',
                {},
                shown.map((paper) =>
                  h(
                    'tr',
                    {},
                    h('td', { style: 'width:56px' }, h('a', { href: `/uploads/${paper.stored_name}`, target: '_blank', rel: 'noopener' }, paperThumb(paper))),
                    h(
                      'td',
                      {},
                      h('a', { href: `/uploads/${paper.stored_name}`, target: '_blank', rel: 'noopener' }, h('strong', {}, paper.title)),
                      h('div', { class: 'hint' }, paperFacts(paper)),
                      paper.notes ? h('div', { class: 'hint paper-note' }, paper.notes) : null
                    ),
                    h('td', {}, paper.used_by ? `${paper.used_by} sitting${paper.used_by === 1 ? '' : 's'}` : h('span', { class: 'hint' }, '—')),
                    h(
                      'td',
                      { class: 'right' },
                      h(
                        'div',
                        { class: 'row-actions' },
                        h(
                          'button',
                          {
                            class: 'btn btn-sm',
                            type: 'button',
                            onclick: () => {
                              state.editing = paper;
                              redraw();
                              document.querySelector('.paper-form-card')?.scrollIntoView({ behavior: 'smooth' });
                            },
                          },
                          'Edit'
                        ),
                        h(
                          'button',
                          {
                            class: 'btn btn-sm btn-danger',
                            type: 'button',
                            onclick: async () => {
                              if (!confirmAction(`Delete “${paper.title}” from the library?`)) return;
                              try {
                                await papersApi.remove(paper.id);
                                toast('Paper deleted.', 'success');
                                await reload();
                              } catch (error) {
                                toast(error.message, 'error');
                              }
                            },
                          },
                          'Delete'
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        : emptyState(
            state.papers.length
              ? 'No papers match these filters.'
              : 'The library is empty. Import a paper pack above, or add papers one at a time.'
          )
    );
  };

  const onFilter = () => {
    filter.section = sectionFilter.value;
    filter.level = levelFilter.value;
    filter.board = boardFilter.value;
    filter.text = textFilter.value;
    drawList();
  };
  for (const el of [sectionFilter, levelFilter, boardFilter]) el.addEventListener('change', onFilter);
  textFilter.addEventListener('input', onFilter);
  drawList();

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, `Papers (${state.papers.length})`),
    state.papers.length ? h('div', { class: 'filter-row' }, sectionFilter, levelFilter, boardFilter, textFilter) : null,
    list
  );
}
