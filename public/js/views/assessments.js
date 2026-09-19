import {
  h, mount, field, input, textarea, select, toast, confirmAction, statusBadge,
  formatDate, formatBytes, emptyState, openLightbox,
} from '../ui.js';
import { schoolsApi, teachersApi, assessmentsApi } from '../api.js';

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
    teacherId: query.get('teacher') ?? '',
    teachers: [],
    assessments: [],
  };

  const container = h('div', {});

  async function load() {
    const [teachers, assessments] = await Promise.all([
      teachersApi.list({ school_id: state.schoolId }),
      assessmentsApi.list(state.teacherId ? { teacher_id: state.teacherId } : { school_id: state.schoolId }),
    ]);
    state.teachers = teachers;
    state.assessments = assessments;
    draw();
  }

  function draw() {
    const schoolSelect = select('school', schools.map((s) => ({ value: String(s.id), label: s.name })), { value: state.schoolId });
    schoolSelect.addEventListener('change', () => {
      state.schoolId = schoolSelect.value;
      state.teacherId = '';
      load();
    });

    const teacherSelect = select(
      'teacher',
      [{ value: '', label: 'All teachers' }, ...state.teachers.map((t) => ({ value: String(t.id), label: t.grade ? `${t.name} — ${t.grade}` : t.name }))],
      { value: state.teacherId }
    );
    teacherSelect.addEventListener('change', () => {
      state.teacherId = teacherSelect.value;
      load();
    });

    const pickerCard = h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Pick a school and teacher'),
      h('p', { class: 'hint' }, 'Choose the school, then the teacher whose paper you are evaluating.'),
      h('div', { class: 'form-grid' }, field('School', schoolSelect), field('Teacher', teacherSelect)),
      state.teachers.length
        ? null
        : h('p', { class: 'hint', style: 'margin-top:12px' }, h('a', { href: `#/schools/${state.schoolId}` }, 'This school has no teachers yet — add or import them first.'))
    );

    const newCard = state.teachers.length ? newAssessmentCard(state, load) : null;

    const listCard = h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Assessments'),
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
        : emptyState('No assessments for this selection yet.')
    );

    mount(container, 
      h(
        'div',
        { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Assessments'), h('p', {}, 'Start an assessment, then upload the scanned question paper and the teacher’s responses.'))
      ),
      h('div', { class: 'grid-2' }, pickerCard, newCard),
      listCard
    );
  }

  mount(root, container);
  await load();
}

function newAssessmentCard(state, reload) {
  const teacherSelect = select(
    'teacher_id',
    state.teachers.map((t) => ({ value: String(t.id), label: t.grade ? `${t.name} — ${t.grade}` : t.name })),
    { value: state.teacherId || String(state.teachers[0].id), id: 'f-new-teacher' }
  );

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        try {
          const created = await assessmentsApi.create(data);
          toast('Assessment created — now upload the scans.', 'success');
          window.navigate(`/assessments/${created.id}`);
          await reload();
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('Teacher', teacherSelect),
      field('Date', input('assessment_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })),
      field('Title', input('title', { placeholder: 'Term 1 classroom observation' }), { span: true, hint: 'Leave blank and the teacher’s name is used.' }),
      field('Subject', input('subject', { placeholder: 'Mathematics' }))
    ),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Start assessment'))
  );

  return h('div', { class: 'card' }, h('h2', {}, 'Start a new assessment'), h('p', { class: 'hint' }, 'You can upload the scans on the next screen.'), form);
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

  draw();
  mount(root, container);
}

function scansCard(assessment, refresh) {
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Scanned pages'),
    h('p', { class: 'hint' }, 'Scan the pages on your laptop, then drop the image files here. You can add several at once.'),
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
    h('div', { class: 'scan-group-head' }, h('h3', {}, `${label} (${files.length})`)),
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
