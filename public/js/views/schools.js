import { h, mount, field, input, textarea, toast, confirmAction, logoFor, emptyState } from '../ui.js';
import { schoolsApi, teachersApi } from '../api.js';

/* ---------------------------------------------------------------- schools list */

export async function renderSchools(root) {
  const schools = await schoolsApi.list();

  const listCard = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Schools'),
    h('p', { class: 'hint' }, 'Select a school to manage its teachers.'),
    schools.length
      ? h(
          'div',
          { class: 'school-list' },
          schools.map((school) =>
            h(
              'div',
              { class: 'school-row', onclick: () => window.navigate(`/schools/${school.id}`) },
              logoFor(school),
              h(
                'div',
                { class: 'meta' },
                h('strong', {}, school.name),
                h('small', {}, [school.city, school.state].filter(Boolean).join(', ') || 'No location set')
              ),
              h('div', { class: 'hint' }, `${school.teacher_count} teacher${school.teacher_count === 1 ? '' : 's'} · ${school.assessment_count} assessment${school.assessment_count === 1 ? '' : 's'}`)
            )
          )
        )
      : emptyState('No schools yet. Add the first one with the form alongside.')
  );

  mount(root, 
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Schools & teachers'), h('p', {}, 'Set up each school, upload its logo, and load its teachers.'))
    ),
    h('div', { class: 'grid-2' }, listCard, schoolFormCard())
  );
}

function schoolFormCard(school = null, onSaved = null) {
  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const data = new FormData(form);
          const saved = school ? await schoolsApi.update(school.id, data) : await schoolsApi.create(data);
          toast(school ? 'School updated.' : `${saved.name} added.`, 'success');
          if (onSaved) await onSaved(saved);
          else window.navigate(`/schools/${saved.id}`);
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('School name *', input('name', { value: school?.name, required: true, placeholder: 'Green Valley Public School' }), { span: true }),
      field('School code', input('code', { value: school?.code, placeholder: 'GVPS-01' })),
      field('City', input('city', { value: school?.city })),
      field('State', input('state', { value: school?.state })),
      field('Address', textarea('address', { value: school?.address }), { span: true }),
      field('Contact person', input('contact_name', { value: school?.contact_name })),
      field('Contact email', input('contact_email', { value: school?.contact_email, type: 'email' })),
      field('Contact phone', input('contact_phone', { value: school?.contact_phone })),
      field('Logo', h('input', { type: 'file', name: 'logo', accept: 'image/*' }), {
        hint: school?.logo_path ? 'Choose a file to replace the current logo.' : 'PNG or JPG, up to 5 MB.',
      }),
      field('Notes', textarea('notes', { value: school?.notes }), { span: true })
    ),
    school?.logo_path
      ? h(
          'label',
          { class: 'hint', style: 'display:flex;gap:7px;align-items:center;margin-top:12px' },
          h('input', { type: 'checkbox', name: 'remove_logo', value: 'true' }),
          'Remove the current logo'
        )
      : null,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, school ? 'Save changes' : 'Add school'),
      school ? h('button', { class: 'btn', type: 'button', onclick: () => window.navigate(`/schools/${school.id}`) }, 'Cancel') : null
    )
  );

  return h('div', { class: 'card' }, h('h2', {}, school ? 'Edit school' : 'Add a school'), h('p', { class: 'hint' }, school ? '' : 'Only the name is required — the rest can come later.'), form);
}

/* -------------------------------------------------------------- school detail */

export async function renderSchoolDetail(root, schoolId) {
  const [school, teachers] = await Promise.all([
    schoolsApi.get(schoolId),
    teachersApi.list({ school_id: schoolId }),
  ]);

  const state = { teachers, editing: false, importResult: null };

  const container = h('div', {});
  const refresh = async () => {
    state.teachers = await teachersApi.list({ school_id: schoolId });
    draw();
  };

  function draw() {
    mount(container, 
      h('div', { class: 'breadcrumb' }, h('a', { href: '#/schools' }, '← All schools')),
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          { class: 'detail-head' },
          logoFor(school, true),
          h(
            'div',
            {},
            h('h1', {}, school.name),
            h('p', {}, [school.code, school.city, school.state].filter(Boolean).join(' · ') || 'No details set yet')
          )
        ),
        h(
          'div',
          { class: 'page-actions' },
          h('a', { class: 'btn', href: `#/assessments?school=${school.id}` }, 'Assessments'),
          h('button', { class: 'btn', onclick: () => { state.editing = !state.editing; draw(); } }, state.editing ? 'Close editor' : 'Edit school'),
          h(
            'button',
            {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!confirmAction(`Delete ${school.name}, its teachers and all of its assessments? This cannot be undone.`)) return;
                await schoolsApi.remove(school.id);
                toast('School deleted.', 'success');
                window.navigate('/schools');
              },
            },
            'Delete'
          )
        )
      ),
      state.editing ? schoolFormCard(school, () => renderSchoolDetail(root, schoolId)) : null,
      contactCard(school),
      teacherImportCard(school, state, refresh),
      teacherListCard(school, state.teachers, refresh)
    );
  }

  draw();
  mount(root, container);
}

function contactCard(school) {
  const rows = [
    ['Address', school.address],
    ['Contact', [school.contact_name, school.contact_email, school.contact_phone].filter(Boolean).join(' · ')],
    ['Notes', school.notes],
  ].filter(([, value]) => value);

  if (!rows.length) return null;

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'School details'),
    h(
      'div',
      { class: 'table-wrap' },
      h('table', {}, h('tbody', {}, rows.map(([label, value]) => h('tr', {}, h('th', { style: 'width:150px' }, label), h('td', {}, value)))))
    )
  );
}

/* ------------------------------------------------------------- teacher import */

function teacherImportCard(school, state, refresh) {
  const result = state.importResult;
  const report = h(
    'div',
    { class: 'import-report' },
    result
      ? [
          h(
            'strong',
            {},
            `Imported ${result.imported} teacher${result.imported === 1 ? '' : 's'}.` +
              (result.skipped ? ` ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped.` : '')
          ),
          result.messages.length ? h('ul', {}, result.messages.map((message) => h('li', {}, message))) : null,
        ]
      : null
  );

  const fileInput = h('input', { type: 'file', name: 'file', accept: '.xlsx,.xlsm' });

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (!fileInput.files.length) {
          toast('Choose the filled-in template first.', 'error');
          return;
        }
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const data = new FormData();
          data.set('school_id', school.id);
          data.set('file', fileInput.files[0]);
          const imported = await teachersApi.import(data);
          state.importResult = imported;
          toast(`Imported ${imported.imported} teacher${imported.imported === 1 ? '' : 's'}.`, 'success');
          form.reset();
          await refresh(); // redraws this card, now showing the report from state
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('Filled-in template', fileInput, { hint: 'An .xlsx file with Teacher Name, Grade and Subjects.' })
    ),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Import teachers'))
  );

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Bulk import teachers'),
    h('p', { class: 'hint' }, 'Download the Excel template, fill in one teacher per row, then upload it back here.'),
    h('p', {}, h('a', { class: 'btn', href: teachersApi.templateUrl(school.id) }, '⤓ Download Excel template')),
    form,
    report
  );
}

/* --------------------------------------------------------------- teacher list */

function teacherListCard(school, teachers, refresh) {
  const addForm = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(addForm));
        try {
          await teachersApi.create({ ...data, school_id: school.id });
          addForm.reset();
          toast('Teacher added.', 'success');
          await refresh();
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('Teacher name *', input('name', { required: true, placeholder: 'Asha Menon' })),
      field('Grade', input('grade', { placeholder: 'Grade 5' })),
      field('Subjects', input('subjects', { placeholder: 'Mathematics, Science' }))
    ),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, 'Add teacher'))
  );

  const rows = teachers.map((teacher) => {
    const row = h(
      'tr',
      {},
      h('td', {}, teacher.name),
      h('td', {}, teacher.grade || '—'),
      h('td', {}, teacher.subjects || '—'),
      h('td', {}, String(teacher.assessment_count)),
      h(
        'td',
        { class: 'right' },
        h('button', { class: 'btn btn-sm', onclick: () => startEdit(row, teacher, refresh) }, 'Edit'),
        ' ',
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              if (!confirmAction(`Remove ${teacher.name}${teacher.assessment_count ? ' and their assessments' : ''}?`)) return;
              await teachersApi.remove(teacher.id);
              toast('Teacher removed.', 'success');
              await refresh();
            },
          },
          'Remove'
        )
      )
    );
    return row;
  });

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, `Teachers (${teachers.length})`),
    h('p', { class: 'hint' }, 'Add one at a time here, or import a whole list above.'),
    teachers.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Grade'), h('th', {}, 'Subjects'), h('th', {}, 'Assessments'), h('th', { class: 'right' }, ''))),
            h('tbody', {}, rows)
          )
        )
      : emptyState('No teachers on this school yet.'),
    h('div', { style: 'height:18px' }),
    addForm
  );
}

function startEdit(row, teacher, refresh) {
  const nameInput = input('name', { value: teacher.name });
  const gradeInput = input('grade', { value: teacher.grade });
  const subjectsInput = input('subjects', { value: teacher.subjects });

  const save = async () => {
    try {
      await teachersApi.update(teacher.id, {
        name: nameInput.value,
        grade: gradeInput.value,
        subjects: subjectsInput.value,
        email: teacher.email,
        phone: teacher.phone,
      });
      toast('Teacher updated.', 'success');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  mount(row, 
    h('td', {}, nameInput),
    h('td', {}, gradeInput),
    h('td', {}, subjectsInput),
    h('td', {}, String(teacher.assessment_count)),
    h(
      'td',
      { class: 'right' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: save }, 'Save'),
      ' ',
      h('button', { class: 'btn btn-sm', onclick: () => refresh() }, 'Cancel')
    )
  );
  nameInput.focus();
}
