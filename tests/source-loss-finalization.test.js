import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Synthetic bytes and mocked providers only: no real scans or credentials.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-source-loss-'));
process.env.DATA_DIR = dir;
process.env.OPENAI_API_KEY = 'synthetic-test-only';
process.env.OPENAI_BASE_URL = 'https://synthetic.invalid/v1';
process.env.SECOND_TRY_AFTER_MS = '1';
delete process.env.GEMINI_API_KEY;
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const { startEvaluation, finalizeUnavailable } = await import('../server/evaluate.js');
const { sittingSections, teacherResults, potentialFor, unansweredSections } = await import('../server/results.js');
const { currentSourceBasis, digest } = await import('../server/provenance.js');
const { evidenceFor, default: reportRoutes } = await import('../server/routes/reports.js');
const { findReport, isStale, queueTeacherReports } = await import('../server/reports.js');
const originalFetch = globalThis.fetch;
const schoolId = Number(db.prepare("INSERT INTO schools(name) VALUES ('Synthetic Source School')").run().lastInsertRowid);
const testId = Number(db.prepare("INSERT INTO tests(school_id,name) VALUES (?, 'Synthetic availability test')").run(schoolId).lastInsertRowid);
after(() => { globalThis.fetch = originalFetch; db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function addFile(f, kind, { missing = false, metadata = null } = {}) {
  const position = db.prepare('SELECT COUNT(*) AS n FROM assessment_files WHERE assessment_id=? AND kind=?').get(f.id, kind).n + 1;
  const name = `${f.id}-${kind}-${position}.png`;
  const id = Number(db.prepare('INSERT INTO assessment_files(assessment_id,kind,stored_name,original_name,mime_type,position,source_metadata) VALUES (?,?,?,?,?,?,?)').run(f.id, kind, name, name, 'image/png', position, metadata && JSON.stringify(metadata)).lastInsertRowid);
  const bytes = `synthetic ${name}`;
  if (!missing) fs.writeFileSync(path.join(UPLOADS_DIR, name), bytes);
  return { id, name, bytes, position };
}
function question(source, section = 'B', question = '1', max = 5) {
  return { section, question, question_text: 'Describe a practical learning activity.', max_marks: max, source_id: source, source_page: 1, printed_marks: `[${max}]`, expected_answer: 'Ask pupils to explain a practical example.', criteria: [{ criterion: 'Supported practical explanation', max_marks: max }], assumptions: ['Provisional source-based criterion.'] };
}
function fixture({ responses = 2, missing = [1], section = 'B' } = {}) {
  const teacherId = Number(db.prepare("INSERT INTO teachers(school_id,name,grade,subjects) VALUES (?, 'Synthetic Teacher', 'Grade 5', 'Science')").run(schoolId).lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO assessments(school_id,teacher_id,test_id,title,section) VALUES (?,?,?,'Synthetic source sitting',?)").run(schoolId, teacherId, testId, section || null).lastInsertRowid);
  const f = { id, teacherId, responseFiles: [] };
  f.paperFile = addFile(f, 'question_paper');
  for (let i = 1; i <= responses; i++) f.responseFiles.push(addFile(f, 'response', { missing: missing.includes(i), metadata: { teacher_id: teacherId, identity_confirmed: true, filed_section: 'B' } }));
  f.paper = { issues: [], questions: [question(`scan:${f.paperFile.id}`), question(`scan:${f.paperFile.id}`, 'B', '2', 3)] };
  const available = responses - missing.length;
  f.response = { paper_match: 'matched', match_reason: 'Printed question numbers and specific answers match the source.', page_identity: Array.from({ length: available }, (_, i) => ({ page: i + 1, name: 'Synthetic Teacher', status: 'consistent' })), sections: [{ section: 'B', status: 'supplied_complete', source_pages: Array.from({ length: available }, (_, i) => i + 1), reason: '' }], answers: [
    { row: 1, status: 'answered', teacher_answer: 'Ask pupils to explain a practical example.', source_pages: [1], uncertainty: '' },
    { row: 2, status: 'unanswered', teacher_answer: '', source_pages: [], uncertainty: '' },
  ] };
  return f;
}
function marks(f) {
  return { questions: f.paper.questions.map((q, i) => ({ row: i + 1, marks_awarded: i === 0 ? 3 : 0, feedback: 'A relevant practical example.', credits: [{ criterion: 1, marks_awarded: i === 0 ? 3 : 0, evidence_quote: i === 0 ? 'Ask pupils to explain a practical example.' : '', reason: '' }] })), summary: 'Use practical examples.', strengths: [], areas_to_improve: [] };
}
function mock(f, options = {}) {
  const calls = [];
  globalThis.fetch = async (url, req) => {
    assert.equal(String(url), 'https://synthetic.invalid/v1/responses');
    const body = JSON.parse(req.body), name = body.text.format.name;
    calls.push({ name, body });
    options.before?.(name, calls);
    let raw;
    if (name === 'answer_language') raw = options.language ?? { language: 'english', languages: ['English'], pages_swapped: false };
    else if (name === 'grounded_question_ledger') raw = f.paper;
    else if (name === 'grounded_response_extraction') raw = f.response;
    else if (name === 'grounded_criterion_marks') raw = marks(f);
    else if (name === 'written_expression') raw = { sections: [{ section: 'Section B', judged: false, sentence_formation: 1, grammar: 1, spelling_punctuation: 1, vocabulary: 1, summary: '' }], errors: [] };
    else if (name === 'teacher_reports') return new Response(JSON.stringify({ error: { message: 'Synthetic optional narrative unavailable' } }), { status: 401 });
    else assert.fail(`Unexpected model task ${name}`);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
async function finished(f) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT * FROM assessments WHERE id=?').get(f.id);
    const report = findReport('teacher', testId, f.teacherId);
    if (row.ai_status !== 'running' && report?.status !== 'running') return { row, result: row.ai_result && JSON.parse(row.ai_result), report };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic assessment did not finish.');
}
function availableEvidence(f) { return evidenceFor(f.teacherId, teacherResults(f.teacherId, testId))[0]; }
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let result = '%PDF-1.4\n', offsets = [];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  return result + `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
}
function addPaper(f, section, missing = false) {
  const name = `${f.id}-master-${section}.pdf`;
  const id = Number(db.prepare("INSERT INTO papers(title,sections,subject,levels,stored_name,original_name) VALUES (?,?, 'Science','primary',?,?)").run(`Synthetic ${section} master`, section, name, name).lastInsertRowid);
  db.prepare('INSERT INTO assessment_papers(assessment_id,paper_id,position) VALUES (?,?,?)').run(f.id, id, id);
  if (!missing) fs.writeFileSync(path.join(UPLOADS_DIR, name), pdf());
  return { id, name };
}

test('missing response pages retain readable credit and original evidence indexes without inferred blank zeros', async () => {
  const f = fixture(), calls = mock(f), source = currentSourceBasis(f.id);
  assert.equal(startEvaluation(f.id), null);
  const { row, result, report } = await finished(f);
  assert.equal(row.ai_status, 'done', row.ai_error);
  assert.deepEqual([row.score, row.max_score], [3, 5]);
  assert.deepEqual(result.questions.map((q) => q.marks_awarded), [3, null]);
  assert.equal(result.questions[1].response_status, 'missing_page');
  assert.equal(result.questions[1].assessment_state, 'unassessable');
  assert.deepEqual(result.questions[0].source_pages, [2]);
  assert.deepEqual(result.submission.sections[0].source_pages, [2]);
  assert.deepEqual(result.audit.page_identity.map((p) => p.page), [2]);
  assert.deepEqual(result.audit.availability.unavailable_file_ids, [f.responseFiles[0].id]);
  assert.deepEqual(result.audit.availability.response_page_map, [{ provider_page: 1, original_page: 2, file_id: f.responseFiles[1].id }]);
  assert.equal(result.audit.source_digest, digest(source));
  assert.equal(result.outcome, 'qualified');
  const sections = teacherResults(f.teacherId, testId);
  assert.equal(sections[0].coverage.state, 'partial'); assert.equal(sections[0].grade, null); assert.equal(potentialFor(sections), null);
  assert.equal(isStale(report, sections), false);
  const writing = calls.find((call) => call.name === 'written_expression').body.input[0].content;
  assert.deepEqual(writing.filter((c) => c.type === 'input_image').map((c) => c.image_url), [`data:image/png;base64,${Buffer.from(f.responseFiles[1].bytes).toString('base64')}`]);
  assert.deepEqual(availableEvidence(f).response.map((p) => p.url), [`/uploads/${f.responseFiles[1].name}`]);
});

test('filtered response conflicts exclude the original file and never enter writing or report evidence', async () => {
  const f = fixture({ responses: 3 });
  f.response.page_identity[1] = { page: 2, name: 'Different Teacher', status: 'conflict' };
  const calls = mock(f); startEvaluation(f.id);
  const { result } = await finished(f);
  assert.deepEqual(result.audit.excluded_response_pages, [3]);
  assert.deepEqual(result.questions[0].source_pages, [2]);
  assert.deepEqual(availableEvidence(f).response.map((p) => p.url), [`/uploads/${f.responseFiles[1].name}`]);
  const writing = calls.find((call) => call.name === 'written_expression').body.input[0].content.filter((c) => c.type === 'input_image');
  assert.equal(writing.length, 1);
  assert.equal(writing[0].image_url, `data:image/png;base64,${Buffer.from(f.responseFiles[1].bytes).toString('base64')}`);
});

test('a verified group swap preserves unavailable IDs and final original-response numbering', async () => {
  const f = fixture({ responses: 2, missing: [] });
  fs.rmSync(path.join(UPLOADS_DIR, f.paperFile.name));
  const safeResponse = addFile(f, 'question_paper');
  f.paper.questions.forEach((q) => { q.source_id = `scan:${f.responseFiles[0].id}`; });
  f.response.page_identity = [{ page: 1, name: 'Synthetic Teacher', status: 'consistent' }];
  f.response.sections[0].source_pages = [1];
  mock(f, { language: { language: 'english', languages: ['English'], pages_swapped: true } });
  startEvaluation(f.id); const { row, result } = await finished(f);
  assert.equal(row.ai_status, 'done', row.ai_error); assert.equal(result.pages_swapped, true);
  assert.deepEqual(result.questions[0].source_pages, [2]); assert.deepEqual(result.questions.map((q) => q.marks_awarded), [3, null]);
  assert.equal(result.audit.source_digest, digest(currentSourceBasis(f.id))); assert.ok(result.audit.initial_basis);
  assert.deepEqual(result.audit.availability.unavailable_file_ids, [f.paperFile.id]);
  assert.deepEqual(availableEvidence(f).response.map((p) => p.url), [`/uploads/${safeResponse.name}`]);
  assert.deepEqual(availableEvidence(f).question_paper.map((p) => p.url), f.responseFiles.map((file) => `/uploads/${file.name}`));
});

test('partial master loss adds neutral coverage without inventing missing questions or maxima', async () => {
  const f = fixture({ responses: 1, missing: [], section: '' });
  const good = addPaper(f, 'B'), missing = addPaper(f, 'C', true);
  f.paper.questions[0].source_id = f.paper.questions[1].source_id = `library:${good.id}`;
  mock(f); startEvaluation(f.id);
  const { result } = await finished(f), sections = sittingSections(result);
  assert.deepEqual(result.questions.map((q) => q.max_marks), [5, 3]);
  assert.deepEqual(result.questions.map((q) => q.marks_awarded), [3, 0]);
  const absentMaster = sections.find((section) => section.key === 'C');
  assert.deepEqual(absentMaster.questions, []); assert.equal(absentMaster.max, null); assert.equal(absentMaster.awarded, null); assert.equal(absentMaster.coverage.state, 'unassessable');
  assert.equal(result.outcome, 'qualified'); assert.equal(potentialFor(sections), null);
  assert.deepEqual(result.audit.availability.unavailable_paper_ids, [missing.id]);
  assert.deepEqual(availableEvidence(f).papers.map((p) => p.url), [`/uploads/${good.name}`]);
});

test('a missing unlabelled paper scan qualifies surviving rows without losing a verified blank', async () => {
  const f = fixture({ responses: 1, missing: [] });
  const missing = addFile(f, 'question_paper', { missing: true });
  mock(f); startEvaluation(f.id); const { result } = await finished(f);
  assert.deepEqual(result.questions.map((q) => q.marks_awarded), [3, 0]);
  assert.equal(result.questions[1].response_status, 'unanswered');
  assert.equal(result.submission.sections[0].status, 'incomplete'); assert.equal(sittingSections(result)[0].grade, null);
  assert.ok(result.audit.availability.unavailable_file_ids.includes(missing.id));
  assert.deepEqual(availableEvidence(f).question_paper.map((p) => p.url), [`/uploads/${f.paperFile.name}`]);
});

for (const missingSection of ['A', 'B']) test(`known missing Section ${missingSection} is distinguished from genuinely not supplied sections`, async () => {
  const f = fixture({ section: '' });
  db.prepare('UPDATE assessment_files SET source_metadata=? WHERE id=?').run(JSON.stringify({ filed_section: missingSection }), f.responseFiles[0].id);
  f.paper.questions.push(question(`scan:${f.paperFile.id}`, 'A', '1', 7));
  f.response.sections.push({ section: 'A', status: 'not_supplied', source_pages: [], reason: '' });
  f.response.answers.push({ row: 3, status: 'section_not_supplied', teacher_answer: '', source_pages: [], uncertainty: '' });
  mock(f); startEvaluation(f.id); const { result } = await finished(f);
  assert.equal(result.questions[2].assessment_state, missingSection === 'A' ? 'unassessable' : 'not_supplied');
  assert.equal(result.questions[2].response_status, missingSection === 'A' ? 'missing_page' : 'section_not_supplied');
  assert.equal(result.questions[2].marks_awarded, null);
  assert.deepEqual(unansweredSections(result), missingSection === 'A' ? [] : ['Section A']);
  assert.equal(sittingSections(result).some((section) => section.key === 'A'), missingSection === 'A');
});

test('a known missing response section outside the readable ledger remains visible without invented rows', async () => {
  const f = fixture({ section: '' });
  db.prepare('UPDATE assessment_files SET source_metadata=? WHERE id=?').run(JSON.stringify({ filed_section: 'A' }), f.responseFiles[0].id);
  mock(f); startEvaluation(f.id); const { result } = await finished(f);
  assert.deepEqual(result.questions.map((q) => q.section), ['Section B', 'Section B']);
  const lost = sittingSections(result).find((section) => section.key === 'A');
  assert.deepEqual(lost.questions, []); assert.equal(lost.awarded, null); assert.equal(lost.max, null);
  assert.equal(result.outcome, 'qualified'); assert.equal(potentialFor(sittingSections(result)), null);
});

test('same-source retry resumes cached usable stages while retaining missing-file provenance', async () => {
  const f = fixture(); let first = true;
  const calls = mock(f, { before: (name) => { if (name === 'grounded_question_ledger' && first) { first = false; const error = new Error('Synthetic timeout'); error.name = 'TimeoutError'; throw error; } } });
  startEvaluation(f.id); const { row, result } = await finished(f);
  assert.equal(row.ai_status, 'done', row.ai_error); assert.equal(row.score, 3);
  assert.equal(calls.filter((call) => call.name === 'answer_language').length, 1);
  assert.equal(calls.filter((call) => call.name === 'grounded_question_ledger').length, 2);
  assert.equal(result.audit.source_digest, digest(currentSourceBasis(f.id)));
  assert.equal(JSON.parse(row.evaluation_progress).attempt, 2);
});

for (const change of ['delete available', 'restore missing']) test(`${change} during a provider call cannot certify stale evidence`, async () => {
  const f = fixture();
  mock(f, { before: (name) => { if (name !== 'grounded_criterion_marks') return; const file = f.responseFiles[change === 'restore missing' ? 0 : 1]; if (change === 'restore missing') fs.writeFileSync(path.join(UPLOADS_DIR, file.name), file.bytes); else fs.rmSync(path.join(UPLOADS_DIR, file.name)); } });
  startEvaluation(f.id); const { row } = await finished(f);
  assert.equal(row.ai_status, 'failed'); assert.match(row.ai_error, /changed during evaluation/); assert.equal(row.ai_result, null);
});

test('actual report GET excludes audited loss but retains new losses for stale-source guards', async () => {
  const f = fixture(); mock(f); startEvaluation(f.id); await finished(f);
  const { default: express } = await import('express');
  const app = express(); app.use('/api/reports', reportRoutes);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/reports/teacher?teacher_id=${f.teacherId}&test_id=${testId}`;
    const before = await originalFetch(url).then((response) => response.json());
    assert.equal(before.report.stale, false); assert.deepEqual(before.evidence[0].response.map((p) => p.url), [`/uploads/${f.responseFiles[1].name}`]);
    fs.rmSync(path.join(UPLOADS_DIR, f.responseFiles[1].name));
    const after = await originalFetch(url).then((response) => response.json());
    assert.equal(after.sections[0].evaluation_stale, true); assert.equal(after.report.stale, true);
    assert.deepEqual(after.evidence[0].response.map((p) => p.url), [`/uploads/${f.responseFiles[1].name}`]);
    assert.match(queueTeacherReports(f.teacherId, testId), /source papers have changed/i);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('all missing sources produce a typed neutral artifact without provider calls', async () => {
  const f = fixture({ responses: 1, missing: [1] }); fs.rmSync(path.join(UPLOADS_DIR, f.paperFile.name));
  const calls = mock(f); assert.equal(startEvaluation(f.id), null); const { row, result } = await finished(f);
  assert.equal(calls.length, 0); assert.equal(row.ai_status, 'done'); assert.equal(row.status, 'finalized');
  assert.equal(result.outcome, 'no_assessment'); assert.deepEqual(result.questions, []); assert.equal(row.score, null); assert.equal(row.max_score, null);
  assert.equal(result.audit.availability.unavailable_file_ids.length, 2);
  assert.deepEqual(availableEvidence(f).response, []); assert.deepEqual(availableEvidence(f).question_paper, []);
});

test('terminal artifacts retain only available independently verified teacher scans', () => {
  const f = fixture({ responses: 0, missing: [] });
  const manual = addFile(f, 'response', { metadata: { teacher_id: f.teacherId, identity_confirmed: true } });
  const certain = addFile(f, 'response', { metadata: { teacher_id: f.teacherId, identity: { teacher_id: f.teacherId, name_confidence: 'certain', name_written: 'Synthetic Teacher' } } });
  addFile(f, 'response');
  addFile(f, 'response', { metadata: { teacher_id: f.teacherId, identity_confirmed: true, identity: { teacher_id: f.teacherId, name_confidence: 'certain', name_written: 'Someone Different' } } });
  addFile(f, 'response', { metadata: { teacher_id: f.teacherId, identity: { teacher_id: f.teacherId, name_confidence: 'uncertain', name_written: 'Synthetic Teacher' } } });
  addFile(f, 'response', { missing: true, metadata: { teacher_id: f.teacherId, identity_confirmed: true } });
  assert.equal(finalizeUnavailable(f.id, 'service_unavailable', 'Synthetic provider unavailable', { queueReports: false }), true);
  const result = JSON.parse(db.prepare('SELECT ai_result FROM assessments WHERE id=?').get(f.id).ai_result);
  assert.deepEqual(result.audit.excluded_response_pages, [3, 4, 5, 6]);
  assert.deepEqual(availableEvidence(f).response.map((p) => p.url), [`/uploads/${manual.name}`, `/uploads/${certain.name}`]);
  assert.equal(result.outcome, 'no_assessment'); assert.deepEqual(result.questions, []);
});

test('an assembling batch cannot evaluate or finalize even when the provider is unavailable', () => {
  const f = fixture(); db.prepare("UPDATE assessments SET status='assembling' WHERE id=?").run(f.id);
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(startEvaluation(f.id), 'This submission batch is still being assembled.');
    const row = db.prepare('SELECT ai_status,ai_result FROM assessments WHERE id=?').get(f.id);
    assert.equal(row.ai_result, null); assert.notEqual(row.ai_status, 'done');
  } finally { process.env.OPENAI_API_KEY = 'synthetic-test-only'; }
});
