import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-bulk-finalization-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_BASE_URL = 'https://synthetic.invalid/v1';
process.env.GEMINI_API_KEY = '';
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const bulk = await import('../server/bulk.js');
const { outcomeHtml, outcomeFilename } = await import('../server/outcome-artifacts.js');
await new Promise((resolve) => setImmediate(resolve));
after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const school = { id: 1, name: 'Synthetic <School>' };
const teachers = [
  { id: 1, school_id: 1, name: 'Anita Rao', grade: 'Class 4', subjects: 'Mathematics' },
  { id: 2, school_id: 1, name: 'Beena Shah', grade: 'Class 4', subjects: 'Mathematics' },
];
db.prepare('INSERT INTO schools (id, name) VALUES (?, ?)').run(school.id, school.name);
db.prepare('INSERT INTO tests (id, school_id, name) VALUES (1, 1, ?)').run('Synthetic Test');
for (const t of teachers) db.prepare('INSERT INTO teachers (id, school_id, name, grade, subjects) VALUES (@id, @school_id, @name, @grade, @subjects)').run(t);
for (let id = 1; id <= 7; id++) {
  const file = `paper-${id}.pdf`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), `%PDF synthetic master ${id}`);
  db.prepare("INSERT INTO papers (id, title, sections, levels, subject, language, priority, stored_name, original_name) VALUES (?, ?, 'B', 'primary', 'Mathematics', 'English', ?, ?, ?)")
    .run(id, `Primary Mathematics Master ${id}`, 10 - id, file, file);
}
let serial = 0;
function fixture(count = 2, name = 'Anonymous scans.pdf') {
  serial += 1;
  const files = Array.from({ length: count }, (_, i) => {
    const file = `fixture-${serial}-${i}.png`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), `synthetic page ${serial}:${i}`);
    return { filename: file, mimetype: 'image/png', size: 10 };
  });
  const id = bulk.addItem(school, { id: 1 }, name, files);
  return { id, pages: db.prepare('SELECT * FROM bulk_pages WHERE item_id = ? ORDER BY position').all(id) };
}
const lookPage = (page, t = teachers[0], extra = {}) => ({ page, name_written: t?.name ?? '', teacher_id: t?.id ?? 0, grade_written: t?.grade ?? '', subjects_written: t?.subjects ?? '', name_confidence: t ? 'certain' : 'none', paper_title_written: '', language: 'english', languages: ['English'], ...extra });
const look = (pages) => ({ name_written: '', teacher_id: 0, pages });
const sortPage = (page, paper_id = 1, extra = {}) => ({ page, section: 'B', paper_id, questions: ['5A'], has_answers: true, ...extra });
const summary = (paper_id = 1, extra = {}) => ({ section: 'B', paper_id, confidence: 'high', reason: 'The answer addresses the exact classroom problem in question 5A.', matched_question_labels: ['5A'], alternatives: [], ...extra });
const sorted = (pages, papers = [summary()]) => ({ pages, papers });
const unavailable = (id, reason) => {
  db.prepare("UPDATE assessments SET status = 'finalized', ai_status = 'done', score = NULL, max_score = NULL, ai_result = ? WHERE id = ?")
    .run(JSON.stringify({ outcome: 'no_assessment', completion: { state: 'no_assessment', reason_code: reason }, questions: [] }), id);
};
const options = (request) => ({ request, configured: () => true, evaluate: false, unavailable });
const filesFor = (id) => db.prepare('SELECT * FROM assessment_files WHERE assessment_id = ? ORDER BY position').all(id);

// Every provider response is injected. No real paper, key or provider call.
test('mixed definite identities split into safe fresh sittings; unassigned original pages remain stored', async () => {
  const f = fixture(3);
  const calls = [];
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    calls.push(req.name);
    return req.name === 'answer_sheets_first_look' ? look([lookPage(1), lookPage(2, teachers[1]), lookPage(3, null)]) : sorted([sortPage(1)]);
  }));
  assert.equal(outcome.filed.length, 2);
  assert.deepEqual(outcome.pages.map((p) => [p.teacher_id, p.state]), [[1, 'filed'], [2, 'filed'], [null, 'unassigned']]);
  assert.equal(calls.filter((name) => name === 'answer_sheets_first_look').length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bulk_pages WHERE item_id = ?').get(f.id).n, 3);
  for (const original of f.pages) assert.equal(fs.existsSync(path.join(UPLOADS_DIR, original.stored_name)), true);
  for (const row of outcome.filed) {
    const attachments = filesFor(row.assessment_id);
    assert.equal(attachments.length, 1);
    assert.notEqual(attachments[0].stored_name, f.pages[row.teacher.id - 1].stored_name);
    const source = JSON.parse(attachments[0].source_metadata);
    assert.equal(source.source_page, row.teacher.id);
    assert.equal(source.teacher_id, row.teacher.id);
  }
  const before = db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n;
  assert.deepEqual(await bulk.finalizeBulkItem(f.id, options(() => assert.fail('No retry after commit'))), outcome);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n, before);
  assert.match(bulk.removeItem(f.id), /retained/);
  assert.equal(bulk.presentItems(1, 1).some((i) => i.id === f.id), false);
});

test('all supplied compatible masters are in full-content comparison including below the legacy ranking cutoff', async () => {
  const f = fixture(1);
  let inputs;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') return look([lookPage(1)]);
    inputs = req.content.filter((c) => c.type === 'input_file');
    return sorted([sortPage(1, 7)], [summary(7)]);
  }));
  assert.equal(inputs.length, 7);
  assert.equal(inputs.every((p) => p.file_data.startsWith('data:application/pdf;base64,')), true);
  assert.equal(outcome.filed[0].paper_id, 7);
});

test('safe matched portions survive an unresolved group; known identity receives a null-score outcome', async () => {
  const f = fixture(2);
  let rematches = 0;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') return look([lookPage(1), lookPage(2)]);
    rematches += 1;
    return sorted([sortPage(1), sortPage(2, 0, { section: 'none', questions: [] })]);
  }));
  assert.equal(rematches, 2);
  assert.deepEqual(outcome.pages.map((p) => p.state), ['filed', 'no_assessment']);
  assert.equal(outcome.filed.length, 1);
  assert.equal(outcome.unavailable.length, 1);
  const row = db.prepare('SELECT * FROM assessments WHERE id = ?').get(outcome.unavailable[0].assessment_id);
  assert.deepEqual([row.score, row.max_score, row.status], [null, null, 'finalized']);
  assert.equal(JSON.parse(row.ai_result).questions.length, 0);
  assert.equal(filesFor(row.id).length, 1);
  const source = JSON.parse(filesFor(row.id)[0].source_metadata);
  assert.equal(source.administered_paper_id, null);
});

test('focused malformed retry cannot discard a safe first-pass paper match', async () => {
  const f = fixture(2);
  let pass = 0;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1), lookPage(2)])
    : ++pass === 1 ? sorted([sortPage(1), sortPage(2, 0, { section: 'none', questions: [] })]) : sorted([sortPage(1), sortPage(1)])));
  assert.deepEqual(outcome.pages.map((p) => p.state), ['filed', 'no_assessment']);
});

test('definite identity contradictions survive a reread and cannot be overridden by manual teacher selection', async () => {
  const f = fixture(2);
  db.prepare("UPDATE bulk_items SET teacher_id = 1, matched_by = 'you' WHERE id = ?").run(f.id);
  let pass = 0;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') return ++pass === 1
      ? look([lookPage(1), lookPage(2, null, { name_written: 'Unknown Name', name_confidence: 'uncertain' })])
      : look([lookPage(1, teachers[1]), lookPage(2)]);
    return sorted([sortPage(1)]);
  }));
  assert.equal(outcome.pages[0].teacher_id, null);
  assert.equal(outcome.pages[0].state, 'unassigned');
});

test('named administered master cannot be replaced by a high-confidence nearest alternative', async () => {
  const f = fixture(1);
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look'
    ? look([lookPage(1, teachers[0], { paper_title_written: 'Primary Mathematics Master 2' })]) : sorted([sortPage(1)])));
  assert.equal(outcome.filed.length, 0);
  assert.equal(outcome.unavailable.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessment_papers WHERE assessment_id = ?').get(outcome.unavailable[0].assessment_id).n, 0);
});

test('changed source bytes abort before filing and never certify a stale outcome', async () => {
  const f = fixture(1);
  const before = db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n;
  await assert.rejects(bulk.finalizeBulkItem(f.id, options(async () => {
    fs.appendFileSync(path.join(UPLOADS_DIR, f.pages[0].stored_name), 'changed');
    return look([lookPage(1)]);
  })), /sources changed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n, before);
  assert.equal(bulk.finalizationOutcome(f.id), null);
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, f.pages[0].stored_name)), true);
});

test('provider outage exhausts a bounded attempt budget and yields no fabricated teacher or grade', async () => {
  const f = fixture(1);
  let calls = 0;
  const before = db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async () => { calls += 1; throw new Error('synthetic unavailable'); }));
  assert.equal(calls, 2);
  assert.equal(outcome.pages[0].state, 'unassigned');
  assert.equal(outcome.filed.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n, before);
  assert.equal(bulk.finalizationState(1, 1).find((r) => r.item_id === f.id).state, 'finalized');
});

test('unconfigured service still produces a self-contained branded escaped no-score artifact', async () => {
  const f = fixture(1, '<script>alert(1)</script>.pdf');
  await bulk.finalizeBulkItem(f.id, { ...options(() => assert.fail('No service calls')), configured: () => false });
  const html = outcomeHtml(bulk.finalizationOutcome(f.id));
  assert.match(html, /Unassigned Submission/);
  assert.match(html, /Coverage/);
  assert.match(html, /Report Generated by UpSchool/);
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|pending review|OpenAI|Gemini|synthetic unavailable|0 \/ 0/i);
  assert.equal(outcomeFilename(f.id), `Submission-${f.id}-outcome.html`);
});

test('unavailable outcome failure rolls back every assessment and keeps original source ownership', async () => {
  const f = fixture(1);
  const before = db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n;
  await assert.rejects(bulk.finalizeBulkItem(f.id, { ...options(async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)])
    : sorted([sortPage(1, 0, { section: 'none', questions: [] })], [])), unavailable: () => { throw new Error('synthetic transaction fault'); } }), /transaction fault/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n, before);
  assert.equal(bulk.finalizationOutcome(f.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bulk_pages WHERE item_id = ?').get(f.id).n, 1);
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, f.pages[0].stored_name)), true);
});

test('reserved identity attempt resumes within the original two-call budget', async () => {
  const f = fixture(1);
  const file = path.join(UPLOADS_DIR, f.pages[0].stored_name), original = fs.readFileSync(file);
  let calls = 0;
  await assert.rejects(bulk.finalizeBulkItem(f.id, options(async () => {
    calls += 1; fs.appendFileSync(file, 'transient changed bytes'); return look([lookPage(1)]);
  })), /sources changed/);
  fs.writeFileSync(file, original);
  const result = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') { calls += 1; return look([lookPage(1)]); }
    return sorted([sortPage(1)]);
  }));
  assert.equal(calls, 2);
  assert.equal(result.filed.length, 1);
});

test('no-assessment finalized sittings are not offered as waiting for Evaluate', async () => {
  const f = fixture(1);
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)])
    : sorted([sortPage(1, 0, { section: 'none', questions: [] })], [])));
  const id = outcome.unavailable[0].assessment_id;
  assert.equal(bulk.unmarkedSittings(1, 1).waiting.some((row) => row.id === id), false);
});

test('real finalize/list/download routes reach an idempotent terminal outcome without a provider', async () => {
  const { default: express } = await import('express');
  const { default: router } = await import('../server/routes/bulk.js');
  const app = express(); app.use(express.json()); app.use('/api/bulk', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/bulk`;
    const f = fixture(1);
    const start = await fetch(`${base}/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ school_id: 1, test_id: 1, ids: [f.id] }) });
    assert.equal(start.status, 202);
    const accepted = await start.json(); assert.equal(accepted.started, 1);
    let state;
    for (let i = 0; i < 100; i++) {
      const listed = await (await fetch(`${base}?school_id=1&test_id=1`)).json();
      state = listed.finalizations.find((row) => row.item_id === f.id);
      if (state?.state === 'finalized') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(state.state, 'finalized');
    const download = await fetch(`http://127.0.0.1:${server.address().port}${state.download_url}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), new RegExp(`Submission-${f.id}-outcome.html`));
    assert.match(await download.text(), /Unassigned Submission/);
    const repeated = await (await fetch(`${base}/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ school_id: 1, test_id: 1, ids: [f.id] }) })).json();
    assert.equal(repeated.started, 0);
    assert.equal((await fetch(`${base}/${f.id}`, { method: 'DELETE' })).status, 409);
    assert.equal(fs.existsSync(path.join(UPLOADS_DIR, f.pages[0].stored_name)), true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('supplied blank answer sheet with an exact single-section master is filed for ordinary zero/full-max evaluation', async () => {
  const f = fixture(1);
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look'
    ? look([lookPage(1, teachers[0], { paper_title_written: 'Primary Mathematics Master 1' })])
    : sorted([sortPage(1, 1, { has_answers: false, questions: [] })], [summary(1, { matched_question_labels: [], reason: 'The supplied blank answer sheet explicitly names the unique Section B master.' })])));
  assert.equal(outcome.filed.length, 1);
  assert.equal(outcome.unavailable.length, 0);
  const metadata = JSON.parse(filesFor(outcome.filed[0].assessment_id)[0].source_metadata);
  assert.equal(metadata.original_match.supplied_blank, true);
  assert.equal(metadata.administered_paper_id, 1);
});

test('a loose blank page without an administered-master anchor is retained and never becomes a zero assessment', async () => {
  const f = fixture(1);
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look'
    ? look([lookPage(1)]) : sorted([sortPage(1, 0, { section: 'none', has_answers: false, questions: [] })], [])));
  assert.equal(outcome.filed.length, 0);
  assert.equal(outcome.pages[0].state, 'retained');
  assert.equal(outcome.unavailable.length, 0);
});

test('complete blank bulk submission reaches real evaluation with zero and the full printed denominator', async () => {
  const f = fixture(1);
  const masterPath = path.join(UPLOADS_DIR, 'paper-1.pdf'), oldMaster = fs.readFileSync(masterPath);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let pdf = '%PDF-1.4\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  fs.writeFileSync(masterPath, pdf);
  const oldFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'synthetic-only';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://synthetic.invalid/v1/responses');
    const name = JSON.parse(options.body).text.format.name;
    let raw;
    if (name === 'answer_language') raw = { language: 'english', languages: ['English'], pages_swapped: false };
    else if (name === 'grounded_question_ledger') raw = { issues: [], questions: [{ section: 'B', question: '5A', question_text: 'Describe a useful classroom practice.', max_marks: 5, source_id: 'library:1', source_page: 1, printed_marks: '[5]', expected_answer: 'Ask questions and check understanding.', criteria: [{ criterion: 'Supported relevant practice', max_marks: 5 }], assumptions: [], issues: [] }] };
    else if (name === 'grounded_response_extraction') raw = { paper_match: 'matched', match_reason: 'The exact named Section B master is supplied and all response spaces are blank.', page_identity: [{ page: 1, name: teachers[0].name, status: 'consistent' }], sections: [{ section: 'B', status: 'supplied_complete', source_pages: [1], reason: 'The full answer sheet with the printed question is supplied and blank.' }], answers: [{ row: 1, status: 'unanswered', teacher_answer: '', source_pages: [1], uncertainty: '' }] };
    else if (name === 'grounded_criterion_marks') raw = { questions: [{ row: 1, marks_awarded: 0, feedback: 'The answer was left blank.', credits: [{ criterion: 1, marks_awarded: 0, evidence_quote: '', reason: 'No answer was supplied for this question.' }] }], summary: 'The supplied section was left blank.', strengths: [], areas_to_improve: [] };
    else if (name === 'written_expression') raw = { sections: [{ section: 'Section B', judged: false, sentence_formation: 1, grammar: 1, spelling_punctuation: 1, vocabulary: 1, summary: '' }], errors: [] };
    else if (name === 'teacher_reports') raw = {};
    else assert.fail(`Unexpected synthetic request ${name}`);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const outcome = await bulk.finalizeBulkItem(f.id, { ...options(async (req) => req.name === 'answer_sheets_first_look'
      ? look([lookPage(1, teachers[0], { paper_title_written: 'Primary Mathematics Master 1' })])
      : sorted([sortPage(1, 1, { has_answers: false, questions: [] })], [summary(1, { matched_question_labels: [], reason: 'The supplied complete blank answer sheet names this Section B master.' })])), evaluate: true });
    let row;
    for (let i = 0; i < 300; i++) {
      row = db.prepare('SELECT * FROM assessments WHERE id = ?').get(outcome.filed[0].assessment_id);
      const report = db.prepare("SELECT status FROM reports WHERE teacher_id = 1 AND test_id = 1 AND kind = 'teacher'").get();
      if (row.ai_status === 'done' && !row.evaluation_queue && report && report.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(row.ai_status, 'done', row.ai_error);
    assert.deepEqual([row.score, row.max_score, row.status], [0, 5, 'evaluated']);
    const result = JSON.parse(row.ai_result);
    assert.equal(result.questions[0].response_status, 'unanswered');
    assert.equal(result.questions[0].marks_awarded, 0);
    assert.equal(result.questions[0].max_marks, 5);
  } finally {
    process.env.OPENAI_API_KEY = ''; globalThis.fetch = oldFetch; fs.writeFileSync(masterPath, oldMaster);
  }
});

test('missing source bytes yield a terminal no-score submission outcome without model calls', async () => {
  const f = fixture(1);
  fs.unlinkSync(path.join(UPLOADS_DIR, f.pages[0].stored_name));
  const outcome = await bulk.finalizeBulkItem(f.id, options(() => assert.fail('Cannot inspect absent source bytes')));
  assert.equal(outcome.pages[0].state, 'unassigned');
  assert.equal(outcome.pages[0].reason_code, 'source_unavailable');
  assert.equal(outcome.filed.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bulk_pages WHERE item_id = ?').get(f.id).n, 1);
});

test('one missing page does not discard intact independently identified matched pages', async () => {
  const f = fixture(2);
  fs.unlinkSync(path.join(UPLOADS_DIR, f.pages[0].stored_name));
  let reads = 0;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') { reads += 1; return look([lookPage(1)]); }
    return sorted([sortPage(1)]);
  }));
  assert.equal(reads, 1);
  assert.deepEqual(outcome.pages.map((p) => [p.source_page, p.state]), [[1, 'unassigned'], [2, 'filed']]);
  const metadata = JSON.parse(filesFor(outcome.filed[0].assessment_id)[0].source_metadata);
  assert.equal(metadata.source_page, 2);
  assert.deepEqual(metadata.unresolved_sibling_pages, [{ source_page: 1, reason_code: 'source_unavailable' }]);
});

test('malformed focused identity reread preserves independently valid first-pass page identities', async () => {
  const f = fixture(2);
  let pass = 0;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') return ++pass === 1 ? look([lookPage(1), lookPage(2, null)]) : look([lookPage(1), lookPage(1)]);
    return sorted([sortPage(1)]);
  }));
  assert.deepEqual(outcome.pages.map((p) => p.state), ['filed', 'unassigned']);
});

test('a definite conflicting identity in an incomplete reread is retained conservatively', async () => {
  const f = fixture(2);
  let pass = 0;
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => {
    if (req.name === 'answer_sheets_first_look') return ++pass === 1 ? look([lookPage(1), lookPage(2, null)]) : look([lookPage(1, teachers[1])]);
    assert.fail('Conflicting identity cannot be sent for paper matching');
  }));
  assert.equal(outcome.pages.every((p) => p.state === 'unassigned'), true);
});

test('same explicit batch aggregates split PDFs for one teacher/master before marking; separate batches do not', async () => {
  const first = fixture(1, 'Answer part one.pdf'), second = fixture(1, 'Answer part two.pdf');
  const batch = `test-batch-${first.id}`;
  for (const f of [first, second]) db.prepare("UPDATE bulk_items SET sort_status = 'finalization_waiting', result = ? WHERE id = ?").run(JSON.stringify({ finalization: { batch_id: batch, state: 'queued' } }), f.id);
  const request = async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)]) : sorted([sortPage(1)]);
  const a = await bulk.finalizeBulkItem(first.id, options(request));
  assert.equal(bulk.flushFinalizationBatch(batch), false);
  assert.equal(db.prepare('SELECT ai_status, evaluation_queue FROM assessments WHERE id = ?').get(a.filed[0].assessment_id).evaluation_queue, null);
  assert.equal(bulk.finalizationState(1, 1).find((row) => row.item_id === first.id).state, 'running');
  const b = await bulk.finalizeBulkItem(second.id, options(request));
  assert.equal(a.filed[0].assessment_id, b.filed[0].assessment_id);
  const attachments = filesFor(a.filed[0].assessment_id);
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments.map((file) => JSON.parse(file.source_metadata).source_file), ['Answer part one.pdf', 'Answer part two.pdf']);
  assert.deepEqual(attachments.map((file) => file.position), [1, 2]);
  const third = fixture(1, 'A distinct attempt.pdf');
  const c = await bulk.finalizeBulkItem(third.id, options(request));
  assert.notEqual(c.filed[0].assessment_id, a.filed[0].assessment_id);
  const before = attachments.length;
  await bulk.finalizeBulkItem(second.id, options(() => assert.fail('Committed page must not be duplicated')));
  assert.equal(filesFor(a.filed[0].assessment_id).length, before);
});

test('persisted finalization batch resumes after process restart and does not duplicate terminal work', async () => {
  const { spawnSync } = await import('node:child_process');
  const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-finalization-restart-'));
  const env = { ...process.env, DATA_DIR: restartDir, OPENAI_API_KEY: '', GEMINI_API_KEY: '' };
  const run = (source) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  try {
    run(`import fs from 'node:fs'; import path from 'node:path'; import db,{UPLOADS_DIR} from './server/db.js';
      db.prepare("INSERT INTO schools(id,name) VALUES(1,'Restart school')").run();
      db.prepare("INSERT INTO tests(id,school_id,name) VALUES(1,1,'Restart test')").run();
      db.prepare("INSERT INTO bulk_items(id,school_id,test_id,file_name,sort_status,result) VALUES(1,1,1,'Retained.pdf','finalization_waiting',?)").run(JSON.stringify({finalization:{batch_id:'restart-batch',state:'queued'}}));
      fs.writeFileSync(path.join(UPLOADS_DIR,'restart.png'),'synthetic source');
      db.prepare("INSERT INTO bulk_pages(item_id,stored_name,mime_type,position) VALUES(1,'restart.png','image/png',1)").run();
      db.close(); console.log(JSON.stringify({seeded:true}));`);
    const probe = `import db from './server/db.js'; await import('./server/bulk.js');
      await new Promise(resolve=>setTimeout(resolve,100));
      const row=db.prepare('SELECT sort_status,result FROM bulk_items WHERE id=1').get();
      const pages=db.prepare('SELECT COUNT(*) AS n FROM bulk_pages').get().n;
      const assessments=db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n;
      console.log(JSON.stringify({state:row.sort_status,batch:JSON.parse(row.result).finalization.batch_id,pages,assessments})); db.close();`;
    const first = run(probe), second = run(probe);
    assert.deepEqual(first, { state: 'finalized', batch: 'restart-batch', pages: 1, assessments: 0 });
    assert.deepEqual(second, first);
  } finally { fs.rmSync(restartDir, { recursive: true, force: true }); }
});

test('unrelated unknown PDFs do not contaminate another teacher\'s complete batch coverage', async () => {
  const known = fixture(1, 'Known.pdf'), unknown = fixture(1, 'Unassigned.pdf');
  const batch = `isolated-batch-${known.id}`;
  for (const f of [known, unknown]) db.prepare("UPDATE bulk_items SET sort_status = 'finalization_waiting', result = ? WHERE id = ?").run(JSON.stringify({ finalization: { batch_id: batch } }), f.id);
  const a = await bulk.finalizeBulkItem(known.id, options(async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)]) : sorted([sortPage(1)])));
  await bulk.finalizeBulkItem(unknown.id, options(async () => look([lookPage(1, null)])));
  assert.equal(bulk.flushFinalizationBatch(batch), true);
  const source = JSON.parse(filesFor(a.filed[0].assessment_id)[0].source_metadata);
  assert.deepEqual(source.unresolved_sibling_pages, []);
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('changed master while a batch assembles blocks dispatch and rematches retained originals on explicit retry', async () => {
  const first = fixture(1), second = fixture(1), batch = `changed-batch-${first.id}`;
  for (const f of [first, second]) db.prepare("UPDATE bulk_items SET sort_status = 'finalization_waiting', result = ? WHERE id = ?").run(JSON.stringify({ finalization: { batch_id: batch } }), f.id);
  const request = async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)]) : sorted([sortPage(1)]);
  const a = await bulk.finalizeBulkItem(first.id, options(request));
  const file = path.join(UPLOADS_DIR, 'paper-1.pdf'), original = fs.readFileSync(file);
  try {
    fs.appendFileSync(file, 'changed during batch assembly');
    await bulk.finalizeBulkItem(second.id, options(request));
    assert.equal(bulk.flushFinalizationBatch(batch), false);
    const retired = db.prepare('SELECT * FROM assessments WHERE id = ?').get(a.filed[0].assessment_id);
    assert.deepEqual([retired.status, retired.ai_status, retired.ai_result, retired.score, retired.max_score], ['finalized', 'done', null, null, null]);
    assert.equal(JSON.parse(retired.evaluation_progress).stage, 'superseded');
    assert.equal(bulk.unmarkedSittings(1, 1).waiting.some((row) => row.id === retired.id), false);
    assert.equal(bulk.unmarkedSittings(1, 1).failed.some((row) => row.id === retired.id), false);
    assert.equal(bulk.itemFor(first.id).sort_status, 'finalization_failed');
    assert.equal(bulk.itemFor(second.id).sort_status, 'finalization_failed');
    assert.deepEqual(bulk.finalizationState(1, 1).find((row) => row.item_id === first.id).retry_ids, [first.id, second.id]);
    const resumed = await bulk.finalizeBulkItem(first.id, options(request));
    const resumedSecond = await bulk.finalizeBulkItem(second.id, options(request));
    assert.notEqual(resumed.filed[0].assessment_id, a.filed[0].assessment_id);
    assert.equal(resumed.filed[0].assessment_id, resumedSecond.filed[0].assessment_id);
    assert.equal(filesFor(resumed.filed[0].assessment_id).length, 2);
    assert.equal(fs.existsSync(path.join(UPLOADS_DIR, first.pages[0].stored_name)), true);
  } finally { fs.writeFileSync(file, original); }
});

test('staged bulk sittings cannot be separately queued or offered as waiting for Evaluate', async () => {
  const f = fixture(1);
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)]) : sorted([sortPage(1)])));
  const id = outcome.filed[0].assessment_id;
  assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(id).status, 'assembling');
  assert.match(bulk.evaluateSittings([id], 'standard'), /still being assembled/);
  assert.equal(bulk.unmarkedSittings(1, 1).waiting.some((row) => row.id === id), false);
});

test('operationally failed finalization has a neutral downloadable status artifact without teacher attribution', () => {
  const f = fixture(1);
  db.prepare("UPDATE bulk_items SET sort_status = 'finalization_failed', result = ? WHERE id = ?").run(JSON.stringify({ finalization: { state: 'failed', error: 'Internal diagnostic must not render', batch_id: `failed-${f.id}` } }), f.id);
  const state = bulk.finalizationState(1, 1).find((row) => row.item_id === f.id);
  assert.equal(state.state, 'failed');
  assert.equal(state.download_url, `/api/bulk/${f.id}/outcome`);
  const outcome = bulk.finalizationOutcome(f.id), html = outcomeHtml(outcome);
  assert.deepEqual(outcome.teachers, []);
  assert.match(html, /Submission Status/);
  assert.match(html, /No assessment result is available/);
  assert.doesNotMatch(html, /Internal diagnostic|Anita Rao|0 \/ 0|pending review/);
});

test('an unexpected question-paper attachment cannot enter a staged bulk assessment at dispatch', async () => {
  const f = fixture(1);
  const outcome = await bulk.finalizeBulkItem(f.id, options(async (req) => req.name === 'answer_sheets_first_look' ? look([lookPage(1)]) : sorted([sortPage(1)])));
  const id = outcome.filed[0].assessment_id;
  const response = filesFor(id)[0];
  db.prepare("INSERT INTO assessment_files(assessment_id,kind,stored_name,original_name,mime_type,position) VALUES (?,'question_paper',?,?,?,1)")
    .run(id, response.stored_name, 'Unexpected paper.png', 'image/png');
  assert.equal(bulk.flushFinalizationBatch(outcome.batch_id), false);
  assert.equal(bulk.itemFor(f.id).sort_status, 'finalization_failed');
  assert.equal(db.prepare('SELECT evaluation_queue FROM assessments WHERE id=?').get(id).evaluation_queue, null);
});
