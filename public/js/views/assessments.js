import {
  h, mount, field, input, textarea, select, toast, confirmAction, statusBadge,
  formatDate, formatBytes, emptyState, openLightbox, sectionChip,
} from '../ui.js';
import { schoolsApi, teachersApi, assessmentsApi, testsApi } from '../api.js';
import {
  scanner, scanPages, connectScanner, stopScanning, checkScannerOnce, selectScanner, selectedScanner,
  scanBothSides, setScanBothSides, HELPER_DOWNLOAD_URL,
} from '../scanner.js';

const KIND_NAMES = { question_paper: 'question paper', response: 'response' };

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
    tests: [],
    roster: [],
    assessments: [],
  };

  const container = h('div', {});

  async function load() {
    state.tests = await testsApi.list(state.schoolId);
    if (!state.tests.some((t) => String(t.id) === String(state.testId))) state.testId = String(state.tests[0].id);
    const [roster, assessments] = await Promise.all([
      teachersApi.roster(state.schoolId, state.testId),
      assessmentsApi.list({ school_id: state.schoolId, test_id: state.testId }),
    ]);
    state.roster = roster.teachers;
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

    mount(container,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, 'Assessments'),
          h('p', {}, 'Upload each teacher’s question paper and response on their row, then press Evaluate to have OpenAI mark it. Sections sat on different dates add up under the same test.')
        )
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'form-grid' },
          field('School', schoolSelect),
          field('Test', testControls, { hint: 'Each test is one round, such as a pre-training and a post-training test.' })
        )
      ),
      teacherBoardCard(state, load, draw),
      schoolReportCard(state),
      historyCard(state)
    );
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
    h('h2', {}, `Teachers (${state.roster.length})`),
    h('p', { class: 'hint' }, 'Uploading pages only files them against the teacher. Nothing is marked until you press Evaluate.'),
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
            h('th', {}, 'Question paper'),
            h('th', {}, 'Teacher’s response'),
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
              {},
              h(
                'td',
                {},
                h('a', { class: 'teacher-link', href: `#/teachers/${teacher.id}` }, teacher.name),
                [teacher.grade, teacher.subjects].filter(Boolean).length
                  ? h('div', { class: 'hint' }, [teacher.grade, teacher.subjects].filter(Boolean).join(' · '))
                  : null
              ),
              h('td', {}, scanCell(state, teacher, 'question_paper', teacher.question_paper_count, reload, redraw)),
              h('td', {}, scanCell(state, teacher, 'response', teacher.response_count, reload, redraw)),
              h(
                'td',
                {},
                teacher.ai_status === 'running'
                  ? h('span', { class: 'badge running' }, 'Marking…')
                  : teacher.assessment_id
                    ? statusBadge(teacher.assessment_status)
                    : h('span', { class: 'badge draft' }, 'Not started')
              ),
              h(
                'td',
                {},
                teacher.sections.length
                  ? h('div', { class: 'chips' }, teacher.sections.map((section) => sectionChip(section, { short: true })))
                  : h('span', { class: 'hint' }, '—')
              ),
              h(
                'td',
                { class: 'right' },
                h(
                  'div',
                  { class: 'row-actions' },
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
// scanner connected the button scans; otherwise it picks image files.
function scanCell(state, teacher, kind, count, reload, redraw) {
  const label = count ? `${count} page${count === 1 ? '' : 's'}` : 'None yet';
  const scanning = scanner.status === 'ready';
  const idleLabel = scanning ? (count ? 'Scan more' : 'Scan') : count ? 'Add pages' : 'Upload';
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  const button = h('button', { class: 'btn btn-sm', type: 'button' }, idleLabel);

  const settle = () => {
    button.disabled = false;
    button.textContent = idleLabel;
    fileInput.value = '';
  };

  const upload = async (files, { scanned = false, warning = '' } = {}) => {
    const data = new FormData();
    data.set('kind', kind);
    data.set('test_id', state.testId);
    for (const file of files) data.append('files', file);

    button.textContent = 'Uploading…';
    try {
      await teachersApi.uploadScans(teacher.id, data);
      const pages = `${files.length} page${files.length === 1 ? '' : 's'}`;
      toast(`${pages} ${scanned ? 'scanned' : 'added'} for ${teacher.name}.`, 'success');
      if (warning) toast(warning, 'error');
      await reload(); // redraws the whole board, so the button state goes with it
    } catch (error) {
      const kept = scanned && scanner.folder ? ` The scanned pages are also saved on this laptop in ${scanner.folder}.` : '';
      toast(`${error.message}${kept}`, 'error');
      settle();
    }
  };

  button.addEventListener('click', async () => {
    if (!scanning) {
      fileInput.click();
      return;
    }
    button.disabled = true;
    button.textContent = 'Scanning…';
    let scan;
    try {
      scan = await scanPages({ label: `${teacher.name} - ${KIND_NAMES[kind]}` });
    } catch (error) {
      toast(error.message, 'error');
      settle();
      if (error.helperGone) redraw();
      return;
    }
    await upload(scan.files, { scanned: true, warning: scan.warning });
  });

  fileInput.addEventListener('change', () => {
    const chosen = Array.from(fileInput.files ?? []);
    if (!chosen.length) return;
    button.disabled = true;
    upload(chosen);
  });

  return h('div', { class: 'scan-cell' }, h('span', { class: 'scan-count' }, label), button, fileInput);
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

// Evaluate marks the teacher's scans with OpenAI, then opens the evaluation
// screen, which shows the marking as it finishes. Without both sets of scans it
// just opens the screen. If this teacher has no assessment yet, one is created.
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
      const id = teacher.assessment_id ?? (await teachersApi.currentAssessment(teacher.id, state.testId)).id;
      const ready = teacher.question_paper_count > 0 && teacher.response_count > 0;
      if (!evaluated && !running && ready) {
        try {
          await assessmentsApi.evaluate(id);
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

// The management report on all of the school's teachers, offered at the end.
function schoolReportCard(state) {
  const assessed = state.roster.filter((t) => t.sections.length).length;
  if (!state.roster.length) return null;
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'scan-group-head' },
      h(
        'div',
        {},
        h('h2', { style: 'margin:0' }, 'Report on All Teachers'),
        h(
          'p',
          { class: 'hint', style: 'margin:4px 0 0' },
          assessed
            ? `${assessed} of ${state.roster.length} teachers have results in this test. When you have evaluated everyone you want in it, build the management report on all of them.`
            : 'Once teachers have been evaluated, build a management report on all of them here.'
        )
      ),
      h(
        'a',
        {
          class: `btn ${assessed ? 'btn-primary' : ''}`,
          href: `#/schools/${state.schoolId}/report/${state.testId}`,
          'aria-disabled': assessed ? null : 'true',
          onclick: assessed ? null : (event) => event.preventDefault(),
          style: assessed ? null : 'opacity:.55;cursor:not-allowed',
        },
        'Management Report'
      )
    )
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
                  h('td', {}, row.title),
                  h('td', {}, row.teacher_grade ? `${row.teacher_name} — ${row.teacher_grade}` : row.teacher_name),
                  h('td', {}, formatDate(row.assessment_date) || '—'),
                  h('td', {}, `${row.question_paper_count} paper · ${row.response_count} response`),
                  h(
                    'td',
                    {},
                    row.sections.length
                      ? h('div', { class: 'chips' }, row.sections.map((section) => sectionChip(section, { short: true })))
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

  const runEvaluation = async () => {
    try {
      assessment = await assessmentsApi.evaluate(assessment.id);
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
          h('p', {}, `${assessment.teacher_name}${assessment.teacher_grade ? ` — ${assessment.teacher_grade}` : ''} · ${assessment.school_name}${assessment.test_name ? ` · ${assessment.test_name}` : ''}${assessment.assessment_date ? ` · ${formatDate(assessment.assessment_date)}` : ''}`)
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
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Scanned pages'),
    h(
      'p',
      { class: 'hint' },
      scanner.status === 'ready'
        ? 'Press Scan pages to feed them straight from the scanner, or drop image files here. You can add several at once.'
        : 'Scan the pages on your laptop, then drop the image files here. You can add several at once.'
    ),
    scanGroup(assessment, 'question_paper', 'Question paper', assessment.question_paper_files, refresh),
    scanGroup(assessment, 'response', 'Teacher’s response', assessment.response_files, refresh)
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
    let scan;
    try {
      scan = await scanPages({ label: `${assessment.teacher_name} - ${KIND_NAMES[kind]}` });
    } catch (error) {
      toast(error.message, 'error');
      await refresh();
      return;
    }
    if (scan.warning) toast(scan.warning, 'error');
    await upload(scan.files);
  });

  const dropzoneLabel = h('span', {}, 'Drop scanned images here, or click to choose files');

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
        files.map((file) =>
          h(
            'div',
            { class: 'thumb' },
            h('img', {
              src: `/uploads/${file.stored_name}`,
              alt: file.original_name,
              loading: 'lazy',
              onclick: () => openLightbox(`/uploads/${file.stored_name}`, file.original_name),
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
  const hasScans = assessment.question_paper_files.length > 0 && assessment.response_files.length > 0;
  const running = assessment.ai_status === 'running';
  const result = assessment.ai_result;

  const button = h(
    'button',
    { class: `btn ${result ? '' : 'btn-primary'}`, type: 'button', disabled: running || !hasScans },
    running ? 'Marking…' : result ? 'Evaluate again' : 'Evaluate'
  );
  button.addEventListener('click', () => {
    if (result && !confirmAction('Mark this again with OpenAI? The new marks replace the current ones, including any you corrected.')) return;
    button.disabled = true;
    button.textContent = 'Starting…';
    runEvaluation();
  });

  let body;
  if (running) {
    body = h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), 'OpenAI is reading the scans and marking each question. This usually takes a minute or two; you can leave this page and come back.');
  } else if (assessment.ai_status === 'failed') {
    body = h('div', { class: 'marking-state error' }, assessment.ai_error || 'The marking did not finish.');
  } else if (!hasScans) {
    body = h('p', { class: 'hint' }, 'Scan or upload the question paper and the teacher’s response above, then press Evaluate.');
  } else if (!result) {
    body = h('p', { class: 'hint' }, 'Press Evaluate to have OpenAI mark the teacher’s response against the question paper.');
  }

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'scan-group-head' }, h('h2', { style: 'margin:0' }, 'Marking'), button),
    body ?? null,
    result ? markingResult(assessment, result, onSaved) : null
  );
}

// Each section is graded on its own; there is no overall percentage. Every
// question's marks can be corrected, and the section grades and reports follow.
function markingResult(assessment, result, onSaved) {
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
              h('td', {}, q.question),
              h('td', { style: 'white-space:nowrap' }, markInputs[i], ` / ${q.max_marks}`),
              h(
                'td',
                {},
                q.feedback,
                q.teacher_answer
                  ? h('details', { class: 'teacher-answer' }, h('summary', {}, 'What the teacher wrote'), h('div', { dir: 'auto' }, q.teacher_answer))
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
      `Marked by OpenAI (${assessment.ai_model})${assessment.ai_evaluated_at ? ` on ${formatDate(assessment.ai_evaluated_at.slice(0, 10))}` : ''}. If you disagree with a mark, change it in the Marks column and save.`
    ),
    h(
      'p',
      {},
      h('a', { class: 'btn btn-sm', href: `#/teachers/${assessment.teacher_id}/report/${assessment.test_id}` }, 'Open the teacher’s reports')
    )
  );
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
