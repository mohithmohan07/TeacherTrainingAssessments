// The reports written from the marks: a teacher's own report and the
// management report on that teacher (one page, two versions), and the school
// report on all of a school's teachers. Each is short and in plain words, with
// bar charts of the scores; the school report adds a pie chart and splits the
// figures by school stage, Pre-Primary to PUC. Each prints on its own, with
// the school's logo at the top of every page and UpSchool's at the foot. The
// management reports carry a training plan when growth paths are set up, and
// a teacher's reports end with the marks for every question, then what the
// teacher answered and what should have been answered, question by question,
// then the question paper and the answer paper as evidence. Both of a
// teacher's reports also show Written Expression: a score per section for
// how well the answers are written, and the errors found.
import { h, mount, toast, formatDate, logoFor, potentialBadge, emptyState, titleCase, upschoolLogo, printFrame, openLightbox } from '../ui.js';
import { reportsApi } from '../api.js';
import { donut, legend, scoreBar, stackedBar } from '../charts.js';
import { keepOnly, pagesOf } from '../evidence.js';
import { checkedSections, levelClass, writingSection } from '../writing.js';

const SECTION_KEYS = ['A', 'B', 'C'];

// The layout the server writes reports in (LAYOUT in server/reports.js). A
// report in an earlier layout is not shown; the page asks for a rebuild.
const LAYOUT = 2;
const writtenContent = (report) => (report?.content?.layout === LAYOUT ? report.content : null);

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
    return h('div', { class: 'marking-state no-print' }, h('span', { class: 'spinner' }), `OpenAI is writing ${what}. This usually takes a minute or two; you can leave this page and come back.`);
  }
  if (report.status === 'failed') {
    return h('div', { class: 'marking-state error no-print' }, report.error || 'The report could not be written.', ' ', building);
  }
  if (report.old_layout) {
    return h('div', { class: 'notice no-print' }, 'This report was written in the earlier, longer layout. Rebuild it to get the simpler one. ', building);
  }
  if (report.no_writing && !report.no_answers) {
    return h('div', { class: 'notice no-print' }, 'This report was written before reports showed Written Expression. Rebuild it to add the writing score and its errors. ', building);
  }
  if (report.old_words && !report.no_answers && !report.no_writing) {
    return h('div', { class: 'notice no-print' }, 'This report was written before reports used plain words that make sense without the question paper. Rebuild it to get them. ', building);
  }
  if (report.no_answers) {
    return h('div', { class: 'notice no-print' }, 'This report was written before reports showed what the teacher answered and what should have been answered for each question. Rebuild it to add them. ', building);
  }
  if (report.stale) {
    return h('div', { class: 'notice no-print' }, 'Marks have changed or new sections have been evaluated since this report was written. Rebuild it to take them in. ', building);
  }
  return null;
}

const bullets = (items) => (items?.length ? h('ul', {}, items.map((item) => h('li', {}, item))) : null);
const numbered = (items, render) => (items?.length ? h('ol', { class: 'report-points' }, items.map((item) => h('li', {}, render(item)))) : null);
// "Checking Understanding. In Section A…"
const point = (p) => [p.title ? h('strong', {}, `${titleCase(p.title.replace(/[.:]$/, ''))}. `) : null, p.detail ?? ''];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listing = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const marks = (n) => String(Math.round(Number(n) * 100) / 100);
const share = (n, total) => (total ? Math.round((100 * n) / total) : 0);
const gradeChip = (s) => (s.grade ? h('span', { class: `grade-chip grade-${s.grade}` }, `${s.grade} · ${s.grade_label}`) : '—');

// "Lenient marking: questions not attempted are left out of the marks and
// the total. Left out: Section B, 2 questions worth 5 marks." Only when a
// section was marked leniently.
function lenientKey(sections, { forTeacher = false } = {}) {
  const lenient = sections.filter((s) => s.marking === 'lenient');
  if (!lenient.length) return null;
  const nameOf = (s) => s.title || titleCase(s.name);
  const which = lenient.filter((s) => s.left_out).map((s) => `${nameOf(s)}, ${plural(s.left_out, 'question')} worth ${marks(s.left_out_marks)} marks`);
  return h(
    'p',
    { class: 'report-note' },
    h('strong', {}, 'Lenient marking: '),
    forTeacher ? 'only the questions you answered are counted; questions you left blank are not in your marks or the total' : 'only the questions answered are counted; questions left blank are not in the marks or the total',
    lenient.length < sections.length ? ` in ${listing(lenient.map(nameOf))}.` : '.',
    which.length ? ` Not counted: ${which.join('; ')}.` : ' Every question was answered, so nothing is left out.'
  );
}

// Each section's result as a bar on the grade bands. Sections of the
// programme the teacher has not taken yet are listed too.
function resultsTable(sections, { grades, section_titles: titles = {} }, { forTeacher = false } = {}) {
  // Written Expression gets a column once any section has been checked. Its
  // score leads to the errors further down.
  const writing = checkedSections(sections).length > 0;
  const toErrors = () => document.getElementById('written-expression')?.scrollIntoView({ behavior: 'smooth' });
  const writingCell = (s) => {
    const w = s.writing;
    if (!w?.checked) return h('td', { class: 'hint' }, '—');
    if (!w.judged) return h('td', { class: 'hint' }, 'Too little writing');
    return h(
      'td',
      { class: 'nowrap' },
      h('span', { class: `writing-score ${levelClass(w)}`, role: 'link', title: 'See the errors', onclick: toErrors }, `${w.score} / 10`),
      h('div', { class: 'hint' }, w.level)
    );
  };
  const sectioned = sections.length > 0 && sections.every((s) => SECTION_KEYS.includes(s.key));
  const notTaken = sectioned ? SECTION_KEYS.filter((key) => !sections.some((s) => s.key === key)) : [];
  return [h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'report-table results-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Section'), h('th', { class: 'right' }, 'Marks'), h('th', { class: 'score-col' }, 'Percentage'), h('th', {}, 'Grade'), writing ? h('th', {}, 'Written Expression') : null)),
      h(
        'tbody',
        {},
        sections.map((s) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', {}, titleCase(s.name)), s.title ? h('div', { class: 'hint' }, s.title) : null, s.date ? h('div', { class: 'hint' }, `Taken ${formatDate(s.date)}`) : null),
            h('td', { class: 'right nowrap' }, `${marks(s.awarded)} / ${marks(s.max)}`, s.marking === 'lenient' ? h('div', { class: 'hint' }, 'Answered questions only') : null),
            h('td', { class: 'score-col' }, scoreBar(s.percent, grades, { label: s.name })),
            h('td', {}, gradeChip(s)),
            writing ? writingCell(s) : null
          )
        ),
        notTaken.map((key) =>
          h(
            'tr',
            { class: 'not-taken' },
            h('td', {}, h('strong', {}, `Section ${key}`), titles[key] ? h('div', { class: 'hint' }, titles[key]) : null),
            h('td', { class: 'hint', colspan: writing ? 4 : 3 }, 'Not taken yet')
          )
        )
      )
    )
  ), lenientKey(sections, { forTeacher })];
}

// One printed report: the school's letterhead (at the top of every printed
// page), the report's title and details, its body, and UpSchool's footer (at
// the foot of every printed page).
function reportSheet({ school, audience, title, details }, ...body) {
  return h(
    'article',
    { class: 'report-sheet' },
    printFrame(
      h(
        'header',
        { class: 'report-letterhead' },
        logoFor(school),
        h('div', {}, h('div', { class: 'report-programme' }, 'Teacher Training Assessment'), h('div', { class: 'report-school-name' }, school.name))
      ),
      h(
        'div',
        { class: 'report-title-block' },
        audience ? h('p', { class: 'report-audience' }, audience) : null,
        h('h1', { class: 'report-title' }, title),
        detailsList(details)
      ),
      body
    ),
    h('footer', { class: 'report-footer' }, h('span', {}, 'Report generated by'), upschoolLogo())
  );
}

// Who and what the report is about, in a row under its title.
function detailsList(pairs) {
  const shown = pairs.filter(([, value]) => value);
  return shown.length ? h('dl', { class: 'report-details' }, shown.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))) : null;
}

const teacherDetails = (teacher, test, report) => [
  ['Teacher', teacher.name],
  ['Teaches', [teacher.grade, teacher.subjects].filter(Boolean).join(' · ')],
  ['Test', test.name],
  ['Report Date', formatDate(report?.written_at)],
];

// "A Excellent, 85% and above · B Good, 70–84% · …"
function gradeKey(grades) {
  const bands = [...grades].sort((a, b) => b.min - a.min);
  const range = (g, i) => (i === 0 ? `${g.min}% and above` : g.min === 0 ? `below ${bands[i - 1].min}%` : `${g.min}–${bands[i - 1].min - 1}%`);
  return h(
    'p',
    { class: 'report-key' },
    h('strong', {}, 'Grades: '),
    bands.map((g, i) => `${g.grade} ${g.label}, ${range(g, i)}`).join(' · '),
    '. Each section gets its own grade; there is no overall percentage.'
  );
}

/* ---------------------------------------------------- marks for every question */

// The questions behind each section: from the report when it kept them, so a
// printed report shows the marks it was written from, otherwise as marked now.
// Reports written before Written Expression take it from the results too.
function withQuestions(sections, live) {
  return sections.map((s) => {
    const now = live.find((l) => l.key === s.key);
    return {
      ...s,
      questions: s.questions ?? now?.questions ?? [],
      writing: 'writing' in s ? s.writing : now?.writing ?? null,
    };
  });
}

const isBlank = (q) => q.blank ?? (!String(q.teacher_answer ?? '').trim() && !(Number(q.marks_awarded) > 0));
// Lenient marking leaves the questions not attempted out of the totals.
const notCounted = (q) => q.counted === false;
const markTone = (q) => (notCounted(q) ? 'q-skip' : q.max_marks > 0 && q.marks_awarded >= q.max_marks ? 'q-full' : q.marks_awarded > 0 ? 'q-part' : 'q-none');
const questionLabel = (q) => q.question || '—';

// The marks for every question as one grid, a row per question and a column
// per section, when the sections share their numbering as the programme's
// papers do; otherwise a small table per section, side by side.
function marksGrid(sections) {
  const shown = sections.filter((s) => s.questions?.length);
  if (!shown.length) return null;
  const labels = [...new Set(shown.flatMap((s) => s.questions.map(questionLabel)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const shared = labels.filter((l) => shown.filter((s) => s.questions.some((q) => questionLabel(q) === l)).length > 1);
  const unique = shown.every((s) => new Set(s.questions.map(questionLabel)).size === s.questions.length);
  const cell = (q) =>
    q
      ? [h('span', { class: `q-marks ${markTone(q)}` }, `${marks(q.marks_awarded)} / ${marks(q.max_marks)}`), isBlank(q) ? h('span', { class: 'q-blank' }, notCounted(q) ? 'not counted' : 'blank') : null]
      : h('span', { class: 'hint' }, '—');
  const total = (s) => h('strong', {}, `${marks(s.awarded)} / ${marks(s.max)}`);

  if (unique && (shown.length === 1 || shared.length * 2 >= labels.length)) {
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table marks-grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Question'), shown.map((s) => h('th', {}, titleCase(s.name))))),
        h(
          'tbody',
          {},
          labels.map((l) => h('tr', {}, h('td', {}, h('strong', {}, l)), shown.map((s) => h('td', {}, cell(s.questions.find((q) => questionLabel(q) === l)))))),
          h('tr', { class: 'total-row' }, h('td', {}, h('strong', {}, 'Total')), shown.map((s) => h('td', {}, total(s))))
        )
      )
    );
  }
  return h(
    'div',
    { class: 'marks-grids' },
    shown.map((s) =>
      h(
        'table',
        { class: 'report-table marks-grid' },
        h('thead', {}, h('tr', {}, h('th', {}, titleCase(s.name)), h('th', {}, 'Marks'))),
        h(
          'tbody',
          {},
          s.questions.map((q) => h('tr', {}, h('td', {}, h('strong', {}, questionLabel(q))), h('td', {}, cell(q)))),
          h('tr', { class: 'total-row' }, h('td', {}, h('strong', {}, 'Total')), h('td', {}, total(s)))
        )
      )
    )
  );
}

function marksSection(sections, { forTeacher }) {
  const grid = marksGrid(sections);
  if (!grid) return null;
  const all = sections.flatMap((s) => s.questions ?? []);
  const blanks = all.filter((q) => isBlank(q) && !notCounted(q));
  const skipped = all.filter(notCounted);
  const worth = (list) => marks(list.reduce((sum, q) => sum + (Number(q.max_marks) || 0), 0));
  return h(
    'section',
    { class: 'report-marks' },
    h('h2', {}, 'Marks for Every Question'),
    h(
      'p',
      { class: 'report-note' },
      h('span', { class: 'q-marks q-full' }, 'Full marks'),
      ' ',
      h('span', { class: 'q-marks q-part' }, 'Some marks'),
      ' ',
      h('span', { class: 'q-marks q-none' }, 'No marks'),
      skipped.length ? [' ', h('span', { class: 'q-marks q-skip' }, 'Not counted')] : null,
      blanks.length
        ? ` ${forTeacher ? `You left ${plural(blanks.length, 'question')}` : `${plural(blanks.length, 'question')} ${blanks.length === 1 ? 'was' : 'were'} left`} blank, worth ${worth(blanks)} marks.`
        : '',
      skipped.length
        ? ` ${plural(skipped.length, 'question')} ${forTeacher ? 'you did not attempt' : 'not attempted'}, worth ${worth(skipped)} marks, ${skipped.length === 1 ? 'is' : 'are'} not counted (lenient marking).`
        : ''
    ),
    grid
  );
}

/* ------------------------------------------- answers, question by question */

const expectedOf = (q) => String(q.expected_answer ?? '').trim();
const answerCount = (sections) => sections.flatMap((s) => s.questions ?? []).filter((q) => expectedOf(q)).length;

// What the teacher answered beside what should have been answered, for every
// question, in a table per section. A report written since reports showed it
// always has it, and so do results whose marking says what should have been
// answered. A question where that could not be worked out shows the
// examiner's feedback instead.
function answersSection(sections, { forTeacher, written = false }) {
  const shown = sections.filter((s) => s.questions?.length);
  if (!shown.length || (!written && !answerCount(shown))) return null;
  const answered = forTeacher ? 'What You Answered' : 'What the Teacher Answered';
  const expected = 'What Should Have Been Answered';
  const theirs = (q) => {
    if (isBlank(q)) return h('span', { class: 'answer-blank' }, notCounted(q) ? 'Left blank (not counted)' : 'Left blank');
    return q.teacher_answer ? h('div', { class: 'answer-text', dir: 'auto' }, q.teacher_answer) : h('span', { class: 'hint' }, '—');
  };
  const model = (q) => {
    if (expectedOf(q)) return h('div', { class: 'answer-text', dir: 'auto' }, expectedOf(q));
    return q.feedback ? [h('span', { class: 'hint' }, 'Examiner’s note: '), q.feedback] : h('span', { class: 'hint' }, '—');
  };
  return h(
    'section',
    { class: 'report-answers' },
    h('h2', {}, 'Question by Question', h('small', {}, forTeacher ? 'What you answered, and what should have been answered' : 'What the teacher answered, and what should have been answered')),
    shown.map((s) =>
      h(
        'div',
        { class: 'answers-block' },
        h('h3', {}, titleCase(s.name), s.title ? h('span', { class: 'answers-title' }, s.title) : null),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'report-table answers-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Question'), h('th', {}, answered), h('th', {}, expected))),
            h(
              'tbody',
              {},
              s.questions.map((q) =>
                h(
                  'tr',
                  {},
                  h(
                    'td',
                    { class: 'answer-q' },
                    h('div', { class: 'answer-q-head' }, h('strong', {}, questionLabel(q)), h('span', { class: `q-marks ${markTone(q)}` }, `${marks(q.marks_awarded)} / ${marks(q.max_marks)}`)),
                    q.question_text ? h('div', { class: 'answer-asked', dir: 'auto' }, q.question_text) : null
                  ),
                  h('td', { 'data-label': answered }, theirs(q)),
                  h('td', { 'data-label': expected }, model(q))
                )
              )
            )
          )
        )
      )
    )
  );
}

// When what should have been answered could not be worked out for some
// questions of a written report: which, and why. Screen only.
function answersNotice(content, sections, rebuild) {
  if (!content?.answers) return null;
  const missing = sections.flatMap((s) => s.questions ?? []).filter((q) => !expectedOf(q)).length;
  if (!missing) return null;
  const problems = content.answers_problems ?? [];
  return h(
    'div',
    { class: 'notice no-print' },
    `What should have been answered could not be worked out for ${plural(missing, 'question')}, so the examiner’s note is shown for ${missing === 1 ? 'it' : 'them'}. `,
    problems.length ? `${problems.join(' ')} ` : '',
    rebuild
  );
}

/* ------------------------------------------------------------- evidence */

// Scans in a type browsers cannot show. They are noted in the report instead.
const UNSHOWN_TYPES = new Set(['image/tiff']);

// "Section A", "Sections A and B", or the parts' own names.
function partsNamed(sections) {
  const keys = sections.map((s) => s.key);
  return keys.length > 1 && keys.every((key) => /^[A-Z]$/.test(key)) ? `Sections ${listing(keys)}` : listing(sections.map((s) => titleCase(s.name)));
}

// A sitting's papers in the order they print: the question paper (papers
// confirmed from the library, then any scanned pages), then the answer paper.
// A library paper is named by its sections only when the sitting has several.
function sittingDocuments(sitting) {
  const several = sitting.papers.length > 1;
  return [
    ...sitting.papers.map((paper) => ({
      name: 'Question Paper',
      part: several && paper.sections.length ? partsNamed(paper.sections.map((key) => ({ key, name: `Section ${key}` }))) : '',
      files: [{ url: paper.url, pdf: true }],
    })),
    sitting.question_paper.length ? { name: 'Question Paper', part: sitting.papers.length ? 'Scanned' : '', files: sitting.question_paper } : null,
    sitting.response.length ? { name: 'Answer Paper', part: '', files: sitting.response } : null,
  ].filter(Boolean);
}

// One page of a paper: small on screen, a click shows it larger; a printed
// page of its own, captioned with what it is.
function evidencePage(page, { doc, index, total, sitting, lead }) {
  const name = doc.part ? `${doc.name}, ${doc.part}` : doc.name;
  const alt = `${name}, page ${index} of ${total}`;
  return h(
    'figure',
    { class: `evidence-page${lead ? ' evidence-lead' : ''}` },
    page.src
      ? h('button', { class: 'evidence-thumb', type: 'button', title: 'See this page larger', onclick: () => openLightbox(page.original ?? page.src, alt) }, h('img', { src: page.src, alt }))
      : h('div', { class: 'evidence-missing' }, page.note),
    h('figcaption', {}, h('span', { class: 'evidence-context' }, `${name} · `), `Page ${index} of ${total}`, h('span', { class: 'evidence-context' }, ` · ${sitting}`))
  );
}

// Makes a paper's pages and puts them in its box, ready to print.
async function fillDocument(box, doc, sitting, lead) {
  const results = await Promise.allSettled(
    doc.files.map((file) => (UNSHOWN_TYPES.has(file.type) ? Promise.reject(new Error('unshown')) : pagesOf(file)))
  );
  const pages = results.flatMap((result, i) => {
    const file = doc.files[i];
    if (result.status === 'fulfilled') return result.value.map((src) => ({ src, original: file.pdf ? null : file.url }));
    if (UNSHOWN_TYPES.has(file.type)) return [{ note: 'This page is a TIFF file, which a report cannot show. Upload it again as a JPG or PNG to show it here.' }];
    console.error(`Could not show ${file.url}:`, result.reason);
    return [{ note: file.pdf ? 'The question paper could not be shown.' : 'This page could not be shown.' }];
  });
  if (!box.isConnected) return;
  mount(box, pages.map((page, i) => evidencePage(page, { doc, index: i + 1, total: pages.length, sitting, lead: lead && i === 0 })));
  // Loaded, not decoded: decoding every page at full size would only hold
  // memory the printing does not need.
  const loaded = (img) =>
    img.complete ||
    new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  await Promise.all([...box.querySelectorAll('img')].map(loaded));
}

// The papers the marks came from, at the end of a teacher's reports: for each
// sitting behind the sections shown, the question paper and the teacher's
// answer paper. `ready` settles, and data-evidence turns "ready", once every
// page is in place.
function evidenceSection(sections, evidence, { forTeacher }) {
  const sittings = (evidence ?? [])
    .map((sitting) => ({ sitting, shown: sections.filter((s) => s.assessment_id === sitting.assessment_id), docs: sittingDocuments(sitting) }))
    .filter(({ shown, docs }) => shown.length && docs.length);
  if (!sittings.length) return null;

  const filling = [];
  const blocks = sittings.map(({ sitting, shown, docs }, n) => {
    const label = [partsNamed(shown), sitting.date ? `taken ${formatDate(sitting.date)}` : ''].filter(Boolean).join(', ');
    return h(
      'div',
      { class: 'evidence-sitting' },
      h('h3', {}, partsNamed(shown), sitting.date ? h('span', { class: 'answers-title' }, `Taken ${formatDate(sitting.date)}`) : null),
      docs.map((doc, d) => {
        const box = h('div', { class: 'evidence-pages' }, h('p', { class: 'hint' }, 'Preparing the pages…'));
        filling.push(fillDocument(box, doc, label, n === 0 && d === 0));
        return h('div', { class: 'evidence-doc' }, h('h4', {}, doc.part ? `${doc.name}, ${doc.part}` : doc.name), box);
      })
    );
  });

  const section = h(
    'section',
    { class: 'report-evidence', 'data-evidence': 'loading' },
    h('h2', {}, 'Evidence', h('small', {}, forTeacher ? 'The question paper and your answer paper' : 'The question paper and the teacher’s answer paper')),
    h('p', { class: 'report-note no-print' }, 'Each page prints on a page of its own. Click a page to see it larger.'),
    blocks
  );
  section.ready = Promise.allSettled(filling).then(() => {
    section.dataset.evidence = 'ready';
  });
  return section;
}

const evidenceUrls = (evidence) => (evidence ?? []).flatMap((s) => [...s.papers, ...s.question_paper, ...s.response].map((file) => file.url));

// Prints once the evidence pages are in place, so none prints half made.
async function printWhenReady(container, button) {
  const pending = [...container.querySelectorAll('.report-evidence[data-evidence="loading"]')];
  if (pending.length) {
    button.disabled = true;
    button.textContent = 'Preparing pages…';
    await Promise.all(pending.map((section) => section.ready));
    button.disabled = false;
    button.textContent = 'Print';
    if (!button.isConnected) return;
  }
  window.print();
}

/* ------------------------------------------------------------- training */

const dayRange = (b) => (b.from === b.to ? `Day ${b.from}` : `Days ${b.from}–${b.to}`);
const dayNumbers = (b) => (b.from === b.to ? `${b.from}` : `${b.from}–${b.to}`);
// Each section keeps its colour across the plan; the shared blocks have their own.
const toneOf = (b) => (b.kind === 'section' ? `tone-${b.key || 'paper'}` : `tone-${b.kind}`);
// A section's block by the section's name, such as "Computer Knowledge &
// Digital Teaching Skills", so the plan reads without the paper.
const shortTitle = (b) => (b.kind === 'section' ? b.title.split(': ').slice(1).join(': ') || b.title : b.title);

// What the report says about training when the growth paths are missing or
// have changed since it was written. Screen only.
function trainingNotice(state, written, rebuild) {
  if (!state.set) {
    return h('div', { class: 'notice no-print' }, 'To recommend training in this report, add UpSchool’s growth paths on the ', h('a', { href: '#/training' }, 'Training paths'), ' page, then rebuild it.');
  }
  if (!written) return null;
  if (!written.training) return h('div', { class: 'notice no-print' }, 'This report was written before the growth paths were added, so it has no training plan. ', rebuild);
  if (written.training.version !== state.version) return h('div', { class: 'notice no-print' }, 'The growth paths have changed since this report was written. Rebuild it to bring the training plan up to date. ', rebuild);
  return null;
}

// The training the plan recommends, in one line under the summary.
function trainingLine(plan) {
  if (!plan) return null;
  return h(
    'p',
    { class: 'report-callout' },
    h('strong', {}, 'Training Suggested: '),
    plan.path ? `${plural(plan.days, 'day')} of training with UpSchool (${plan.path.name}), on the areas that need help. The plan is below.` : 'None needed: Grade B (Good) or better in every section taken.',
    plan.partial ? h('span', { class: 'hint' }, ` ${plan.partial}`) : null
  );
}

function dayStrip(plan) {
  return h(
    'div',
    { class: 'day-strip-wrap' },
    h(
      'div',
      { class: 'day-strip', style: `grid-template-columns: repeat(${plan.days}, minmax(0, 1fr))` },
      plan.blocks.flatMap((b) => Array.from({ length: b.days }, (_, i) => h('span', { class: `day ${toneOf(b)}`, title: b.title }, b.from + i)))
    ),
    h('div', { class: 'day-legend' }, plan.blocks.map((b) => h('span', {}, h('i', { class: toneOf(b) }), h('strong', {}, dayRange(b)), ` ${shortTitle(b)}`)))
  );
}

// The plan of action for one teacher: the days, what is worked on in them,
// how UpSchool's team runs them, and the findings they answer.
function planSection(plan) {
  if (!plan?.path) return null;
  return h(
    'section',
    { class: 'report-plan' },
    h('h2', {}, `${plan.days}-Day Training Plan`, h('small', {}, plan.path.name)),
    plan.order ? h('p', {}, plan.order) : null,
    dayStrip(plan),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table plan-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Days'), h('th', {}, 'What the Teacher Learns'), h('th', {}, 'How UpSchool Runs It'), h('th', {}, 'Helps With'))),
        h(
          'tbody',
          {},
          plan.blocks.map((b) =>
            h(
              'tr',
              {},
              h('td', { class: 'nowrap' }, h('span', { class: `plan-block-days ${toneOf(b)}` }, dayNumbers(b))),
              h('td', {}, h('strong', {}, shortTitle(b)), b.works_on ? h('div', {}, b.works_on) : null),
              h('td', {}, b.how || '—'),
              h('td', { class: 'nowrap' }, b.points?.length ? `${b.points.length === 1 ? 'Finding' : 'Findings'} ${listing(b.points.map(String))}` : '—')
            )
          )
        )
      )
    ),
    plan.partial ? h('p', { class: 'report-note' }, plan.partial) : null,
    plan.exit_assessment ? h('p', { class: 'report-note' }, h('strong', {}, 'Final Test: '), 'after the training, the teacher takes a test on the same areas, so the school can see how much they have improved.') : null,
    plan.continuity ? h('p', { class: 'report-note' }, h('strong', {}, 'After the Training: '), plan.continuity) : null
  );
}

/* ------------------------------------------------------ one teacher's reports */

export async function renderTeacherReport(root, teacherId, testId, query = new URLSearchParams()) {
  let data = await reportsApi.teacher(teacherId, testId);
  keepOnly(evidenceUrls(data.evidence));
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
    const content = writtenContent(report);
    const running = report?.status === 'running';
    const buildButton = h(
      'button',
      { class: `btn ${content ? '' : 'btn-primary'}`, type: 'button', disabled: running || !data.sections.length, onclick: build },
      running ? 'Writing…' : report?.content ? 'Rebuild report' : 'Build report'
    );
    const inlineBuild = h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report');
    const printButton = h('button', { class: 'btn btn-primary', type: 'button', disabled: !data.sections.length, onclick: () => printWhenReady(container, printButton) }, 'Print');

    const toggle = h(
      'div',
      { class: 'segmented' },
      [['teacher', 'For the Teacher'], ['management', 'For Management']].map(([value, label]) =>
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
      sheet = reportSheet(
        { school, audience: audience === 'teacher' ? 'For the Teacher' : 'For Management', title: 'Results So Far', details: teacherDetails(teacher, test, null) },
        resultsTable(data.sections, data),
        running || report?.content ? null : h('p', { class: 'hint no-print' }, 'The written report has not been built yet. Press Build report.'),
        marksSection(data.sections, { forTeacher: audience === 'teacher' }),
        gradeKey(data.grades),
        writingSection(data.sections, { forTeacher: audience === 'teacher' }),
        answersSection(data.sections, { forTeacher: audience === 'teacher' }),
        evidenceSection(data.sections, data.evidence, { forTeacher: audience === 'teacher' })
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
        h('div', {}, h('h1', {}, `${teacher.name}: Reports`), h('p', {}, `${test.name}${report?.written_at ? ` · written ${formatDate(report.written_at)}` : ''}`)),
        h('div', { class: 'page-actions' }, toggle, buildButton, printButton)
      ),
      reportState(report, { building: inlineBuild, what: `${teacher.name}’s reports` }),
      !running && content?.writing_problems?.length
        ? h('div', { class: 'notice no-print' }, `The writing could not be checked for ${content.writing_problems.join(' ')} `, h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report'))
        : null,
      !running && content ? answersNotice(content, withQuestions(content.sections, data.sections), h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report')) : null,
      audience === 'management' && !running ? trainingNotice(data.training, content, h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report')) : null,
      sheet
    );
  }

  draw();
  mount(root, container);
  watch();
}

function teacherSheet(data, content) {
  const { teacher, school, test, report } = data;
  const t = content.teacher;
  const sections = withQuestions(content.sections, data.sections);
  return reportSheet(
    { school, audience: 'For the Teacher', title: 'Teacher Report', details: teacherDetails(teacher, test, report) },
    h('h2', {}, 'Summary'),
    t.summary ? h('p', { class: 'report-lead' }, t.summary) : null,
    resultsTable(sections, data, { forTeacher: true }),
    t.went_well.length ? [h('h2', {}, 'What Went Well'), numbered(t.went_well, point)] : null,
    t.next_steps.length ? [h('h2', {}, 'Your Next Steps'), numbered(t.next_steps, point)] : null,
    t.practice_ideas.length ? [h('h2', {}, 'Ideas to Practise'), bullets(t.practice_ideas)] : null,
    marksSection(sections, { forTeacher: true }),
    gradeKey(data.grades),
    writingSection(sections, { forTeacher: true }),
    answersSection(sections, { forTeacher: true, written: Boolean(content.answers) }),
    evidenceSection(content.sections, data.evidence, { forTeacher: true })
  );
}

// The potential identifier, in a short box under the results.
function potentialBox(potential, aiRoles) {
  if (!potential) return null;
  // OpenAI's roles cite the answers; the rule-based ones are a fallback.
  const roles = aiRoles?.length ? aiRoles.map((r) => r.role) : potential.roles.map((r) => r.role.replace(/^\p{Ll}/u, (c) => c.toUpperCase()));
  return h(
    'div',
    { class: 'potential-box' },
    h('div', { class: 'potential-head' }, h('h3', {}, 'Strengths and Potential'), potentialBadge(potential)),
    h('p', {}, potential.meaning, ' ', h('span', { class: 'hint' }, potential.evidence)),
    roles.length ? h('p', { class: 'potential-areas' }, h('strong', {}, 'Could Take On: '), roles.map((r) => r.replace(/\.$/, '')).join('; '), '.') : null
  );
}

// What will be done: the plan's blocks of days when there is a plan,
// otherwise the support recommended.
function whatWeWillDo(plan, m) {
  if (plan?.path) {
    return [h('h3', {}, 'What We Will Do'), numbered(plan.blocks, (b) => [h('strong', {}, `${dayRange(b)}: `), b.summary || b.title])];
  }
  return m.support.length ? [h('h3', {}, 'What We Recommend'), bullets(m.support)] : null;
}

function managementSheet(data, content) {
  const { teacher, school, test, report } = data;
  const m = content.management;
  const plan = content.training;
  const sections = withQuestions(content.sections, data.sections);
  return reportSheet(
    { school, audience: 'For Management', title: 'Teacher Report', details: teacherDetails(teacher, test, report) },
    h('h2', {}, 'Summary'),
    m.summary ? h('p', { class: 'report-lead' }, m.summary) : null,
    trainingLine(plan),
    resultsTable(sections, data),
    potentialBox(content.potential, m.roles),
    m.findings.length ? [h('h3', {}, 'What We Found'), numbered(m.findings, (f) => point({ title: f.title, detail: f.summary }))] : null,
    whatWeWillDo(plan, m),
    m.school_needs.length ? [h('h3', {}, 'What We Need from the School'), bullets(m.school_needs)] : null,
    plan?.goal ? h('p', { class: 'report-callout' }, h('strong', {}, 'Goal for the Final Test: '), plan.goal) : null,
    planSection(plan),
    marksSection(sections, { forTeacher: false }),
    gradeKey(data.grades),
    writingSection(sections, { forTeacher: false }),
    answersSection(sections, { forTeacher: false, written: Boolean(content.answers) }),
    evidenceSection(content.sections, data.evidence, { forTeacher: false })
  );
}

/* ------------------------------------------------------------ the school report */

// The pie: how many teachers are on track, developing or need support.
function glance(figures, needs) {
  const whole = figures.whole;
  if (!whole?.teachers) return null;
  const slices = needs.map((n) => ({ key: n.key, label: n.label, value: whole.needs[n.key] ?? 0 }));
  return h(
    'div',
    { class: 'chart-block' },
    h('h3', {}, 'Teachers at a Glance'),
    h(
      'div',
      { class: 'glance' },
      donut(slices, { size: 132, total: whole.teachers, caption: whole.teachers === 1 ? 'teacher' : 'teachers' }),
      h(
        'table',
        { class: 'glance-table' },
        h(
          'tbody',
          {},
          needs.map((n) =>
            h(
              'tr',
              {},
              h('td', {}, h('i', { class: `swatch fill-${n.key}` })),
              h('td', {}, h('strong', {}, n.label), h('div', { class: 'hint' }, n.meaning)),
              h('td', { class: 'right glance-count' }, whole.needs[n.key] ?? 0),
              h('td', { class: 'right hint nowrap' }, `${share(whole.needs[n.key] ?? 0, whole.teachers)}%`)
            )
          )
        )
      )
    )
  );
}

const sectionHead = (key) => (key ? `Section ${key}` : 'Paper');

// Bar charts of each stage's average in every section, Pre-Primary to PUC,
// with the whole school below.
function stageTable(figures, keys, grades) {
  if (!figures.stage_stats?.length) return null;
  const row = (s, whole = false) =>
    h(
      'tr',
      { class: whole ? 'total-row' : null },
      h('td', {}, h('strong', {}, s.name), s.classes ? h('div', { class: 'hint' }, s.classes) : null),
      h('td', { class: 'right' }, s.teachers),
      keys.map((key) => h('td', { class: 'score-col' }, scoreBar(s.averages[key], grades, { label: `${s.name}, ${sectionHead(key)}` }))),
      h('td', { class: 'right nowrap' }, `${s.needs.support} of ${s.teachers}`)
    );
  return h(
    'div',
    { class: 'chart-block' },
    h('h3', {}, 'Average Score by Stage'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table stage-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', { class: 'right' }, 'Teachers'), keys.map((key) => h('th', { class: 'score-col' }, sectionHead(key))), h('th', { class: 'right' }, 'Needs More Support'))),
        h('tbody', {}, figures.stage_stats.map((s) => row(s)), row({ name: 'Whole School', classes: '', ...figures.whole }, true))
      )
    ),
    h('p', { class: 'report-key' }, 'Each bar is the average percentage of that stage’s teachers who took the section. The shading behind it marks the grades, D on the left to A on the right. “Needs More Support” counts teachers with any section at Grade D (Needs Practice).'),
    figures.stage_stats.some((s) => s.key === null)
      ? h('p', { class: 'report-note no-print' }, 'Teachers under “Classes Not Given” have no class saved. Add the classes they teach on Schools & teachers, then rebuild, to place them in a stage.')
      : null
  );
}

// A stacked bar per section: how many teachers got each grade.
function sectionGrades(figures, grades) {
  const stats = figures.section_stats.filter((s) => s.sat);
  if (!stats.length) return null;
  const bands = [...grades].sort((a, b) => b.min - a.min);
  return h(
    'div',
    { class: 'chart-block' },
    h('h3', {}, 'Grades in Each Section'),
    h(
      'div',
      { class: 'grade-rows' },
      stats.map((s) =>
        h(
          'div',
          { class: 'grade-row' },
          h('div', { class: 'grade-row-name' }, h('strong', {}, titleCase(s.name)), h('div', { class: 'hint' }, `${s.sat} took it · average ${s.average}%`)),
          stackedBar(bands.map((g) => ({ key: g.grade, label: `Grade ${g.grade}, ${g.label}`, value: s.counts[g.grade] ?? 0 })), { label: s.name })
        )
      )
    ),
    legend(bands.map((g) => ({ key: g.grade, label: `${g.grade} ${g.label}` })))
  );
}

// "Section A: Interpersonal & Instructional Communication Skills · …"
function sectionTitles(stats) {
  const titled = stats.filter((s) => s.title);
  return titled.length ? h('p', { class: 'report-key' }, titled.map((s, i) => [i ? ' · ' : '', h('strong', {}, `${titleCase(s.name)}: `), s.title])) : null;
}

const dayCount = (p) => (p.days_min === p.days_max ? plural(p.days_min, 'day') : `${p.days_min} to ${p.days_max} days`);

// The school's training in a line: how many teachers are on each growth
// path, the days in all, and how many need none. Each teacher's own plan is
// in their management report.
function trainingTotal(training) {
  if (!training) return null;
  if (!training.paths.length) {
    return h('p', { class: 'report-callout' }, h('strong', {}, 'Training: '), 'every teacher tested so far is at Grade B (Good) or better in each section taken, so no training is needed.');
  }
  const paths = training.paths.map((p, i) => `${i ? p.teachers.length : plural(p.teachers.length, 'teacher')} on ${p.name} (${dayCount(p)} each)`);
  return h(
    'p',
    { class: 'report-callout' },
    h('strong', {}, 'Training in Total: '),
    `${listing(paths)}, ${plural(training.teacher_days, 'training day')} in all.`,
    training.none.length ? ` ${training.none.length === 1 ? 'One teacher needs' : `${training.none.length} teachers need`} no training.` : '',
    ' Each teacher’s own plan is in their management report.'
  );
}

// The teachers whose sections were marked leniently, so their percentages
// cover only the questions they attempted.
function lenientTeachers(figures) {
  const lenient = figures.teachers
    .map((t) => ({ t, keys: t.sections.filter((s) => s.marking === 'lenient').map((s) => s.key || 'paper') }))
    .filter(({ keys }) => keys.length);
  if (!lenient.length) return null;
  return h(
    'p',
    { class: 'report-note' },
    h('strong', {}, 'Lenient marking: '),
    'only the questions answered are counted, and questions left blank are not in the marks or the total, for ',
    lenient.map(({ t, keys }, i) => [i ? ', ' : '', t.name, h('span', { class: 'hint' }, ` (${keys.join(', ')})`)]),
    '.'
  );
}

// Who is on track, developing or in need of support in each stage, with the
// sections that put them there.
function teachersByStage(figures, needs, test) {
  const assessed = figures.teachers.filter((t) => t.sections.length);
  if (!assessed.length || !figures.stage_stats?.length) return null;
  const columns = [...needs].reverse();
  const gradeFor = { developing: 'C', support: 'D' };
  const who = (t, need) => {
    const keys = gradeFor[need] ? t.sections.filter((s) => s.grade === gradeFor[need]).map((s) => s.key || 'paper') : [];
    return [h('a', { href: `#/teachers/${t.id}/report/${test.id}?for=management` }, t.name), keys.length ? h('span', { class: 'hint' }, ` (${keys.join(', ')})`) : null];
  };
  return h(
    'section',
    { class: 'report-teachers' },
    h('h2', {}, 'Teachers by Stage'),
    h('p', { class: 'report-note' }, 'The letters in brackets are the sections that need help: those at Grade D for “Needs More Support”, and at Grade C for “Needs Some Support”. Each teacher has their own report.'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report-table needs-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), columns.map((n) => h('th', {}, h('i', { class: `swatch fill-${n.key}` }), ` ${n.label}`)))),
        h(
          'tbody',
          {},
          figures.stage_stats.map((stage) => {
            const members = assessed.filter((t) => (t.stage ?? null) === stage.key);
            return h(
              'tr',
              {},
              h('td', {}, h('strong', {}, stage.name), stage.classes ? h('div', { class: 'hint' }, stage.classes) : null),
              columns.map((n) => {
                const list = members.filter((t) => t.need === n.key);
                return h('td', {}, list.length ? list.map((t, i) => [i ? ', ' : '', who(t, n.key)]) : h('span', { class: 'hint' }, '—'));
              })
            );
          })
        )
      )
    )
  );
}

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
    const written = writtenContent(report);
    // Figures come from the report once it is written, so they match its text.
    const figures = written ?? data;
    const running = report?.status === 'running';

    const buildButton = h(
      'button',
      { class: `btn ${written ? '' : 'btn-primary'}`, type: 'button', disabled: running || !data.assessed, onclick: build },
      running ? 'Writing…' : report?.content ? 'Rebuild report' : 'Build report'
    );
    const keys = figures.section_stats.map((s) => s.key);

    const sheet = reportSheet(
      {
        school,
        audience: 'For Management',
        title: 'School Report',
        details: [
          ['Test', test.name],
          ['Teachers Tested', `${figures.assessed} of ${figures.teachers.length}`],
          ['Report Date', written ? formatDate(report.written_at) : null],
        ],
      },
      h('h2', {}, 'Summary'),
      written?.summary ? h('p', { class: 'report-lead' }, written.summary) : null,
      glance(figures, data.needs),
      stageTable(figures, keys, data.grades),
      sectionTitles(figures.section_stats),
      sectionGrades(figures, data.grades),
      written?.findings.length ? [h('h3', {}, 'What We Found'), numbered(written.findings, point)] : null,
      written?.actions.length ? [h('h3', {}, 'What We Will Do'), numbered(written.actions, (a) => [a.timing ? h('strong', {}, `${a.timing}: `) : null, a.action])] : null,
      trainingTotal(figures.training),
      written?.school_needs.length ? [h('h3', {}, 'What We Need from the School'), bullets(written.school_needs)] : null,
      !written && !running ? h('p', { class: 'hint no-print' }, 'The charts and figures are live. Press Build report to add the summary, findings and plan of action.') : null,
      teachersByStage(figures, data.needs, test),
      lenientTeachers(figures),
      figures.not_assessed.length ? h('p', { class: 'report-note' }, `Not yet tested: ${figures.not_assessed.join(', ')}.`) : null,
      gradeKey(data.grades)
    );

    mount(
      container,
      h('div', { class: 'breadcrumb no-print' }, h('a', { href: `#/assessments?school=${school.id}&test=${test.id}` }, '← Assessments')),
      h(
        'div',
        { class: 'page-head no-print' },
        h('div', {}, h('h1', {}, `${school.name}: School Report`), h('p', {}, `${test.name}. Figures are per section; teachers are only compared within a section they took.`)),
        h('div', { class: 'page-actions' }, buildButton, h('button', { class: 'btn btn-primary', onclick: () => window.print() }, 'Print'))
      ),
      reportState(report, { building: h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report'), what: 'the school report' }),
      data.assessed && !running ? trainingNotice(data.training_state, written, h('button', { class: 'btn-link', type: 'button', onclick: build }, 'Rebuild report')) : null,
      data.assessed ? sheet : emptyState('No teacher has been evaluated in this test yet.')
    );
  }

  draw();
  mount(root, container);
  watch();
}
