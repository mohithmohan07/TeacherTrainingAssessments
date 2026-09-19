// Thin wrapper around fetch: JSON in, JSON out, errors as thrown Error objects.

async function handle(response) {
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json() : null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
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
};

export const assessmentsApi = {
  list: (params = {}) => api.get(`/api/assessments?${new URLSearchParams(params)}`),
  get: (id) => api.get(`/api/assessments/${id}`),
  create: (body) => api.postJson('/api/assessments', body),
  update: (id, body) => api.putJson(`/api/assessments/${id}`, body),
  remove: (id) => api.del(`/api/assessments/${id}`),
  uploadFiles: (id, formData) => api.postForm(`/api/assessments/${id}/files`, formData),
  removeFile: (id, fileId) => api.del(`/api/assessments/${id}/files/${fileId}`),
};

export const statsApi = {
  get: () => api.get('/api/stats'),
};
