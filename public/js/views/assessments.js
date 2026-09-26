import {
  h, mount, field, input, textarea, select, toast, confirmAction, statusBadge,
  formatDate, formatBytes, emptyState, openLightbox,
} from '../ui.js';
import { schoolsApi, teachersApi, assessmentsApi } from '../api.js';
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
    roster: [],
    assessments: [],
  };

  const container = h('div', {});

  async function load() {
    const [roster, assessments] = await Promise.all([
      teachersApi.roster(state.schoolId),
      assessmentsApi.list({ school_id: state.schoolId }),
    ]);
    state.roster = roster;
    state.assessments = assessments;
    draw();
  }

  function draw() {
    const schoolSelect = select('school', schools.map((s) => ({ value: String(s.id), label: s.name })), { value: state.schoolId });
    schoolSelect.addEventListener('change', () => {
      state.schoolId = schoolSelect.value;
      load();
    });

    mount(container,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, 'Assessments'),
          h('p', {}, 'Upload each teacher’s question paper and response on their row. Evaluating is a separate step.')
        )
      ),
      h('div', { class: 'card' }, h('div', { class: 'form-grid' }, field('School', schoolSelect))),
      teacherBoardCard(state, load, draw),
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
    h('p', { class: 'hint' }, 'Uploading pages only files them against the teacher. Nothing is evaluated until you press Evaluate.'),
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
                h('strong', {}, teacher.name),
                [teacher.grade, teacher.subjects].filter(Boolean).length
                  ? h('div', { class: 'hint' }, [teacher.grade, teacher.subjects].filter(Boolean).join(' · '))
                  : null
              ),
              h('td', {}, scanCell(teacher, 'question_paper', teacher.question_paper_count, reload, redraw)),
              h('td', {}, scanCell(teacher, 'response', teacher.response_count, reload, redraw)),
              h(
                'td',
                {},
                teacher.assessment_id
                  ? statusBadge(teacher.assessment_status)
                  : h('span', { class: 'badge draft' }, 'Not started'),
                teacher.score === null || teacher.score === undefined
                  ? null
                  : h('div', { class: 'hint' }, `${teacher.score}${teacher.max_score ? ` / ${teacher.max_score}` : ''}`)
              ),
              h('td', { class: 'right' }, evaluateButton(teacher))
            )
          )
        )
      )
    )
  );
}

// One upload control for one kind of scan, on one teacher's row. With the
// scanner connected the button scans; otherwise it picks image files.
function scanCell(teacher, kind, count, reload, redraw) {
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

// Opens the evaluation screen. If this teacher has no assessment yet, one is
// created first — uploading is not a prerequisite for evaluating.
function evaluateButton(teacher) {
  const button = h(
    'button',
    { class: 'btn btn-sm btn-primary', type: 'button' },
    teacher.assessment_status === 'evaluated' ? 'Review' : 'Evaluate'
  );

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const id = teacher.assessment_id ?? (await teachersApi.currentAssessment(teacher.id)).id;
      window.navigate(`/assessments/${id}`);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });

  return button;
}

/* ------------------------------------------------------------------- history */

function historyCard(state) {
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'All assessments'),
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
              h('tr', {}, h('th', {}, 'Assessment'), h('th', {}, 'Teacher'), h('th', {}, 'Date'), h('th', {}, 'Pages'), h('th', {}, 'Score'), h('th', {}, 'Status'))
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
                  h('td', {}, row.score === null ? '—' : `${row.score}${row.max_score ? ` / ${row.max_score}` : ''}`),
                  h('td', {}, statusBadge(row.status))
                )
              )
            )
          )
        )
      : emptyState('Nothing has been started for this school yet.')
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

  function draw() {
    mount(container,
      h('div', { class: 'breadcrumb' }, h('a', { href: `#/assessments?school=${assessment.school_id}` }, '← All assessments')),
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, assessment.title),
          h('p', {}, `${assessment.teacher_name}${assessment.teacher_grade ? ` — ${assessment.teacher_grade}` : ''} · ${assessment.school_name}${assessment.assessment_date ? ` · ${formatDate(assessment.assessment_date)}` : ''}`)
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
      detailsCard(assessment, refresh)
    );
  }

  const scannerCheck = checkScannerOnce();
  draw();
  mount(root, container);
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
      field('Score', input('score', { type: 'number', value: assessment.score ?? '' })),
      field('Out of', input('max_score', { type: 'number', value: assessment.max_score ?? '' })),
      field('Evaluation notes', textarea('notes', { value: assessment.notes, placeholder: 'What stood out, what to work on…' }), { span: true })
    ),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save assessment'))
  );

  return h('div', { class: 'card' }, h('h2', {}, 'Evaluation'), form);
}
