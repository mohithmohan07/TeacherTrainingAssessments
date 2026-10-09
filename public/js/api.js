// Thin wrapper around fetch: JSON in, JSON out, errors as thrown Error objects.

async function handle(response) {
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  get: (url) => fetch(url).then(handle),

  postJson: (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(handle),

  putJson: (url, body) =>
    fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(handle),

  postForm: (url, formData) => fetch(url, { method: 'POST', body: formData }).then(handle),

  putForm: (url, formData) => fetch(url, { method: 'PUT', body: formData }).then(handle),

  del: (url) => fetch(url, { method: 'DELETE' }).then(handle),
};

export const schoolsApi = {
  list: () => api.get('/api/schools'),
  get: (id) => api.get(`/api/schools/${id}`),
  create: (formData) => api.postForm('/api/schools', formData),
  update: (id, formData) => api.putForm(`/api/schools/${id}`, formData),
  remove: (id) => api.del(`/api/schools/${id}`),
};

export const teachersApi = {
  list: (params = {}) => api.get(`/api/teachers?${new URLSearchParams(params)}`),
  create: (body) => api.postJson('/api/teachers', body),
  update: (id, body) => api.putJson(`/api/teachers/${id}`, body),
  remove: (id) => api.del(`/api/teachers/${id}`),
  templateUrl: (schoolId) => `/api/teachers/template?school_id=${schoolId}`,
  import: (formData) => api.postForm('/api/teachers/import', formData),

  // The assessments board: one row per teacher, with that teacher's current
  // sitting in the test (for the full paper, or one section) and their
  // results so far folded in.
  roster: (schoolId, testId, section) =>
    api.get(`/api/teachers/roster?${new URLSearchParams({ school_id: schoolId, ...(testId ? { test_id: testId } : {}), ...(section ? { section } : {}) })}`),
  uploadScans: (id, formData) => api.postForm(`/api/teachers/${id}/scans`, formData),
  currentAssessment: (id, testId, section) => api.postJson(`/api/teachers/${id}/assessment`, { test_id: testId, section: section || '' }),
  profile: (id) => api.get(`/api/teachers/${id}/profile`),
};

export const testsApi = {
  list: (schoolId) => api.get(`/api/tests?school_id=${schoolId}`),
  create: (body) => api.postJson('/api/tests', body),
  rename: (id, name) => api.putJson(`/api/tests/${id}`, { name }),
  remove: (id) => api.del(`/api/tests/${id}`),
};

export const reportsApi = {
  teacher: (teacherId, testId) => api.get(`/api/reports/teacher?teacher_id=${teacherId}&test_id=${testId}`),
  buildTeacher: (teacherId, testId) => api.postJson('/api/reports/teacher', { teacher_id: teacherId, test_id: testId }),
  school: (schoolId, testId) => api.get(`/api/reports/school?school_id=${schoolId}&test_id=${testId}`),
  buildSchool: (schoolId, testId) => api.postJson('/api/reports/school', { school_id: schoolId, test_id: testId }),
  buildAllTeachers: (schoolId, testId) => api.postJson('/api/reports/teachers', { school_id: schoolId, test_id: testId }),
  // Every report of the test in one zip, printed to PDF on the server.
  zip: (schoolId, testId) => api.get(`/api/reports/zip?school_id=${schoolId}&test_id=${testId}`),
  startZip: (schoolId, testId, viewer) => api.postJson('/api/reports/zip', { school_id: schoolId, test_id: testId, ...viewer }),
  zipFileUrl: (schoolId, testId) => `/api/reports/zip/file?school_id=${schoolId}&test_id=${testId}`,
};

export const assessmentsApi = {
  list: (params = {}) => api.get(`/api/assessments?${new URLSearchParams(params)}`),
  get: (id) => api.get(`/api/assessments/${id}`),
  create: (body) => api.postJson('/api/assessments', body),
  update: (id, body) => api.putJson(`/api/assessments/${id}`, body),
  evaluate: (id, marking = 'standard') => api.postJson(`/api/assessments/${id}/evaluate`, { marking }),
  saveMarks: (id, marks) => api.putJson(`/api/assessments/${id}/marks`, { marks }),
  // Checks the Written Expression of a sitting marked before Evaluate did.
  checkWriting: (id) => api.postJson(`/api/assessments/${id}/writing`, {}),
  swap: (id) => api.postJson(`/api/assessments/${id}/swap`, {}),
  // Moves pages filed under the wrong teacher to the right one.
  move: (id, teacherId, kinds) => api.postJson(`/api/assessments/${id}/move`, { teacher_id: teacherId, kinds }),
  setPapers: (id, paperIds) => api.putJson(`/api/assessments/${id}/papers`, { paper_ids: paperIds }),
  remove: (id) => api.del(`/api/assessments/${id}`),
  uploadFiles: (id, formData) => api.postForm(`/api/assessments/${id}/files`, formData),
  removeFile: (id, fileId) => api.del(`/api/assessments/${id}/files/${fileId}`),
};

// Every teacher's answer paper uploaded at once as PDFs, sorted, then filed.
export const bulkApi = {
  list: (schoolId, testId) => api.get(`/api/bulk?${new URLSearchParams({ school_id: schoolId, test_id: testId })}`),
  add: (formData) => api.postForm('/api/bulk', formData),
  update: (id, body) => api.putJson(`/api/bulk/${id}`, body),
  sort: (id) => api.postJson(`/api/bulk/${id}/sort`, {}),
  remove: (id) => api.del(`/api/bulk/${id}`),
  evaluate: (ids, marking) => api.postJson('/api/bulk/evaluate', { ids, marking }),
  marking: (ids) => api.get(`/api/bulk/marking?ids=${ids.join(',')}`),
  file: (schoolId, testId, ids) => api.postJson('/api/bulk/file', { school_id: schoolId, test_id: testId, ...(ids ? { ids } : {}) }),
};

// The question paper library.
export const papersApi = {
  list: () => api.get('/api/papers'),
  choices: (teacherId, section) => api.get(`/api/papers/choices?${new URLSearchParams({ teacher_id: teacherId, ...(section ? { section } : {}) })}`),
  add: (formData) => api.postForm('/api/papers', formData),
  update: (id, body) => api.putJson(`/api/papers/${id}`, body),
  remove: (id) => api.del(`/api/papers/${id}`),
  importPack: (formData) => api.postForm('/api/papers/import', formData),
};

// The growth paths the training plans in the management reports are drawn from.
export const trainingApi = {
  get: () => api.get('/api/training'),
  save: (body) => api.putJson('/api/training', body),
  clear: () => api.del('/api/training'),
  read: (formData) => api.postForm('/api/training/read', formData),
};

export const generatorApi = {
  config: () => api.get('/api/generator/config'),
  list: () => api.get('/api/generator'),
  get: (id) => api.get(`/api/generator/${id}`),
  generate: (body) => api.postJson('/api/generator', body),
  remove: (id) => api.del(`/api/generator/${id}`),
};

export const dashboardApi = {
  get: () => api.get('/api/dashboard'),
  school: (schoolId, testId) => api.get(`/api/dashboard/school?school_id=${schoolId}&test_id=${testId}`),
};
