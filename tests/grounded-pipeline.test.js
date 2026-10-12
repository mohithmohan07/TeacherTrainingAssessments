import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePaper, validateResponse, validateMarks, printedMaximum } from '../server/grounding.js';

// Synthetic model messages, generated scan bytes, and a disposable database.
// fetch is intercepted for every pipeline test; no live provider is contacted.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grounded-pipeline-'));
process.env.DATA_DIR = temp;
process.env.OPENAI_API_KEY = 'synthetic-only';
process.env.SECOND_TRY_AFTER_MS = '5';
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const { startEvaluation, normalise, evaluationConfig } = await import('../server/evaluate.js');
const { digest, currentSourceBasis } = await import('../server/provenance.js');
const { sittingSections } = await import('../server/results.js');
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const sources = [{ source_id: 'scan:10', kind: 'image', pages: 1, sections: 'A' }];
const question = (overrides = {}) => ({
  section: 'A', question: '1A', question_text: 'Describe a useful teaching practice.', max_marks: 2,
  source_id: 'scan:10', source_page: 1, printed_marks: '[2]', expected_answer: 'Ask questions and check understanding.',
  criteria: [{ criterion: 'Ask questions and check understanding.', max_marks: 2 }], assumptions: [], ...overrides,
});
const paper = (overrides = {}) => ({ issues: [], questions: [question()], ...overrides });
const ledger = () => validatePaper(paper(), sources);
const response = (overrides = {}) => ({
  paper_match: 'matched', match_reason: 'Exact question number and content correspond.',
  page_identity: [{ page: 1, name: 'Example Teacher', status: 'consistent' }],
  sections: [{ section: 'A', status: 'supplied_complete', source_pages: [1], reason: 'One complete supplied section.' }],
  answers: [{ row: 1, status: 'answered', teacher_answer: 'बच्चों से प्रश्न पूछें।', source_pages: [1], uncertainty: '' }],
  ...overrides,
});
const marks = (overrides = {}) => ({
  questions: [{ row: 1, marks_awarded: 2, feedback: 'A useful practice.', credits: [{ criterion: 1, marks_awarded: 2, evidence_quote: 'बच्चों से प्रश्न पूछें।', reason: 'The response describes questioning.' }] }],
  summary: 'A useful teaching example.', strengths: ['Asking questions'], areas_to_improve: [], ...overrides,
});

test('a valid multilingual evidence chain preserves identity, printed maxima and source pages', () => {
  const q = ledger();
  const r = validateResponse(response(), q, 1, 'A');
  const result = validateMarks(marks(), q, r);
  assert.equal(result.questions[0].teacher_answer, 'बच्चों से प्रश्न पूछें।');
  assert.equal(result.questions[0].max_marks, 2);
  assert.deepEqual(result.questions[0].source_pages, [1]);
  assert.equal(result.questions[0].question_source.source_id, 'scan:10');
});

test('printed marks support Indian and RTL digits without guessed maxima', () => {
  for (const label of ['[२]', '(೨)', '[২]', '[۲]', '[٢]', '[௨]', '[౨]', '[૨]', '[੨]', '[୨]', '[൨]']) {
    assert.equal(printedMaximum(label), 2, label);
    assert.equal(validatePaper(paper({ questions: [question({ printed_marks: label })] }), sources)[0].max_marks, 2);
  }
  assert.equal(printedMaximum('2 × 3'), 6);
  assert.equal(printedMaximum('2 × 3 = 6'), 6);
  assert.equal(printedMaximum('Question 3 [2 marks]'), null);
  assert.throws(() => validatePaper(paper({ questions: [question({ printed_marks: 'Question 3 [2 marks]', max_marks: 3, criteria: [{ criterion: 'Example', max_marks: 3 }] })] }), sources), /printed marks/);
});

test('paper extraction rejects absent, duplicate, relabelled and out-of-bounds sources', () => {
  for (const raw of [paper({ questions: [] }), paper({ issues: ['Unreadable marks'] }), paper({ questions: [question(), question()] }), paper({ questions: [question({ source_page: 2 })] }), paper({ questions: [question({ source_id: 'scan:missing' })] })]) {
    assert.throws(() => validatePaper(raw, sources));
  }
  assert.throws(() => validatePaper(paper({ questions: [question({ section: 'B' })] }), sources, 'A'));
  assert.throws(() => validatePaper(paper({ questions: [question(), question({ question: '1(a)' })] }), sources), /Duplicate/);
});

test('catalogued paper sections cannot be reassigned by the model', () => {
  assert.throws(() => validatePaper(paper({ questions: [question({ section: 'B' })] }), sources), /section/i);
});

test('provisional criteria must be compatible with half-mark scoring and the row maximum', () => {
  assert.throws(() => validatePaper(paper({ questions: [question({ criteria: [{ criterion: 'One', max_marks: 1 }] })] }), sources), /rubric/);
  assert.throws(() => validatePaper(paper({ questions: [question({ criteria: [{ criterion: 'One', max_marks: 0.25 }, { criterion: 'Two', max_marks: 1.75 }] })] }), sources), /rubric|half/i);
});

test('teacher identity must have a permitted status on every page', () => {
  for (const identity of [[], [{ page: 1, name: '', status: 'unchecked' }], [{ page: 1, name: 'Other Teacher', status: 'conflict' }], [{ page: 1, name: '', status: 'uncertain' }]]) {
    assert.throws(() => validateResponse(response({ page_identity: identity }), ledger(), 1));
  }
  assert.doesNotThrow(() => validateResponse(response({ page_identity: [{ page: 1, name: '', status: 'not_visible' }] }), ledger(), 1));
});

test('uploaded pages cannot disappear into an entirely not-supplied result', () => {
  const absent = response({ sections: [{ section: 'A', status: 'not_supplied', source_pages: [], reason: '' }], answers: [{ row: 1, status: 'section_not_supplied', teacher_answer: '', source_pages: [], uncertainty: '' }] });
  assert.throws(() => validateResponse(absent, ledger(), 1), /accounted|supplied/);
  const extraPage = response({ page_identity: [{ page: 1, name: '', status: 'not_visible' }, { page: 2, name: '', status: 'not_visible' }] });
  assert.throws(() => validateResponse(extraPage, ledger(), 2), /accounted|page/i);
});

test('missing pages, extraction failure and incomplete section coverage stop marking', () => {
  for (const status of ['missing_page', 'extraction_failure']) {
    assert.throws(() => validateResponse(response({ answers: [{ row: 1, status, teacher_answer: '', source_pages: [1], uncertainty: 'Source cannot be inspected.' }] }), ledger(), 1), /Question/);
  }
  assert.throws(() => validateResponse(response({ sections: [{ section: 'A', status: 'incomplete', source_pages: [1], reason: 'Second sheet missing.' }] }), ledger(), 1), /missing pages/);
});

test('a supplied all-blank section remains a zero, while an absent section is excluded', () => {
  const q = validatePaper(paper({ questions: [question(), question({ section: 'B', question: '1B' })] }), [{ ...sources[0], sections: 'A,B' }]);
  const r = validateResponse(response({
    sections: [{ section: 'A', status: 'supplied_complete', source_pages: [1], reason: 'Blank supplied sheet.' }, { section: 'B', status: 'not_supplied', source_pages: [], reason: 'Not submitted.' }],
    answers: [{ row: 1, status: 'unanswered', teacher_answer: '', source_pages: [1], uncertainty: '' }, { row: 2, status: 'section_not_supplied', teacher_answer: '', source_pages: [], uncertainty: '' }],
  }), q, 1);
  const result = normalise(validateMarks(marks({ questions: [1, 2].map((row) => ({ row, marks_awarded: 0, feedback: 'No answer.', credits: [{ criterion: 1, marks_awarded: 0, evidence_quote: '', reason: '' }] })) }), q, r));
  assert.equal(result.total_score, 0);
  assert.equal(result.max_score, 2);
  const sections = sittingSections(result);
  assert.deepEqual(sections.map((s) => [s.key, s.awarded, s.max, s.percent]), [['A', 0, 2, 0]]);
});

test('a positive credit needs a real readable substring, never a transcription placeholder', () => {
  for (const quote of ['invented evidence', '[illegible]', '[ unreadable ]', '…']) {
    const text = quote === 'invented evidence' ? 'Actual answer.' : quote;
    const r = validateResponse(response({ answers: [{ row: 1, status: 'partial', teacher_answer: text, source_pages: [1], uncertainty: 'Difficult handwriting.' }] }), ledger(), 1);
    const raw = marks(); raw.questions[0].credits[0].evidence_quote = quote;
    assert.throws(() => validateMarks(raw, ledger(), r), /unsupported/);
  }
});

test('marks and criterion sums are bounded and cannot be silently clamped', () => {
  const r = validateResponse(response(), ledger(), 1);
  for (const total of [-1, 2.5, NaN, '2', 1]) {
    const raw = marks(); raw.questions[0].marks_awarded = total;
    assert.throws(() => validateMarks(raw, ledger(), r));
  }
  const fractional = marks(); fractional.questions[0].credits[0].marks_awarded = 1.25; fractional.questions[0].marks_awarded = 1.25;
  assert.throws(() => validateMarks(fractional, ledger(), r), /criterion/);
});

const schoolId = Number(db.prepare('INSERT INTO schools (name) VALUES (?)').run('Synthetic school').lastInsertRowid);
let fixtureNumber = 0;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA7sAAAAASUVORK5CYII=', 'base64');
function fixture() {
  const n = ++fixtureNumber;
  const teacherId = Number(db.prepare('INSERT INTO teachers (school_id, name, grade, subjects) VALUES (?, ?, ?, ?)').run(schoolId, `Example Teacher ${n}`, 'Grade 5', 'Science').lastInsertRowid);
  const id = Number(db.prepare('INSERT INTO assessments (school_id, teacher_id, title, section) VALUES (?, ?, ?, ?)').run(schoolId, teacherId, `Synthetic sitting ${n}`, 'A').lastInsertRowid);
  const add = (kind) => {
    const name = `fixture-${n}-${kind}.png`;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), png);
    const fileId = Number(db.prepare('INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, position) VALUES (?, ?, ?, ?, ?, 0)').run(id, kind, name, name, 'image/png').lastInsertRowid);
    return { id: fileId, stored_name: name };
  };
  return { id, teacherId, paper: add('question_paper'), response: add('response') };
}
function mockProvider(t, f, hooks = {}) {
  const names = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    const name = body.text?.format?.name;
    names.push(name);
    await hooks.before?.(name, body);
    let raw;
    if (name === 'answer_language') raw = { language: 'english', languages: ['English'], pages_swapped: hooks.swapped ?? false };
    else if (name === 'grounded_question_ledger') raw = paper({ questions: [question({ source_id: `scan:${hooks.swapped ? f.response.id : f.paper.id}` })] });
    else if (name === 'grounded_response_extraction') raw = response();
    else if (name === 'grounded_criterion_marks') raw = marks();
    else if (name === 'written_expression') raw = { sections: [{ section: 'Section A', judged: false, sentence_formation: 1, grammar: 1, spelling_punctuation: 1, vocabulary: 1, summary: '' }], errors: [] };
    else throw new Error(`Unexpected API task ${name}`);
    await hooks.after?.(name, body, raw);
    return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw) }] }] }) };
  });
  return names;
}
async function finished(id) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const row = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
    if (row.ai_status !== 'running') return row;
    await delay(2);
  }
  assert.fail('Synthetic evaluation did not finish.');
}

test('staged evaluation saves validated evidence and an explicit completed re-evaluation reads afresh', async (t) => {
  const f = fixture();
  const calls = mockProvider(t, f);
  assert.equal(startEvaluation(f.id), null);
  const first = await finished(f.id);
  assert.equal(first.ai_status, 'done', first.ai_error);
  const saved = JSON.parse(first.ai_result);
  assert.equal(saved.total_score, 2);
  assert.equal(saved.audit.source_digest, digest(currentSourceBasis(f.id)));
  assert.ok(saved.audit.config.reading_version && saved.audit.config.writing_version);
  assert.deepEqual(calls, ['answer_language', 'grounded_question_ledger', 'grounded_response_extraction', 'grounded_criterion_marks', 'written_expression']);
  assert.equal(startEvaluation(f.id), null);
  assert.equal((await finished(f.id)).ai_status, 'done');
  assert.equal(calls.length, 10);
});

test('source byte replacement invalidates checkpoints even with the same filename and ID', async (t) => {
  const f = fixture(); const calls = mockProvider(t, f);
  assert.equal(startEvaluation(f.id), null); assert.equal((await finished(f.id)).ai_status, 'done');
  fs.appendFileSync(path.join(UPLOADS_DIR, f.response.stored_name), 'synthetic changed bytes');
  assert.equal(startEvaluation(f.id), null); assert.equal((await finished(f.id)).ai_status, 'done');
  assert.equal(calls.filter((name) => name === 'answer_language').length, 2);
});

test('teacher name, grade and subjects participate in source identity fingerprints', () => {
  const f = fixture(); const original = digest(currentSourceBasis(f.id));
  for (const column of ['name', 'grade', 'subjects']) {
    const before = db.prepare(`SELECT ${column} AS value FROM teachers WHERE id = ?`).get(f.teacherId).value;
    db.prepare(`UPDATE teachers SET ${column} = ? WHERE id = ?`).run('Changed identity field', f.teacherId);
    assert.notEqual(digest(currentSourceBasis(f.id)), original, column);
    db.prepare(`UPDATE teachers SET ${column} = ? WHERE id = ?`).run(before, f.teacherId);
  }
});

test('source changes during an active stage stop evaluation before saving scores', async (t) => {
  const f = fixture(); mockProvider(t, f, { before(name) { if (name === 'grounded_response_extraction') fs.appendFileSync(path.join(UPLOADS_DIR, f.response.stored_name), 'changed during extraction'); } });
  assert.equal(startEvaluation(f.id), null);
  const row = await finished(f.id);
  assert.equal(row.ai_status, 'failed'); assert.match(row.ai_error, /changed during evaluation/);
  assert.equal(row.ai_result, null);
});

test('a change during automatic retry wait cannot certify stale captured inputs', async (t) => {
  const f = fixture(); let interrupted = false;
  const calls = mockProvider(t, f, { before(name) {
    if (!interrupted && name === 'grounded_response_extraction') {
      interrupted = true;
      setTimeout(() => db.prepare('UPDATE teachers SET name = ? WHERE id = ?').run('Changed during retry', f.teacherId), 0);
      const error = new Error('Synthetic timeout'); error.name = 'TimeoutError'; throw error;
    }
  } });
  assert.equal(startEvaluation(f.id), null);
  const row = await finished(f.id);
  assert.equal(row.ai_status, 'failed'); assert.match(row.ai_error, /changed/); assert.equal(row.ai_result, null);
  assert.equal(calls.filter((name) => name === 'grounded_response_extraction').length, 1);
});

test('confirmed swapped groups preserve physical file identity in persisted provenance', async (t) => {
  const f = fixture(); mockProvider(t, f, { swapped: true });
  assert.equal(startEvaluation(f.id), null); const row = await finished(f.id);
  assert.equal(row.ai_status, 'done', row.ai_error);
  const result = JSON.parse(row.ai_result);
  assert.equal(db.prepare('SELECT kind FROM assessment_files WHERE id = ?').get(f.paper.id).kind, 'response');
  assert.equal(db.prepare('SELECT kind FROM assessment_files WHERE id = ?').get(f.response.id).kind, 'question_paper');
  assert.equal(result.questions[0].question_source.source_id, `scan:${f.response.id}`);
  assert.equal(result.audit.source_digest, digest(currentSourceBasis(f.id)));
});
