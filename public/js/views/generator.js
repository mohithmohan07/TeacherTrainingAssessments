import { h, mount, toast, confirmAction, formatDate, field, input, textarea, select, emptyState } from '../ui.js';
import { generatorApi } from '../api.js';

const FOCUS_LABELS = {
  both: 'Subject knowledge and teaching practice',
  subject: 'Subject knowledge',
  pedagogy: 'Teaching practice',
};

function sectionRow(section, types, onChange) {
  const cell = (control) => h('td', {}, control);
  const name = h('input', { type: 'text', value: section.name, maxlength: 4, style: 'width:56px' });
  const title = h('input', { type: 'text', value: section.title });
  const type = select('type', Object.entries(types).map(([value, label]) => ({ value, label: label.split(' (')[0] })), { value: section.type, id: '' });
  const count = h('input', { type: 'number', min: 0, max: 30, value: section.count, style: 'width:80px' });
  const marks = h('input', { type: 'number', min: 0.5, max: 100, step: 0.5, value: section.marks, style: 'width:80px' });

  const row = h('tr', {}, cell(name), cell(title), cell(type), cell(count), cell(marks));
  row.read = () => ({ name: name.value, title: title.value, type: type.value, count: count.value, marks: marks.value });
  for (const control of [name, title, type, count, marks]) control.addEventListener('input', onChange);
  return row;
}

export async function renderGenerator(root) {
  const [config, papers] = await Promise.all([generatorApi.config(), generatorApi.list()]);

  const totalLine = h('p', { class: 'hint', style: 'margin:10px 0 0' });
  const rows = [];
  const updateTotal = () => {
    const total = rows.reduce((sum, row) => {
      const { count, marks } = row.read();
      return sum + (Number(count) || 0) * (Number(marks) || 0);
    }, 0);
    const questions = rows.reduce((sum, row) => sum + (Number(row.read().count) || 0), 0);
    totalLine.textContent = `${questions} questions, ${total} marks in total.`;
  };
  for (const section of config.sections) rows.push(sectionRow(section, config.question_types, updateTotal));
  updateTotal();

  const form = h(
    'form',
    {},
    h(
      'div',
      { class: 'form-grid' },
      field('Subject', input('subject', { placeholder: 'e.g. Mathematics', required: true })),
      field('Grade the teachers teach', input('grade', { placeholder: 'e.g. Grade 6' })),
      field(
        'Focus',
        select('focus', config.focus_options.map((value) => ({ value, label: FOCUS_LABELS[value] ?? value })), { value: 'both' })
      ),
      field('Paper title', input('title', { placeholder: 'Left blank, Gemini suggests one' })),
      field('Topics', textarea('topics', { placeholder: 'One topic per line, e.g.\nFractions and decimals\nRatio and proportion' }), { span: true }),
      field('Anything else Gemini should know', textarea('instructions', { placeholder: 'Optional, e.g. use examples from everyday Indian life' }), { span: true })
    ),
    h('h3', { style: 'margin:22px 0 8px;font-size:15px' }, 'Sections'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'sections-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Section'), h('th', {}, 'Title'), h('th', {}, 'Question type'), h('th', {}, 'Questions'), h('th', {}, 'Marks each'))),
        h('tbody', {}, rows)
      )
    ),
    totalLine
  );

  const button = h('button', { type: 'submit', class: 'btn btn-primary', disabled: !config.configured }, 'Generate paper');
  const status = h('span', { class: 'hint' });
  form.append(h('div', { class: 'form-actions' }, button, status));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    status.textContent = 'Gemini is writing the paper. This can take up to a minute…';
    try {
      const paper = await generatorApi.generate({ ...data, sections: rows.map((row) => row.read()) });
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
            h('thead', {}, h('tr', {}, h('th', {}, 'Paper'), h('th', {}, 'Subject'), h('th', {}, 'Grade'), h('th', { class: 'right' }, 'Marks'), h('th', {}, 'Created'))),
            h(
              'tbody',
              {},
              papers.map((paper) =>
                h(
                  'tr',
                  { style: 'cursor:pointer', onclick: () => window.navigate(`/generator/${paper.id}`) },
                  h('td', {}, paper.title),
                  h('td', {}, paper.subject),
                  h('td', {}, paper.grade || '—'),
                  h('td', { class: 'right' }, paper.total_marks),
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
      h('div', {}, h('h1', {}, 'Assessment generator'), h('p', {}, 'Write a new assessment paper with Gemini, laid out in Sections A, B and C.'))
    ),
    notice,
    h('div', { class: 'card' }, h('h2', {}, 'New paper'), h('p', { class: 'hint' }, 'Describe what the paper should cover and how each section is laid out.'), form),
    history
  );
}

function renderQuestion(question, showAnswers) {
  const letters = 'abcdef';
  return h(
    'li',
    { class: 'paper-question', value: question.number },
    h('div', { class: 'q-line' }, h('span', { class: 'q-text' }, question.text), h('span', { class: 'q-marks' }, `[${question.marks}]`)),
    question.options.length
      ? h('ol', { class: 'q-options' }, question.options.map((option, index) => h('li', {}, h('span', { class: 'sr-letter' }, `(${letters[index]}) `), option)))
      : null,
    showAnswers
      ? h(
          'div',
          { class: 'q-answer' },
          h('strong', {}, 'Answer: '),
          question.answer,
          question.marking_points.length ? h('ul', {}, question.marking_points.map((point) => h('li', {}, point))) : null
        )
      : null
  );
}

export async function renderGeneratedPaper(root, id) {
  const record = await generatorApi.get(id);
  const { paper } = record;
  let showAnswers = false;

  const sheet = h('article', { class: 'paper-sheet' });
  const draw = () =>
    mount(
      sheet,
      h('header', { class: 'paper-head' }, h('h2', {}, paper.title), h('p', {}, [record.subject, record.grade].filter(Boolean).join(' · '), ` · Total marks: ${paper.total_marks}`)),
      paper.instructions ? h('p', { class: 'paper-instructions' }, paper.instructions) : null,
      paper.sections
        .filter((section) => section.questions.length)
        .map((section) =>
          h(
            'section',
            { class: 'paper-section' },
            h(
              'h3',
              {},
              `Section ${section.name}: ${section.title}`,
              h('span', { class: 'q-marks' }, `${section.questions.length} × ${section.marks_each} = ${section.questions.length * section.marks_each} marks`)
            ),
            section.instructions ? h('p', { class: 'paper-instructions' }, section.instructions) : null,
            h('ol', { class: 'paper-questions', start: section.questions[0].number }, section.questions.map((question) => renderQuestion(question, showAnswers)))
          )
        )
    );
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
      h('div', {}, h('h1', {}, paper.title), h('p', {}, `Generated ${formatDate(record.created_at)}. Print it with or without the answer key.`)),
      h('div', { class: 'page-actions' }, answersButton, h('button', { class: 'btn btn-primary', onclick: () => window.print() }, 'Print'), h('button', { class: 'btn btn-danger', onclick: remove }, 'Delete'))
    ),
    paper.shortfall?.length ? h('div', { class: 'notice no-print' }, `Gemini wrote fewer questions than asked: ${paper.shortfall.join('; ')}.`) : null,
    sheet
  );
}
