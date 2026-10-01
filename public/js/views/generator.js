import { h, mount, toast, confirmAction, formatDate, field, input, textarea, select, emptyState, upschoolLogo, printFrame } from '../ui.js';
import { generatorApi, schoolsApi } from '../api.js';

const BOARDS = ['CBSE', 'ICSE', 'Karnataka State', 'Karnataka Pre-University'];

function datalist(id, values) {
  return h('datalist', { id }, values.map((value) => h('option', { value })));
}

export async function renderGenerator(root) {
  const [config, papers, schools] = await Promise.all([generatorApi.config(), generatorApi.list(), schoolsApi.list()]);

  const teacherType = select(
    'teacher_type',
    Object.entries(config.teacher_types).map(([value, label]) => ({ value, label })),
    { value: 'subject' }
  );

  // One checkbox per section; the headings change with the teacher type.
  const sectionBoxes = h('div', { class: 'section-picks' });
  const drawSections = () => {
    const checked = new Set([...sectionBoxes.querySelectorAll('input:checked')].map((box) => box.value));
    const first = !sectionBoxes.childElementCount;
    mount(
      sectionBoxes,
      config.sections[teacherType.value].map((section) =>
        h(
          'label',
          { class: 'section-pick' },
          h('input', { type: 'checkbox', name: 'sections', value: section.key, checked: first || checked.has(section.key) }),
          h('span', {}, h('strong', {}, section.heading), h('small', {}, ` · ${section.marks} marks, 1 hour`))
        )
      )
    );
  };
  teacherType.addEventListener('change', drawSections);
  drawSections();

  const school = select('school_id', [{ value: '', label: 'No school on the paper' }, ...schools.map((s) => ({ value: String(s.id), label: s.name }))]);
  const level = select('level', [{ value: '', label: 'Choose a level' }, ...config.levels]);
  level.required = true;
  const withList = (control, list) => {
    control.setAttribute('list', list);
    control.setAttribute('autocomplete', 'off');
    return control;
  };

  const form = h(
    'form',
    {},
    h(
      'div',
      { class: 'form-grid' },
      field('Subject', input('subject', { placeholder: 'e.g. Biology, Hindi, Music' }), { hint: 'Needed for Section B.' }),
      field('Teacher', teacherType),
      field('Level', level),
      field('Language of the paper', withList(input('language', { value: 'English' }), 'gen-languages'), {
        hint: 'Pick one or type any other language.',
      }),
      field('School on the paper', school, { hint: 'Its name and logo go at the top.' }),
      field('Board', withList(input('board', { placeholder: 'e.g. ICSE' }), 'gen-boards')),
      field('Classes taught', input('grade', { placeholder: 'e.g. Classes IX-X' })),
      field('Topics', textarea('topics', { placeholder: 'Optional. One per line, e.g.\nOsmosis and plasmolysis\nMendelian genetics' }), {
        span: true,
        hint: 'Left blank, Gemini picks commonly misunderstood topics from the syllabus.',
      }),
      field('Anything else Gemini should know', textarea('instructions', { placeholder: 'Optional' }), { span: true })
    ),
    h('h3', { style: 'margin:20px 0 8px;font-size:15px' }, 'Sections'),
    sectionBoxes,
    datalist('gen-languages', config.languages),
    datalist('gen-boards', BOARDS)
  );

  const button = h('button', { type: 'submit', class: 'btn btn-primary', disabled: !config.configured }, 'Generate paper');
  const status = h('span', { class: 'hint' });
  form.append(h('div', { class: 'form-actions' }, button, status));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = { ...Object.fromEntries(data), sections: data.getAll('sections') };
    if (!body.sections.length) {
      toast('Tick at least one section.', 'error');
      return;
    }
    button.disabled = true;
    status.textContent = 'Gemini is writing the paper. This can take a minute or two…';
    try {
      const paper = await generatorApi.generate(body);
      toast('Paper generated.', 'success');
      window.navigate(`/generator/${paper.id}`);
    } catch (error) {
      toast(error.message, 'error');
      status.textContent = '';
      button.disabled = false;
    }
  });

  const notice = config.configured
    ? null
    : h(
        'div',
        { class: 'notice' },
        h('strong', {}, 'The Gemini API key is not set up yet. '),
        'Once GEMINI_API_KEY is added as a Fly secret, the Generate button starts working.'
      );

  const history = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Generated papers'),
    papers.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Paper'), h('th', {}, 'Subject'), h('th', {}, 'Classes'), h('th', {}, 'Sections'), h('th', {}, 'Created'))),
            h(
              'tbody',
              {},
              papers.map((paper) =>
                h(
                  'tr',
                  { style: 'cursor:pointer', onclick: () => window.navigate(`/generator/${paper.id}`) },
                  h('td', {}, paper.title),
                  h('td', {}, paper.subject || '—'),
                  h('td', {}, paper.grade || '—'),
                  h('td', {}, paper.sections.join(', ')),
                  h('td', {}, formatDate(paper.created_at))
                )
              )
            )
          )
        )
      : emptyState('No papers yet. Fill in the form above and press Generate paper.')
  );

  mount(
    root,
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Assessment generator'), h('p', {}, `Write a new teacher assessment paper with Gemini (${config.model}), in the same layout as the programme's papers.`))
    ),
    notice,
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'New paper'),
      h('p', { class: 'hint' }, 'Each section is one hour of case-study questions, with a model answer and marking points for every part.'),
      form
    ),
    history
  );
}

function renderPart(part, question, paper, showAnswers) {
  return h(
    'li',
    { class: 'paper-part' },
    h(
      'div',
      { class: 'q-line' },
      h('span', {}, h('span', { class: 'part-label' }, `${part.label}. `), part.text),
      question.components ? null : h('span', { class: 'q-marks' }, `(${part.marks})`)
    ),
    showAnswers
      ? h(
          'div',
          { class: 'q-answer' },
          h('div', {}, h('strong', {}, `[${part.marks}] `), part.model_answer),
          part.marking_points.length ? h('ul', {}, part.marking_points.map((point) => h('li', {}, point))) : null
        )
      : null
  );
}

// A scenario can list observations as "- " lines; show those as bullets.
function renderScenario(text) {
  const blocks = [];
  let list = null;
  for (const line of text.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const bullet = /^[-•]\s+/.exec(line);
    if (bullet) {
      if (!list) blocks.push((list = h('ul', { class: 'q-bullets' })));
      list.append(h('li', {}, line.slice(bullet[0].length)));
    } else {
      list = null;
      blocks.push(h('p', { class: 'q-scenario' }, line));
    }
  }
  return blocks;
}

function renderQuestion(question, paper, showAnswers) {
  const heading = [`Q${question.number}.`, question.title].filter(Boolean).join(' ');
  return h(
    'div',
    { class: 'paper-question' },
    h('div', { class: 'q-head' }, h('strong', {}, heading), ` [${paper.labels.total_marks}: ${question.marks}]`),
    renderScenario(question.scenario),
    h('ol', { class: `q-parts${question.components ? ' components' : ''}` }, question.parts.map((part) => renderPart(part, question, paper, showAnswers)))
  );
}

export async function renderGeneratedPaper(root, id) {
  const record = await generatorApi.get(id);
  const { paper } = record;
  let showAnswers = false;

  // Each section is its own one-hour paper with its own heading, as in the
  // programme's papers, and starts on a new page when printed.
  const sheets = h('div', { class: 'paper-sheets' });
  const renderSheet = (section) =>
    h(
      'article',
      { class: 'paper-sheet', lang: paper.lang, dir: paper.rtl ? 'rtl' : null },
      printFrame(
        null,
        h(
          'header',
          { class: 'paper-head' },
          h(
            'div',
            { class: 'paper-brand' },
            paper.school_logo ? h('img', { class: 'school-mark', src: `/uploads/${paper.school_logo}`, alt: paper.school_name ?? '' }) : h('span', {}),
            paper.school_name ? h('div', { class: 'paper-school', lang: 'en', dir: 'ltr' }, paper.school_name) : h('span', {}),
            upschoolLogo()
          ),
          h('h2', {}, section.title),
          h(
            'p',
            { class: 'paper-meta' },
            h('span', {}, `${paper.labels.total_marks}: ${section.marks}`),
            h('span', {}, `${paper.labels.time}: ${paper.labels.one_hour}`)
          )
        ),
        h(
          'section',
          { class: 'paper-section' },
          h('h3', {}, `${section.heading} (${section.marks} ${paper.labels.marks})`),
          section.questions.map((question) => renderQuestion(question, paper, showAnswers))
        )
      )
    );
  const draw = () => mount(sheets, paper.sections.map(renderSheet));
  draw();

  const answersButton = h('button', { class: 'btn' }, 'Show answer key');
  answersButton.addEventListener('click', () => {
    showAnswers = !showAnswers;
    answersButton.textContent = showAnswers ? 'Hide answer key' : 'Show answer key';
    draw();
  });

  const remove = async () => {
    if (!confirmAction(`Delete "${paper.title}"? This cannot be undone.`)) return;
    try {
      await generatorApi.remove(record.id);
      toast('Paper deleted.', 'success');
      window.navigate('/generator');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  mount(
    root,
    h('div', { class: 'breadcrumb no-print' }, h('a', { href: '#/generator' }, 'Assessment generator'), ' / ', paper.title),
    h(
      'div',
      { class: 'page-head no-print' },
      h(
        'div',
        {},
        h('h1', {}, [record.subject, paper.level].filter(Boolean).join(', ')),
        h('p', {}, `Generated ${formatDate(record.created_at)} in ${paper.language}. Each section prints as its own one-hour paper, with or without the answer key.`)
      ),
      h('div', { class: 'page-actions' }, answersButton, h('button', { class: 'btn btn-primary', onclick: () => window.print() }, 'Print'), h('button', { class: 'btn btn-danger', onclick: remove }, 'Delete'))
    ),
    paper.shortfall?.length ? h('div', { class: 'notice no-print' }, `Gemini left gaps in this paper: ${paper.shortfall.join('; ')}. Generate it again for a complete paper.`) : null,
    sheets
  );
}
