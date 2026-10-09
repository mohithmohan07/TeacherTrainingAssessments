import {
  h, mount, field, input, textarea, select, toast, confirmAction, statusBadge,
  formatDate, formatBytes, emptyState, viewPages, sectionChip,
} from '../ui.js';
import { schoolsApi, teachersApi, assessmentsApi, testsApi, reportsApi, bulkApi } from '../api.js';
import { choosePaper, paperFacts, paperThumb } from '../paper-picker.js';
import { chooseMarking } from '../marking-choice.js';
import { evaluateAllButton, failedReasons } from '../unmarked.js';
import { movePages } from '../move-pages.js';
import { WRITING_NAME, checkedSections, openWritingReport, writingChip, writingLine } from '../writing.js';
import {
  scanner, scanPages, connectScanner, stopScanning, checkScannerOnce, selectScanner, selectedScanner,
  scanBothSides, setScanBothSides, HELPER_DOWNLOAD_URL,
} from '../scanner.js';

const KIND_NAMES = { question_paper: 'question paper', response: 'answer paper' };
const pageCount = (n) => `${n} page${n === 1 ? '' : 's'}`;
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The board works on the full paper or on one section at a time.
const SECTION_OPTIONS = [
  { value: '', label: 'Full paper' },
  { value: 'A', label: 'Section A' },
  { value: 'B', label: 'Section B' },
  { value: 'C', label: 'Section C' },
];
const SECTION_KEY = 'tta.board.section';

function rememberedSection() {
  try {
    return localStorage.getItem(SECTION_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberSection(section) {
  try {
    localStorage.setItem(SECTION_KEY, section);
  } catch {
    // Not remembered; the board still works on the chosen section.
  }
}

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'scanned', label: 'Scans uploaded' },
  { value: 'evaluated', label: 'Evaluated' },
];

/* ------------------------------------------------------------ assessment list */

export async function renderAssessments(root, query = new URLSearchParams()) {
  const schools = await schoolsApi.list();

  if (!schools.length) {
    mount(root,
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Assessments'))),
      emptyState(
        'Add a school and its teachers first — then you can start an assessment.',
        h('a', { class: 'btn btn-primary', href: '#/schools', style: 'margin-top:12px' }, 'Go to schools')
      )
    );
    return;
  }

  const state = {
    schoolId: query.get('school') ?? String(schools[0].id),
    testId: query.get('test') ?? null,
    section: SECTION_OPTIONS.some((o) => o.value === query.get('section')) ? query.get('section') : rememberedSection(),
    tests: [],
    roster: [],
    librarySize: 0,
    assessments: [],
    justFiled: null,
  };

  const container = h('div', {});

  async function load() {
    state.tests = await testsApi.list(state.schoolId);
    if (!state.tests.some((t) => String(t.id) === String(state.testId))) state.testId = String(state.tests[0].id);
    const [roster, assessments, bulk, unmarked] = await Promise.all([
      teachersApi.roster(state.schoolId, state.testId, state.section),
      assessmentsApi.list({ school_id: state.schoolId, test_id: state.testId }),
      bulkApi.list(state.schoolId, state.testId).catch(() => ({ items: [] })),
      bulkApi.unmarked(state.schoolId, state.testId).catch(() => ({ failed: [] })),
    ]);
    state.bulkWaiting = bulk.items.length;
    state.failed = unmarked.failed;
    state.roster = roster.teachers;
    state.librarySize = roster.library_size;
    state.assessments = assessments;
    draw();
  }

  const newTest = async () => {
    const name = window.prompt('Name the new test, for example "Post-training test, March 2027":');
    if (!name?.trim()) return;
    try {
      const test = await testsApi.create({ school_id: state.schoolId, name: name.trim() });
      state.testId = String(test.id);
      toast(`Created ${test.name}. Scans on the board now go under it.`, 'success');
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const renameTest = async () => {
    const current = state.tests.find((t) => String(t.id) === state.testId);
    const name = window.prompt('Rename this test:', current?.name ?? '');
    if (!name?.trim() || name.trim() === current?.name) return;
    try {
      await testsApi.rename(state.testId, name.trim());
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  function draw() {
    const schoolSelect = select('school', schools.map((s) => ({ value: String(s.id), label: s.name })), { value: state.schoolId });
    schoolSelect.addEventListener('change', () => {
      state.schoolId = schoolSelect.value;
      state.testId = null;
      load();
    });

    const testSelect = select('test', state.tests.map((t) => ({ value: String(t.id), label: t.name })), { value: state.testId });
    testSelect.addEventListener('change', () => {
      state.testId = testSelect.value;
      load();
    });
    const testControls = h(
      'div',
      { class: 'test-picker' },
      testSelect,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: renameTest }, 'Rename'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: newTest }, 'New test')
    );

    const sectionControl = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Full paper or one section' },
      SECTION_OPTIONS.map((option) =>
        h(
          'button',
          {
            type: 'button',
            class: option.value === state.section ? 'active' : '',
            'aria-pressed': String(option.value === state.section),
            onclick: () => {
              if (option.value === state.section) return;
              state.section = option.value;
              rememberSection(option.value);
              load();
            },
          },
          option.label
        )
      )
    );

    mount(container,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, 'Assessments'),
          h('p', {}, 'Confirm or upload each teacher’s question paper, upload their answer paper, then press Evaluate to have OpenAI mark it. Sections sat on different dates add up under the same test.')
        ),
        h(
          'div',
          { class: 'page-actions' },
          h('a', { class: 'btn btn-primary', href: `#/assessments/upload-all?school=${state.schoolId}&test=${state.testId}` }, 'Upload all answer papers (PDFs)')
        )
      ),
      state.bulkWaiting
        ? h(
            'p',
            { class: 'notice' },
            `${state.bulkWaiting} answer paper PDF${state.bulkWaiting === 1 ? ' is' : 's are'} waiting to be checked and filed for this test. `,
            h('a', { href: `#/assessments/upload-all?school=${state.schoolId}&test=${state.testId}` }, 'Check and file them')
          )
        : null,
      // Failed papers can be in any section, not only the one on the board.
      state.failed?.length
        ? h(
            'div',
            { class: 'notice notice-danger' },
            h(
              'div',
              { class: 'notice-row' },
              h('span', {}, `Marking failed for ${state.failed.length} paper${state.failed.length === 1 ? '' : 's'} in this test.`),
              evaluateAllButton({ schoolId: state.schoolId, testId: state.testId, which: 'failed', count: state.failed.length, after: load })
            ),
            failedReasons(state.failed)
          )
        : null,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'form-grid' },
          field('School', schoolSelect),
          field('Test', testControls, { hint: 'Each test is one round, such as a pre-training and a post-training test.' }),
          field('Papers', sectionControl, {
            span: true,
            hint: state.section
              ? `Each row takes the Section ${state.section} question paper and answer paper only, and is marked as Section ${state.section}.`
              : 'Each row takes the whole paper. Pick a section when a teacher sits one section on its own.',
          })
        )
      ),
      teacherBoardCard(state, load, draw),
      schoolReportCard(state, load),
      historyCard(state)
    );
    state.justFiled = null; // the row that just had pages filed lights up once
  }

  // Looks for the scanner helper if scanning was turned on in an earlier visit.
  // Started before the first draw so the board opens saying it is checking.
  const scannerCheck = checkScannerOnce();

  mount(root, container);
  await load();

  scannerCheck.then((changed) => {
    if (changed && container.isConnected && !scanner.busy) draw();
  });
}

/* -------------------------------------------------------- the teacher board */

function teacherBoardCard(state, reload, redraw) {
  if (!state.roster.length) {
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Teachers'),
      emptyState(
        'This school has no teachers yet.',
        h('a', { class: 'btn btn-primary', href: `#/schools/${state.schoolId}`, style: 'margin-top:12px' }, 'Add or import teachers')
      )
    );
  }

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, `Teachers (${state.roster.length})${state.section ? ` · Section ${state.section}` : ' · Full paper'}`),
    h('p', { class: 'hint' }, 'Confirming a paper or uploading pages only files them against the teacher. Nothing is marked until you press Evaluate.'),
    scannerPanel(redraw),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Teacher'),
            h('th', {}, state.section ? `Section ${state.section} question paper` : 'Question paper'),
            h('th', {}, state.section ? `Section ${state.section} answer paper` : 'Answer paper'),
            h('th', {}, 'Status'),
            h('th', {}, 'Sections so far'),
            h('th', { class: 'right' }, '')
          )
        ),
        h(
          'tbody',
          {},
          state.roster.map((teacher) =>
            h(
              'tr',
              { class: state.justFiled === teacher.id ? 'just-filed' : null },
              h(
                'td',
                {},
                h('a', { class: 'teacher-link', href: `#/teachers/${teacher.id}` }, teacher.name),
                [teacher.grade, teacher.subjects].filter(Boolean).length
                  ? h('div', { class: 'hint' }, [teacher.grade, teacher.subjects].filter(Boolean).join(' · '))
                  : null
              ),
              h('td', {}, questionPaperCell(state, teacher, reload, redraw)),
              h('td', {}, scanCell(state, teacher, 'response', teacher.response_count, teacher.response_first, reload, redraw)),
              h(
                'td',
                {},
                teacher.ai_status === 'running'
                  ? h('span', { class: 'badge running' }, 'Marking…')
                  : teacher.assessment_id
                    ? statusBadge(teacher.assessment_status)
                    : teacher.sections.length
                      ? h('span', { class: 'hint' }, '—')
                      : h('span', { class: 'badge draft' }, 'Not started')
              ),
              h(
                'td',
                {},
                teacher.sections.length
                  ? [h('div', { class: 'chips' }, teacher.sections.map((section) => sectionChip(section, { short: true })), writingChip(teacher.sections, { teacherName: teacher.name })), lenientNote(teacher.sections)]
                  : h('span', { class: 'hint' }, '—')
              ),
              h(
                'td',
                { class: 'right' },
                h(
                  'div',
                  { class: 'row-actions' },
                  swapButton(teacher, reload),
                  evaluateButton(state, teacher),
                  teacher.sections.length ? reportButton(state, teacher) : null
                )
              )
            )
          )
        )
      )
    )
  );
}

// One upload control for one kind of scan, on one teacher's row. With the
// scanner connected the button scans; otherwise it picks image files. The
// button names what it files the pages as, and once pages are in, the first
// one shows small beside the count, so pages filed in the wrong column are
// plain to see. Clicking it shows them all.
function scanCell(state, teacher, kind, count, firstPage, reload, redraw) {
  const label = count ? pageCount(count) : 'None yet';
  const scanning = scanner.status === 'ready';
  const idleLabel = scanning
    ? (count ? 'Scan more' : `Scan ${KIND_NAMES[kind]}`)
    : count ? 'Add pages' : `Upload ${KIND_NAMES[kind]}`;
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  const button = h('button', { class: 'btn btn-sm', type: 'button' }, idleLabel);
  // The test and section the pages go to are taken when the button is
  // pressed, so changing them while the scanner works cannot send them elsewhere.
  let target = { testId: state.testId, section: state.section };

  const settle = () => {
    button.disabled = false;
    button.textContent = idleLabel;
    fileInput.value = '';
  };

  const upload = async (files, { scanned = false, warning = '' } = {}) => {
    const data = new FormData();
    data.set('kind', kind);
    data.set('test_id', target.testId);
    if (target.section) data.set('section', target.section);
    for (const file of files) data.append('files', file);

    button.textContent = 'Uploading…';
    try {
      await teachersApi.uploadScans(teacher.id, data);
      toast(`${pageCount(files.length)} ${scanned ? 'scanned' : 'added'} as ${teacher.name}’s ${KIND_NAMES[kind]}.`, 'success');
      if (warning) toast(warning, 'error');
      state.justFiled = teacher.id;
      await reload(); // redraws the whole board, so the button state goes with it
    } catch (error) {
      const kept = scanned && scanner.folder ? ` The scanned pages are also saved on this laptop in ${scanner.folder}.` : '';
      toast(`${error.message}${kept}`, 'error');
      settle();
    }
  };

  button.addEventListener('click', async () => {
    target = { testId: state.testId, section: state.section };
    if (!scanning) {
      fileInput.click();
      return;
    }
    button.disabled = true;
    button.textContent = 'Scanning…';
    const what = `${target.section ? `Section ${target.section} ` : ''}${KIND_NAMES[kind]}`;
    const dialog = scanningDialog(teacher.name, what);
    let scan;
    try {
      scan = await scanWithDialog(dialog, { teacherName: teacher.name, label: `${teacher.name} - ${KIND_NAMES[kind]}` });
    } catch (error) {
      dialog.close();
      toast(error.message, 'error');
      settle();
      if (error.helperGone) redraw();
      return;
    }
    if (!scan) {
      settle();
      return;
    }
    dialog.say(`Filing ${pageCount(scan.files.length)} as ${teacher.name}’s ${what}…`);
    await upload(scan.files, { scanned: true, warning: scan.warning });
    dialog.close();
  });

  fileInput.addEventListener('change', () => {
    const chosen = Array.from(fileInput.files ?? []);
    if (!chosen.length) return;
    button.disabled = true;
    upload(chosen);
  });

  const preview = count && firstPage
    ? h('img', {
        class: 'scan-first',
        src: `/uploads/${firstPage}`,
        alt: `First page of ${teacher.name}’s ${KIND_NAMES[kind]}`,
        title: `The ${KIND_NAMES[kind]}’s first page. Click to see every page.`,
        loading: 'lazy',
        onclick: () => showRowPages(state, teacher, kind, firstPage, reload),
      })
    : null;

  return h('div', { class: 'scan-cell' }, preview, h('span', { class: 'scan-count' }, label), button, fileInput);
}

// A row's pages of one kind, from the first, under the name of the teacher
// they are filed under. Until the paper is marked, pages that are another
// teacher's can be moved from there.
function showRowPages(state, teacher, kind, firstPage, reload) {
  const movable = teacher.assessment_status !== 'evaluated' && teacher.ai_status !== 'running';
  viewPages({
    title: `${teacher.name} · ${capitalise(KIND_NAMES[kind])}${state.section ? ` · Section ${state.section}` : ''}`,
    pages: [{ src: `/uploads/${firstPage}`, name: `First page of ${teacher.name}’s ${KIND_NAMES[kind]}` }],
    loadPages: async () => {
      const sitting = await assessmentsApi.get(teacher.assessment_id);
      return (kind === 'response' ? sitting.response_files : sitting.question_paper_files)
        .map((file) => ({ src: `/uploads/${file.stored_name}`, name: file.original_name }));
    },
    action: movable ? { label: 'Wrong teacher? Move these pages', run: () => moveRowPages(state, teacher, kind, reload) } : null,
  });
}

async function moveRowPages(state, teacher, kind, reload) {
  const moved = await movePages({
    sitting: {
      id: teacher.assessment_id,
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      school_id: teacher.school_id,
      question_paper_count: teacher.question_paper_count,
      response_count: teacher.response_count,
    },
    kind,
  });
  if (!moved) return;
  state.justFiled = moved.teacher.id;
  await reload();
}

// While the scanner works, a dialog names whose paper the pages will be filed
// under, so a press on the wrong row shows at once, and it covers the page so
// nothing else can be pressed meanwhile. Stop closes it; whatever the scanner
// still sends after that is not filed.
function scanningDialog(teacherName, what) {
  const line = h('span', {}, 'Scanning the pages in the feeder…');
  const stop = h('button', { class: 'btn', type: 'button' }, 'Stop');
  const overlay = h(
    'div',
    { class: 'modal-backdrop' },
    h(
      'div',
      { class: 'modal scan-progress', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Scanning for ${teacherName}`, tabindex: '-1' },
      h('div', { class: 'modal-head' }, h('div', {}, h('h2', {}, `Scanning for ${teacherName}`), h('p', { class: 'hint' }, capitalise(what)))),
      h(
        'div',
        { class: 'scan-progress-body' },
        h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), line),
        h('p', { class: 'hint' }, `The pages will be filed as ${teacherName}’s ${what}. If this is the wrong teacher, press Stop.`)
      ),
      h('div', { class: 'modal-foot' }, stop)
    )
  );
  const stopped = new Promise((resolve) => {
    stop.addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
  });
  document.body.append(overlay);
  overlay.firstElementChild.focus(); // not Stop, so a stray Enter does not stop the scan
  return {
    stopped,
    // Once the pages are being filed, Stop can no longer stop them.
    say: (text) => {
      line.textContent = text;
      stop.disabled = true;
    },
    close: () => overlay.remove(),
  };
}

// Scans behind the dialog. Resolves with the scan, or null if Stop was
// pressed first, in which case the pages are kept only on this laptop.
async function scanWithDialog(dialog, { teacherName, label }) {
  const scanning = scanPages({ label });
  const scan = await Promise.race([scanning, dialog.stopped]);
  if (scan === null) {
    scanning.then(
      () => toast(`Nothing was filed for ${teacherName}. The pages scanned after you pressed Stop are only on this laptop${scanner.folder ? `, in ${scanner.folder}` : ''}.`, 'error'),
      () => {}
    );
  }
  return scan;
}

// The question paper on a teacher's row comes one of two ways: papers from the
// library, confirmed for this teacher, or scanned pages. Until it has either,
// the library's best fit is suggested beside the upload button; nothing is
// used until it is confirmed in the dialog.
function questionPaperCell(state, teacher, reload, redraw) {
  const locked = teacher.assessment_status === 'evaluated' || teacher.ai_status === 'running';

  if (teacher.papers.length) {
    return h(
      'div',
      { class: 'paper-cell' },
      teacher.papers.map((paper) =>
        h(
          'div',
          { class: 'paper-chosen' },
          paperThumb(paper),
          h(
            'div',
            { class: 'paper-chosen-text' },
            h('a', { href: `/uploads/${paper.stored_name}`, target: '_blank', rel: 'noopener', title: paperFacts(paper) }, paper.title),
            h('div', { class: 'hint' }, `From the library · ${paperFacts(paper)}`)
          )
        )
      ),
      teacher.question_paper_count
        ? h('div', { class: 'hint' }, `Also ${teacher.question_paper_count} scanned page${teacher.question_paper_count === 1 ? '' : 's'}.`)
        : null,
      locked ? null : h('button', { class: 'btn-link', type: 'button', onclick: () => confirmPaper(state, teacher, reload) }, 'Change paper')
    );
  }

  const scans = scanCell(state, teacher, 'question_paper', teacher.question_paper_count, teacher.question_paper_first, reload, redraw);
  if (teacher.question_paper_count || locked) return scans;

  const suggested = teacher.suggested_papers ?? [];
  let suggestion = null;
  if (suggested.length) {
    suggestion = h(
      'div',
      { class: 'paper-suggestion' },
      h(
        'div',
        { class: 'paper-suggestion-text' },
        h('span', { class: 'hint' }, 'Suggested: '),
        suggested.length === 1
          ? h('strong', {}, suggested[0].title)
          : h('strong', { title: suggested.map((p) => p.title).join('\n') }, `${suggested.length} papers (${suggested.flatMap((p) => p.sections).join(', ')})`)
      ),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => confirmPaper(state, teacher, reload) }, 'Confirm paper')
    );
  } else if (state.librarySize) {
    suggestion = h(
      'div',
      { class: 'paper-suggestion' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => confirmPaper(state, teacher, reload) }, 'Choose from library')
    );
  }
  return h('div', { class: 'paper-cell' }, suggestion, scans);
}

// Asks "is this the paper?" and files the confirmed papers against the
// teacher's current sitting for the full paper or the board's section.
async function confirmPaper(state, teacher, reload) {
  const ids = await choosePaper({ teacher, section: state.section, current: teacher.papers });
  if (!ids) return;
  try {
    const sitting = teacher.assessment_id
      ? { id: teacher.assessment_id }
      : await teachersApi.currentAssessment(teacher.id, state.testId, state.section);
    const updated = await assessmentsApi.setPapers(sitting.id, ids);
    const names = updated.papers.map((paper) => `“${paper.title}”`).join(' and ');
    toast(`${names} confirmed as ${teacher.name}’s question paper. Now upload the answer paper.`, 'success');
    await reload();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// Swaps the question paper and the answer paper on a row, for pages that went
// into the wrong column. Offered until the sitting is evaluated; after that,
// the evaluation screen has the same button.
function swapButton(teacher, reload) {
  const hasPages = teacher.question_paper_count > 0 || teacher.response_count > 0;
  if (!teacher.assessment_id || !hasPages || teacher.assessment_status === 'evaluated' || teacher.ai_status === 'running') return null;

  const button = h(
    'button',
    { class: 'btn btn-sm', type: 'button', title: 'Pages in the wrong column? Swap the question paper and the answer paper.' },
    'Swap'
  );
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await assessmentsApi.swap(teacher.assessment_id);
      toast(`Swapped ${teacher.name}’s question paper and answer paper. Press Swap again to undo.`, 'success');
      await reload();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
  return button;
}

// The strip above the board that connects the Scan buttons to the scanner
// helper on this laptop, and says what to do when it cannot be reached.
function scannerPanel(redraw) {
  const connect = async (event) => {
    event.currentTarget.disabled = true;
    const status = await connectScanner();
    redraw();
    if (status === 'ready') toast(`Scanner ready: ${selectedScanner().name}.`, 'success');
  };
  const connectButton = (label) => h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: connect }, label);
  const download = h('a', { href: HELPER_DOWNLOAD_URL, download: '' }, 'Download the scanner helper');
  const useFiles = h(
    'button',
    { class: 'btn-link', type: 'button', onclick: () => { stopScanning(); redraw(); } },
    'Use image files instead'
  );
  const panel = (tone, ...children) => h('div', { class: `scanner-panel${tone ? ` ${tone}` : ''}` }, ...children);
  const text = (...children) => h('div', { class: 'grow' }, ...children);

  switch (scanner.status) {
    case 'checking':
      return panel('', text('Looking for the scanner helper on this laptop…'));

    case 'ready': {
      const current = selectedScanner();
      const choice = scanner.scanners.length > 1
        ? select('scanner', scanner.scanners.map((item) => ({ value: item.id, label: item.name })), { value: current.id, id: 'scanner-choice' })
        : h('strong', {}, current.name);
      if (choice.tagName === 'SELECT') choice.addEventListener('change', () => selectScanner(choice.value));

      const bothSides = h('input', { type: 'checkbox', checked: scanBothSides() });
      bothSides.addEventListener('change', () => setScanBothSides(bothSides.checked));

      return panel(
        'ready',
        text(h('strong', {}, 'Scanner ready: '), choice, '. Put the pages in the feeder, then press Scan on the teacher’s row.'),
        h('label', { class: 'inline' }, bothSides, 'Both sides'),
        useFiles
      );
    }

    case 'missing':
      return panel(
        'attention',
        text(
          h('strong', {}, 'The scanner helper isn’t running on this laptop, '),
          'so the buttons upload image files for now. Double-click “Start scanner helper”, then press Check again.'
        ),
        connectButton('Check again'),
        download,
        useFiles
      );

    case 'blocked':
      return panel(
        'attention',
        text(
          h('strong', {}, 'Your browser is blocking this page from reaching the scanner helper. '),
          'Click the icon at the left end of the address bar, allow this site to reach apps on this device, then press Check again.'
        ),
        connectButton('Check again'),
        useFiles
      );

    case 'no-scanner':
      return panel(
        'attention',
        text(
          h('strong', {}, 'The scanner helper is running, but it can’t find the scanner. '),
          'Check the scanner is plugged in and switched on, then press Check again.',
          scanner.message ? h('div', { class: 'hint' }, scanner.message) : null
        ),
        connectButton('Check again'),
        useFiles
      );

    default:
      return panel(
        '',
        text(
          h('strong', {}, 'Scan straight from the scanner. '),
          'Start the scanner helper on this laptop, then press Connect. The first time, your browser may ask to let this site reach apps on this device: choose Allow.'
        ),
        connectButton('Connect scanner'),
        download
      );
  }
}

// "Lenient marking" under a teacher's results, naming the sections when only
// some of them were marked leniently.
function lenientNote(sections) {
  const lenient = sections.filter((s) => s.marking === 'lenient');
  if (!lenient.length) return null;
  const which = lenient.length < sections.length ? `: ${lenient.map((s) => (/^Section [A-Z]$/.test(s.name) ? s.name.slice(8) : s.name)).join(', ')}` : '';
  return h('div', { class: 'hint' }, `Lenient marking${which}`);
}

// Evaluate asks how to count the marks, has OpenAI mark the teacher's scans,
// then opens the evaluation screen, which shows the marking as it finishes.
// Without both sets of scans it just opens the screen. If this teacher has no
// assessment yet, one is created.
function evaluateButton(state, teacher) {
  const evaluated = teacher.assessment_status === 'evaluated';
  const running = teacher.ai_status === 'running';
  const button = h(
    'button',
    { class: 'btn btn-sm btn-primary', type: 'button' },
    running ? 'Marking…' : evaluated ? 'Review' : 'Evaluate'
  );

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const ready = (teacher.question_paper_count > 0 || teacher.papers.length > 0) && teacher.response_count > 0;
      let marking = null;
      if (!evaluated && !running && ready) {
        marking = await chooseMarking({ teacherName: teacher.name });
        if (!marking) {
          button.disabled = false;
          return;
        }
      }
      const id = teacher.assessment_id ?? (await teachersApi.currentAssessment(teacher.id, state.testId, state.section)).id;
      if (marking) {
        try {
          await assessmentsApi.evaluate(id, marking);
        } catch (error) {
          toast(error.message, 'error');
        }
      }
      window.navigate(`/assessments/${id}`);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });

  return button;
}

// Opens the teacher's reports for this test. They are written by OpenAI after
// each Evaluate, so the label says where they stand.
function reportButton(state, teacher) {
  const labels = { running: 'Writing report…', failed: 'Report failed', stale: 'Report (update)', done: 'Report', none: 'Report' };
  return h(
    'a',
    { class: `btn btn-sm${teacher.report_status === 'failed' ? ' btn-danger' : ''}`, href: `#/teachers/${teacher.id}/report/${state.testId}` },
    labels[teacher.report_status] ?? 'Report'
  );
}

// "Download all reports": every written report of the test in one zip, a
// folder named after the test with the teachers' reports in one folder, the
// management reports in another, and the school report. The server prints
// them to PDF, which takes a few seconds a report, so the page shows how far
// it has got and the zip downloads when it is ready. A zip made in the last
// hour can be downloaded again.
function downloadAll(state, { written, writing }) {
  const fileUrl = reportsApi.zipFileUrl(state.schoolId, state.testId);
  const line = h('div', { class: 'zip-line' });
  const idleTitle = writing ? 'Wait until the reports being written are done.' : written ? null : 'Build the teacher reports first.';
  const button = h('button', { class: 'btn', type: 'button', disabled: Boolean(idleTitle), title: idleTitle, onclick: () => start() }, 'Download all reports');

  const save = (job) => {
    const link = h('a', { href: fileUrl, download: job.name, style: 'display:none' });
    document.body.append(link);
    link.click();
    link.remove();
    toast(`Downloading ${job.name}.`, 'success');
  };

  // What is in the zip and what is not, under a finished one.
  const notes = (job) => {
    const items = [
      job.not_printed.length
        ? `Could not be printed, so not in the zip: ${job.not_printed.join(', ')}.${job.out_of_memory ? ' Chromium stopped on them, most likely for lack of memory: giving the app 1 GB of memory should fix it.' : ''}`
        : null,
      job.left_out.length ? `Not in the zip, as their reports have not been written: ${job.left_out.join(', ')}.` : null,
      job.old_layout.length ? `Not in the zip, as their reports are in the earlier layout (rebuild, then download again): ${job.old_layout.join(', ')}.` : null,
      job.out_of_date.length ? `Out of date (rebuild, then download again): ${job.out_of_date.join(', ')}.` : null,
      job.school === 'missing' ? 'The school report has not been built, so it is not in the zip.' : null,
      job.school === 'old_layout' ? 'The school report is in the earlier layout, so it is not in the zip: rebuild it on the School Report page, then download again.' : null,
      job.school === 'out_of_date' ? 'The school report in the zip is out of date: rebuild it on the School Report page, then download again.' : null,
    ].filter(Boolean);
    return items.length ? h('ul', { class: 'zip-notes' }, items.map((item) => h('li', {}, item))) : null;
  };

  // Shows a zip's state, checks back every few seconds while it is being
  // made, and downloads it if it finishes while this page is open.
  const show = (job, { watched = false } = {}) => {
    if (!button.isConnected && watched) return;
    if (!job) {
      mount(line);
      return;
    }
    if (job.status === 'running') {
      button.disabled = true;
      button.textContent = 'Making the zip…';
      mount(
        line,
        h(
          'div',
          { class: 'marking-state' },
          h('span', { class: 'spinner' }),
          `Printing the reports to PDF: ${job.done} of ${job.total} done${job.current ? `, now ${job.current}` : ''}. The zip downloads when it is ready, if this page is still open.`
        )
      );
      setTimeout(async () => {
        if (!button.isConnected) return;
        try {
          show((await reportsApi.zip(state.schoolId, state.testId)).job, { watched: true });
        } catch {
          show(job, { watched: true });
        }
      }, 2500);
      return;
    }
    button.disabled = Boolean(idleTitle);
    button.textContent = 'Download all reports';
    if (job.status === 'failed') {
      mount(line, h('div', { class: 'marking-state error' }, job.error));
      return;
    }
    if (watched) save(job);
    mount(
      line,
      h(
        'div',
        { class: 'zip-ready' },
        h('div', {}, h('strong', {}, job.name), ` is ready (${formatBytes(job.size)}). `, h('a', { href: fileUrl, download: job.name }, watched ? 'Download it again' : 'Download it')),
        notes(job)
      )
    );
  };

  const start = async () => {
    button.disabled = true;
    try {
      const viewer = { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language };
      show((await reportsApi.startZip(state.schoolId, state.testId, viewer)).job, { watched: true });
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = Boolean(idleTitle);
    }
  };

  // A zip being made, or made in the last hour.
  reportsApi.zip(state.schoolId, state.testId).then(({ job }) => {
    if (button.isConnected) show(job, { watched: job?.status === 'running' });
  }, () => {});

  return { button, line };
}

// The school report on all of the school's teachers, offered at the end, a
// button that builds every teacher report still missing or out of date, and
// one that downloads them all.
function schoolReportCard(state, reload) {
  const assessed = state.roster.filter((t) => t.sections.length);
  if (!state.roster.length) return null;
  const due = assessed.filter((t) => ['none', 'failed', 'stale'].includes(t.report_status)).length;
  const writing = assessed.filter((t) => t.report_status === 'running').length;
  const reports = (n) => `${n} teacher report${n === 1 ? '' : 's'}`;
  const download = assessed.length ? downloadAll(state, { written: assessed.some((t) => ['done', 'stale'].includes(t.report_status)), writing }) : null;

  const buildAll = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: !due,
      onclick: async () => {
        buildAll.disabled = true;
        try {
          const { started } = await reportsApi.buildAllTeachers(state.schoolId, state.testId);
          toast(started ? `OpenAI is writing ${reports(started)}. Press Refresh to see how they are getting on.` : 'Every teacher report is up to date.', 'success');
          await reload();
        } catch (error) {
          toast(error.message, 'error');
          buildAll.disabled = false;
        }
      },
    },
    due ? `Build ${reports(due)}` : writing ? 'Writing teacher reports…' : 'Teacher reports up to date'
  );

  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'scan-group-head' },
      h(
        'div',
        {},
        h('h2', { style: 'margin:0' }, 'Reports'),
        h(
          'p',
          { class: 'hint', style: 'margin:4px 0 0' },
          assessed.length
            ? [
                `${assessed.length} of ${state.roster.length} teachers have results in this test.`,
                due ? ` ${due === 1 ? 'One teacher report is' : `${due} teacher reports are`} missing or out of date.` : '',
                writing ? ` ${reports(writing)} ${writing === 1 ? 'is' : 'are'} being written.` : '',
                ' When you have evaluated everyone you want in it, build the school report on all of them.',
                ' Download all reports puts every written report in one zip.',
              ].join('')
            : 'Once teachers have been evaluated, build their reports and the school report on all of them here.'
        )
      ),
      h(
        'div',
        { class: 'page-actions' },
        writing ? h('button', { class: 'btn', type: 'button', onclick: () => reload() }, 'Refresh') : null,
        assessed.length ? buildAll : null,
        download?.button,
        h(
          'a',
          {
            class: `btn ${assessed.length ? 'btn-primary' : ''}`,
            href: `#/schools/${state.schoolId}/report/${state.testId}`,
            'aria-disabled': assessed.length ? null : 'true',
            onclick: assessed.length ? null : (event) => event.preventDefault(),
            style: assessed.length ? null : 'opacity:.55;cursor:not-allowed',
          },
          'School Report'
        )
      )
    ),
    download?.line
  );
}

/* ------------------------------------------------------------------- history */

function historyCard(state) {
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'All sittings in this test'),
    state.assessments.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h('tr', {}, h('th', {}, 'Sitting'), h('th', {}, 'Teacher'), h('th', {}, 'Date'), h('th', {}, 'Pages'), h('th', {}, 'Sections'), h('th', {}, 'Status'))
            ),
            h(
              'tbody',
              {},
              state.assessments.map((row) =>
                h(
                  'tr',
                  { style: 'cursor:pointer', onclick: () => window.navigate(`/assessments/${row.id}`) },
                  h('td', {}, row.title, row.paper_titles ? h('div', { class: 'hint' }, `Paper: ${row.paper_titles}`) : null),
                  h('td', {}, row.teacher_grade ? `${row.teacher_name} — ${row.teacher_grade}` : row.teacher_name),
                  h('td', {}, formatDate(row.assessment_date) || '—'),
                  h('td', {}, `${row.paper_titles ? 'Library paper' : `${row.question_paper_count} paper`} · ${row.response_count} answer`),
                  h(
                    'td',
                    {},
                    row.sections.length
                      ? [h('div', { class: 'chips' }, row.sections.map((section) => sectionChip(section, { short: true })), writingChip(row.sections, { teacherName: row.teacher_name })), lenientNote(row.sections)]
                      : row.score === null
                        ? '—'
                        : `${row.score}${row.max_score ? ` / ${row.max_score}` : ''}`
                  ),
                  h('td', {}, statusBadge(row.status))
                )
              )
            )
          )
        )
      : emptyState('Nothing has been scanned for this test yet.')
  );
}

/* ---------------------------------------------------------- assessment detail */

export async function renderAssessmentDetail(root, id) {
  let assessment = await assessmentsApi.get(id);
  const container = h('div', {});

  const refresh = async () => {
    assessment = await assessmentsApi.get(id);
    draw();
  };

  // While OpenAI is marking, check back every few seconds. The screen is only
  // redrawn once the marking has finished, so nothing typed meanwhile is lost.
  let polling = false;
  const watchMarking = async () => {
    if (polling || assessment.ai_status !== 'running') return;
    polling = true;
    while (container.isConnected) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (!container.isConnected) break;
      let latest;
      try {
        latest = await assessmentsApi.get(id);
      } catch {
        continue; // a dropped request is retried on the next round
      }
      if (latest.ai_status !== 'running') {
        assessment = latest;
        draw();
        if (latest.ai_status === 'done') {
          const marked = latest.sections.map((s) => `${s.name} ${s.percent}%`).join(', ');
          toast(`Marked${marked ? `: ${marked}` : ''}. The teacher’s reports are being written.`, 'success');
        }
        else toast('The marking did not finish. See the evaluation for why.', 'error');
        break;
      }
    }
    polling = false;
  };

  const runEvaluation = async (marking) => {
    try {
      assessment = await assessmentsApi.evaluate(assessment.id, marking);
      draw();
      watchMarking();
    } catch (error) {
      toast(error.message, 'error');
      await refresh();
    }
  };

  function draw() {
    mount(container,
      h(
        'div',
        { class: 'breadcrumb' },
        h('a', { href: `#/assessments?school=${assessment.school_id}${assessment.test_id ? `&test=${assessment.test_id}` : ''}` }, '← Assessments'),
        ' · ',
        h('a', { href: `#/teachers/${assessment.teacher_id}` }, `${assessment.teacher_name}’s profile`)
      ),
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, assessment.title),
          h('p', {}, `${assessment.teacher_name}${assessment.teacher_grade ? ` — ${assessment.teacher_grade}` : ''} · ${assessment.school_name}${assessment.test_name ? ` · ${assessment.test_name}` : ''} · ${assessment.section ? `Section ${assessment.section}` : 'Full paper'}${assessment.assessment_date ? ` · ${formatDate(assessment.assessment_date)}` : ''}`)
        ),
        h(
          'div',
          { class: 'page-actions' },
          statusBadge(assessment.status),
          h(
            'button',
            {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!confirmAction('Delete this assessment and its scans?')) return;
                await assessmentsApi.remove(assessment.id);
                toast('Assessment deleted.', 'success');
                window.navigate(`/assessments?school=${assessment.school_id}`);
              },
            },
            'Delete'
          )
        )
      ),
      scansCard(assessment, refresh),
      markingCard(assessment, runEvaluation, (updated) => {
        assessment = updated;
        draw();
      }),
      detailsCard(assessment, refresh)
    );
  }

  const scannerCheck = checkScannerOnce();
  draw();
  mount(root, container);
  watchMarking();
  scannerCheck.then((changed) => {
    if (changed && container.isConnected && !scanner.busy) draw();
  });
}

function scansCard(assessment, refresh) {
  const hasPages = assessment.question_paper_files.length > 0 || assessment.response_files.length > 0;
  const swap = hasPages && assessment.ai_status !== 'running'
    ? h('button', { class: 'btn btn-sm', type: 'button' }, 'Swap question paper and answer paper')
    : null;
  swap?.addEventListener('click', async () => {
    swap.disabled = true;
    try {
      await assessmentsApi.swap(assessment.id);
      toast(
        assessment.ai_result
          ? 'Swapped. Press Evaluate again to mark them the right way round.'
          : 'Swapped. Press the button again to undo.',
        'success'
      );
    } catch (error) {
      toast(error.message, 'error');
    }
    await refresh();
  });
  const move = hasPages && movableSitting(assessment)
    ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => moveSittingPages(assessment, null, refresh) }, 'Move to another teacher')
    : null;

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'scan-group-head' }, h('h2', { style: 'margin:0' }, 'Question paper and answer paper'), h('div', { class: 'row-actions' }, move, swap)),
    h(
      'p',
      { class: 'hint' },
      scanner.status === 'ready'
        ? 'Press Scan pages to feed them straight from the scanner, or drop image files here. You can add several at once.'
        : 'Scan the pages on your laptop, then drop the image files here. You can add several at once.'
    ),
    libraryPapers(assessment, refresh),
    scanGroup(assessment, 'question_paper', assessment.papers.length ? 'Scanned question paper pages' : 'Question paper', assessment.question_paper_files, refresh),
    scanGroup(assessment, 'response', 'Answer paper', assessment.response_files, refresh)
  );
}

// Pages filed under the wrong teacher can be moved until the paper is marked.
const movableSitting = (assessment) => assessment.status !== 'evaluated' && assessment.ai_status !== 'running';

async function moveSittingPages(assessment, kind, refresh) {
  const moved = await movePages({
    sitting: {
      id: assessment.id,
      teacher_id: assessment.teacher_id,
      teacher_name: assessment.teacher_name,
      school_id: assessment.school_id,
      question_paper_count: assessment.question_paper_files.length,
      response_count: assessment.response_files.length,
    },
    kind,
  });
  if (moved) await refresh();
}

// Papers from the library confirmed as this sitting's question paper. OpenAI
// reads them as PDFs, so nothing needs scanning for the question paper.
function libraryPapers(assessment, refresh) {
  const locked = assessment.ai_status === 'running';
  const teacher = { id: assessment.teacher_id, name: assessment.teacher_name, grade: assessment.teacher_grade };
  const choose = h(
    'button',
    { class: 'btn btn-sm', type: 'button', disabled: locked },
    assessment.papers.length ? 'Change paper' : 'Choose from the paper library'
  );
  choose.addEventListener('click', async () => {
    const ids = await choosePaper({ teacher, section: assessment.section ?? '', current: assessment.papers });
    if (!ids) return;
    try {
      await assessmentsApi.setPapers(assessment.id, ids);
      toast(assessment.ai_result ? 'Paper changed. Press Evaluate again to mark against it.' : 'Paper confirmed.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    await refresh();
  });

  const remove = async (paper) => {
    if (!confirmAction(`Stop using “${paper.title}” as the question paper? It stays in the library.`)) return;
    try {
      await assessmentsApi.setPapers(assessment.id, assessment.papers.filter((p) => p.id !== paper.id).map((p) => p.id));
      toast('Paper removed from this sitting.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    await refresh();
  };

  return h(
    'div',
    { class: 'scan-group' },
    h('div', { class: 'scan-group-head' }, h('h3', {}, 'Question paper from the library'), choose),
    assessment.papers.length
      ? h(
          'div',
          { class: 'paper-list' },
          assessment.papers.map((paper) =>
            h(
              'div',
              { class: 'paper-chosen' },
              paperThumb(paper, 'paper-thumb paper-thumb-lg'),
              h(
                'div',
                { class: 'paper-chosen-text' },
                h('strong', {}, paper.title),
                h('div', { class: 'hint' }, paperFacts(paper)),
                paper.notes ? h('div', { class: 'hint' }, paper.notes) : null,
                h(
                  'div',
                  { class: 'row-actions', style: 'justify-content:flex-start;margin-top:6px' },
                  h('a', { class: 'btn btn-sm', href: `/uploads/${paper.stored_name}`, target: '_blank', rel: 'noopener' }, 'Open'),
                  locked ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => remove(paper) }, 'Remove')
                )
              )
            )
          )
        )
      : h('p', { class: 'hint' }, 'None chosen. Choose the paper the teacher sat from the library, or scan or upload the question paper below.')
  );
}

function scanGroup(assessment, kind, label, files, refresh) {
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true });

  const upload = async (list) => {
    const chosen = Array.from(list ?? []);
    if (!chosen.length) return;
    const data = new FormData();
    data.set('kind', kind);
    for (const file of chosen) data.append('files', file);
    dropzoneLabel.textContent = `Uploading ${chosen.length} page${chosen.length === 1 ? '' : 's'}…`;
    try {
      await assessmentsApi.uploadFiles(assessment.id, data);
      toast(`${chosen.length} page${chosen.length === 1 ? '' : 's'} added.`, 'success');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
      await refresh();
    }
  };

  fileInput.addEventListener('change', () => upload(fileInput.files));

  const scanButton = scanner.status === 'ready'
    ? h('button', { class: 'btn btn-sm', type: 'button' }, 'Scan pages')
    : null;
  scanButton?.addEventListener('click', async () => {
    scanButton.disabled = true;
    scanButton.textContent = 'Scanning…';
    const what = `${assessment.section ? `Section ${assessment.section} ` : ''}${KIND_NAMES[kind]}`;
    const dialog = scanningDialog(assessment.teacher_name, what);
    let scan;
    try {
      scan = await scanWithDialog(dialog, { teacherName: assessment.teacher_name, label: `${assessment.teacher_name} - ${KIND_NAMES[kind]}` });
    } catch (error) {
      dialog.close();
      toast(error.message, 'error');
      await refresh();
      return;
    }
    if (!scan) {
      await refresh();
      return;
    }
    if (scan.warning) toast(scan.warning, 'error');
    dialog.say(`Filing ${pageCount(scan.files.length)} as ${assessment.teacher_name}’s ${what}…`);
    await upload(scan.files);
    dialog.close();
  });

  // On a phone the same file picker can take photos with the camera.
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const dropzoneLabel = h('span', {}, touch ? 'Tap to take photos of the pages or choose images' : 'Drop scanned images here, or click to choose files');

  const dropzone = h(
    'div',
    {
      class: 'dropzone',
      onclick: () => fileInput.click(),
      ondragover: (event) => {
        event.preventDefault();
        dropzone.classList.add('dragover');
      },
      ondragleave: () => dropzone.classList.remove('dragover'),
      ondrop: (event) => {
        event.preventDefault();
        dropzone.classList.remove('dragover');
        upload(event.dataTransfer.files);
      },
    },
    dropzoneLabel
  );
  dropzone.append(fileInput);

  const thumbs = files.length
    ? h(
        'div',
        { class: 'thumbs' },
        files.map((file, index) =>
          h(
            'div',
            { class: 'thumb' },
            h('img', {
              src: `/uploads/${file.stored_name}`,
              alt: file.original_name,
              loading: 'lazy',
              onclick: () => viewPages({
                title: `${assessment.teacher_name} · ${capitalise(KIND_NAMES[kind])}`,
                pages: files.map((page) => ({ src: `/uploads/${page.stored_name}`, name: page.original_name })),
                start: index,
                action: movableSitting(assessment)
                  ? { label: 'Wrong teacher? Move these pages', run: () => moveSittingPages(assessment, kind, refresh) }
                  : null,
              }),
            }),
            h(
              'div',
              { class: 'thumb-foot' },
              h('span', { title: file.original_name }, file.original_name),
              h(
                'button',
                {
                  class: 'remove',
                  title: 'Remove this page',
                  onclick: async () => {
                    if (!confirmAction(`Remove ${file.original_name}?`)) return;
                    await assessmentsApi.removeFile(assessment.id, file.id);
                    toast('Page removed.', 'success');
                    await refresh();
                  },
                },
                'Remove'
              )
            ),
            h('div', { class: 'thumb-foot', style: 'padding-top:0' }, h('span', {}, formatBytes(file.size_bytes)))
          )
        )
      )
    : h('p', { class: 'hint' }, 'No pages uploaded yet.');

  return h(
    'div',
    { class: 'scan-group' },
    h('div', { class: 'scan-group-head' }, h('h3', {}, `${label} (${files.length})`), scanButton),
    thumbs,
    h('div', { style: 'height:12px' }),
    dropzone
  );
}

// The OpenAI marking: a button to run it, its progress, and the marks it gave
// question by question, grouped by section.
function markingCard(assessment, runEvaluation, onSaved) {
  const hasScans = (assessment.question_paper_files.length > 0 || assessment.papers.length > 0) && assessment.response_files.length > 0;
  const running = assessment.ai_status === 'running';
  const result = assessment.ai_result;

  const button = h(
    'button',
    { class: `btn ${result ? '' : 'btn-primary'}`, type: 'button', disabled: running || !hasScans },
    running ? 'Marking…' : result ? 'Evaluate again' : 'Evaluate'
  );
  button.addEventListener('click', async () => {
    const marking = await chooseMarking({ teacherName: assessment.teacher_name, current: result ? (result.marking ?? 'standard') : null, again: Boolean(result) });
    if (!marking) return;
    button.disabled = true;
    button.textContent = 'Starting…';
    runEvaluation(marking);
  });

  let body;
  if (running) {
    body = h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), 'OpenAI is marking each question, then checking the writing. Answers not all in English are read by Gemini first. This usually takes a few minutes; you can leave this page and come back.');
  } else if (assessment.ai_status === 'failed') {
    body = h('div', { class: 'marking-state error' }, assessment.ai_error || 'The marking did not finish.');
  } else if (!hasScans) {
    body = h('p', { class: 'hint' }, 'Choose or upload the question paper and upload the teacher’s answer paper above, then press Evaluate.');
  } else if (!result) {
    body = h('p', { class: 'hint' }, `Press Evaluate to have OpenAI mark the teacher’s answer paper against the question paper${assessment.section ? `, as Section ${assessment.section} only` : ''}.`);
  }

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'scan-group-head' }, h('h2', { style: 'margin:0' }, 'Marking'), button),
    body ?? null,
    result ? markingResult(assessment, result, onSaved) : null
  );
}

const notAttempted = (q) => !String(q.teacher_answer ?? '').trim() && !(Number(q.marks_awarded) > 0);

// How the marks were counted, chosen when Evaluate was pressed.
function markingNote(result, sections) {
  if (result.marking !== 'lenient') return h('p', { class: 'hint' }, 'Standard marking: every question counts, including any not attempted.');
  const count = sections.reduce((n, s) => n + (s.left_out || 0), 0);
  const worth = Math.round(sections.reduce((n, s) => n + (s.left_out_marks || 0), 0) * 100) / 100;
  return h(
    'p',
    { class: 'notice' },
    count
      ? `Lenient marking: ${count === 1 ? 'one question' : `${count} questions`} not attempted, worth ${worth} marks, ${count === 1 ? 'is' : 'are'} left out of the marks and the total.`
      : 'Lenient marking: every question was attempted, so nothing is left out.'
  );
}

// Each section is graded on its own; there is no overall percentage. Every
// question's marks can be corrected, and the section grades and reports follow.
function markingResult(assessment, result, onSaved) {
  const lenient = result.marking === 'lenient';
  const list = (title, items) =>
    items.length ? h('div', {}, h('h3', {}, title), h('ul', {}, items.map((item) => h('li', {}, item)))) : null;

  const markInputs = result.questions.map((q) =>
    h('input', { type: 'number', class: 'mark-input', min: 0, max: q.max_marks, step: 0.5, value: q.marks_awarded, 'aria-label': `Marks for ${q.question}` })
  );
  const saveButton = h('button', { class: 'btn btn-sm btn-primary', type: 'button', style: 'display:none' }, 'Save corrected marks');
  const changed = () => markInputs.some((el, i) => Number(el.value) !== result.questions[i].marks_awarded);
  for (const el of markInputs) el.addEventListener('input', () => { saveButton.style.display = changed() ? '' : 'none'; });
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      const updated = await assessmentsApi.saveMarks(assessment.id, markInputs.map((el) => el.value));
      toast('Marks saved. Rebuild the teacher’s report to take them in.', 'success');
      onSaved(updated);
    } catch (error) {
      toast(error.message, 'error');
      saveButton.disabled = false;
    }
  });

  return h(
    'div',
    { class: 'marking-result' },
    h('div', { class: 'marking-total chips' }, assessment.sections.map((section) => sectionChip(section))),
    h('p', { class: 'hint' }, assessment.sections.map((s) => `${s.name}: ${s.awarded} / ${s.max}${s.grade_label ? ` (${s.grade_label})` : ''}`).join(' · ')),
    markingNote(result, assessment.sections),
    writingCard(assessment, onSaved),
    result.pages_swapped
      ? h(
          'p',
          { class: 'notice' },
          'The question paper and the answer paper were uploaded the wrong way round. OpenAI marked them the right way round, and they have been swapped back above.'
        )
      : null,
    assessment.unanswered_sections.length
      ? h(
          'p',
          { class: 'notice' },
          assessment.sections.length
            ? `Nothing was written for ${assessment.unanswered_sections.join(' or ')} in this response, so it is treated as not sat and left out of the results. When the teacher sits it, scan it on their row and press Evaluate; it is added to this test.`
            : 'OpenAI found nothing written in any section of this response, so nothing is graded. Check that the response pages are the teacher’s answer sheets, then press Evaluate again.'
        )
      : null,
    result.summary ? h('p', {}, result.summary) : null,
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Section'), h('th', {}, 'Question'), h('th', {}, 'Marks'), h('th', {}, 'Feedback'))),
        h(
          'tbody',
          {},
          result.questions.map((q, i) =>
            h(
              'tr',
              {},
              h('td', {}, q.section || '—'),
              h('td', {}, q.question, q.question_text ? h('div', { class: 'hint question-asked', dir: 'auto' }, q.question_text) : null),
              h(
                'td',
                { style: 'white-space:nowrap' },
                markInputs[i],
                ` / ${q.max_marks}`,
                notAttempted(q) ? h('span', { class: 'q-blank' }, lenient ? 'not counted' : 'not attempted') : null
              ),
              h(
                'td',
                {},
                q.feedback,
                q.teacher_answer
                  ? h('details', { class: 'teacher-answer' }, h('summary', {}, 'What the teacher wrote'), h('div', { dir: 'auto' }, q.teacher_answer))
                  : null,
                q.expected_answer
                  ? h('details', { class: 'teacher-answer' }, h('summary', {}, 'What should have been answered'), h('div', { dir: 'auto' }, q.expected_answer))
                  : null
              )
            )
          )
        )
      )
    ),
    h('div', { class: 'form-actions', style: 'margin-top:10px' }, saveButton),
    h('div', { class: 'marking-lists' }, list('Strengths', result.strengths), list('Areas to improve', result.areas_to_improve)),
    h(
      'p',
      { class: 'hint' },
      `Marked by OpenAI (${assessment.ai_model})${assessment.ai_evaluated_at ? ` on ${formatDate(assessment.ai_evaluated_at.slice(0, 10))}` : ''}. ${readingNote(result.reading)}If you disagree with a mark, change it in the Marks column and save.`
    ),
    h(
      'p',
      {},
      h('a', { class: 'btn btn-sm', href: `#/teachers/${assessment.teacher_id}/report/${assessment.test_id}` }, 'Open the teacher’s reports')
    )
  );
}

// Each section's Written Expression, beside the marks. Clicking a score opens
// the errors found. A sitting marked before Evaluate checked the writing, or
// whose check failed, has a button to check it now.
function writingCard(assessment, onSaved) {
  const sections = assessment.sections;
  if (!sections.length) return null;
  const checked = checkedSections(sections);
  const problem = sections.find((s) => s.writing && !s.writing.checked)?.writing.problem;
  let action = null;
  if (checked.length < sections.length) {
    action = h('button', { class: 'btn btn-sm', type: 'button' }, problem ? 'Check the writing again' : 'Check the writing');
    action.addEventListener('click', async () => {
      action.disabled = true;
      action.textContent = 'Checking… (about a minute)';
      try {
        const updated = await assessmentsApi.checkWriting(assessment.id);
        toast('Writing checked. Rebuild the teacher’s report to take it in.', 'success');
        onSaved(updated);
      } catch (error) {
        toast(error.message, 'error');
        action.disabled = false;
        action.textContent = 'Check the writing again';
      }
    });
  }
  const open = (list) => openWritingReport({ teacherName: assessment.teacher_name, sections: list });
  return h(
    'div',
    { class: 'writing-card' },
    h('div', { class: 'scan-group-head' }, h('h3', { style: 'margin:0' }, WRITING_NAME), action),
    checked.length
      ? h(
          'div',
          { class: 'writing-scores' },
          checked.map((s) =>
            h(
              'button',
              { type: 'button', class: 'writing-score-button', onclick: () => open([s]) },
              h('strong', {}, s.name),
              h('span', {}, writingLine(s.writing)),
              s.writing.judged || s.writing.errors.length
                ? h('span', { class: 'hint' }, `${s.writing.errors.length} error${s.writing.errors.length === 1 ? '' : 's'} · see them`)
                : null
            )
          )
        )
      : null,
    h(
      'p',
      { class: 'hint', style: 'margin:6px 0 0' },
      checked.length
        ? 'How well the answers are written: sentence formation, grammar, spelling and punctuation, and word choice, judged in the language they are written in. It does not change the marks. Click a score to see the errors.'
        : problem
          ? `The writing could not be checked: ${problem}`
          : 'This paper was marked before the writing was checked. Press Check the writing, or rebuild the teacher’s report, to add it. The marks stay as they are.'
    )
  );
}

// Which model read the answers, from the language they are in. Sittings
// marked before the language check say nothing.
function readingNote(reading) {
  if (!reading) return '';
  const names = reading.languages ?? [];
  const languages = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  if (reading.read_by === 'gemini') {
    return `The answers are ${languages ? `in ${languages}` : 'not all in English'}, so Gemini (${reading.model}) read them first. `;
  }
  return 'The answers are in English, so OpenAI read them itself. ';
}

function detailsCard(assessment, refresh) {
  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        try {
          await assessmentsApi.update(assessment.id, data);
          toast('Saved.', 'success');
          await refresh();
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('Title', input('title', { value: assessment.title, required: true })),
      field('Date', input('assessment_date', { type: 'date', value: assessment.assessment_date ?? '' })),
      field('Paper', select('section', SECTION_OPTIONS, { value: assessment.section ?? '' }), {
        hint: 'A single section is marked as that section only.',
      }),
      field('Subject', input('subject', { value: assessment.subject })),
      field('Status', select('status', STATUS_OPTIONS, { value: assessment.status })),
      // With OpenAI's marks, scores come from the questions above. Without
      // them, a score can still be entered by hand.
      assessment.ai_result ? h('input', { type: 'hidden', name: 'score', value: assessment.score ?? '' }) : field('Score', input('score', { type: 'number', value: assessment.score ?? '' })),
      assessment.ai_result ? h('input', { type: 'hidden', name: 'max_score', value: assessment.max_score ?? '' }) : field('Out of', input('max_score', { type: 'number', value: assessment.max_score ?? '' })),
      field('Evaluation notes', textarea('notes', { value: assessment.notes, placeholder: 'What stood out, what to work on…' }), { span: true })
    ),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save assessment'))
  );

  return h('div', { class: 'card' }, h('h2', {}, assessment.ai_result ? 'Details' : 'Details and score'), form);
}
