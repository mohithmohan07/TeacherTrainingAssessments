import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ReportNode, installReportDom } from './report-dom-helper.js';

// Disposable, synthetic records only. API checks use a local Express server;
// no external service is called and no provider credentials are supplied.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-coverage-'));
process.env.DATA_DIR = dir;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const { default: db } = await import('../server/db.js');
const { coverageOf, counts, gradeEligible, sittingSections, unansweredSections, potentialFor, needOf, resultsBasis, fingerprint, teacherResults } = await import('../server/results.js');
const { trainingPlanFor } = await import('../server/training.js');
const { default: assessments } = await import('../server/routes/assessments.js');
const { default: teachers } = await import('../server/routes/teachers.js');
const { default: dashboard } = await import('../server/routes/dashboard.js');
const app = express();
app.use(express.json());
app.use('/api/assessments', assessments);
app.use('/api/teachers', teachers);
app.use('/api/dashboard', dashboard);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const nativeFetch = globalThis.fetch;
after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const q = (overrides = {}) => ({ section: 'Section A', question: '1', teacher_answer: 'A supported response.', marks_awarded: 4, max_marks: 5, assessment_state: 'assessed', response_status: 'answered', ...overrides });
const result = (questions, section = { section: 'A', status: 'supplied_complete', source_pages: [1] }) => ({ outcome: 'assessed', questions, summary: '', strengths: [], areas_to_improve: [], submission: { sections: [section] } });
const framework = { version: 'synthetic', paths: [{ name: 'Practice', min_days: 3, max_days: 10 }] };

async function request(url, body) {
  const response = await nativeFetch(`${base}${url}`, body ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: response.status, body: await response.json() };
}

test('mixed coverage keeps unassessable printed maxima outside assessed percentages', () => {
  const questions = [q({ max_marks: 10 }), q({ question: '2', max_marks: 7, marks_awarded: null, assessment_state: 'unassessable', response_status: 'unreadable' })];
  assert.deepEqual(coverageOf(questions), { state: 'partial', assessed_questions: 1, unassessable_questions: 1, not_supplied_questions: 0, assessed_max: 10, unassessable_max: 7, supplied_max: 17, total_max: 17 });
  const [section] = sittingSections(result(questions));
  assert.deepEqual([section.awarded, section.max, section.percent, section.grade, section.grade_label, section.grade_eligible], [4, 10, 40, null, null, false]);
  assert.equal(counts(questions[1], 'standard'), false);
  assert.equal(gradeEligible(section), false);
});

test('limited readable answer earns supported credit against full printed maximum without a grade', () => {
  const [limited] = sittingSections(result([q({ marks_awarded: 3.5, max_marks: 7, response_status: 'partial', qualification: 'limited_readability' })]));
  assert.deepEqual([limited.awarded, limited.max, limited.percent, limited.grade, limited.coverage.state], [3.5, 7, 50, null, 'partial']);
  const [unfinished] = sittingSections(result([q({ marks_awarded: 3.5, max_marks: 7, response_status: 'partial' })]));
  assert.deepEqual([unfinished.max, unfinished.grade, unfinished.coverage.state], [7, 'C', 'complete']);
});

test('incomplete supplied section cannot be upgraded by scoring every observed row', () => {
  const [section] = sittingSections(result([q({ marks_awarded: 5 })], { section: 'A', status: 'incomplete', source_pages: [1] }));
  assert.equal(section.percent, 100);
  assert.equal(section.coverage.state, 'partial');
  assert.equal(section.grade, null);
  assert.equal(section.coverage.total_max, 5, 'Do not invent maxima for missing questions');
});

test('supplied blank remains zero with full printed maximum; absent section remains excluded', () => {
  const blank = q({ teacher_answer: '', marks_awarded: 0, max_marks: 35, response_status: 'unanswered' });
  const absent = q({ section: 'Section B', marks_awarded: null, max_marks: 40, assessment_state: 'not_supplied', response_status: 'section_not_supplied' });
  const source = result([blank, absent]);
  source.submission.sections.push({ section: 'B', status: 'not_supplied', source_pages: [] });
  const [section] = sittingSections(source);
  assert.deepEqual([section.awarded, section.max, section.percent, section.grade, section.grade_eligible], [0, 35, 0, 'D', true]);
  assert.deepEqual(unansweredSections(source), ['Section B']);
  assert.equal(coverageOf([absent]).state, 'not_supplied');
  assert.equal(coverageOf([absent]).supplied_max, 0);
});

test('unreadable, unmatched, identity and provider failures are never zero grades', () => {
  for (const status of ['unreadable', 'missing_page', 'extraction_failure', 'unmatched', 'identity_unresolved', 'marking_unavailable', 'paper_unavailable']) {
    const question = q({ marks_awarded: null, assessment_state: 'unassessable', response_status: status });
    const [section] = sittingSections(result([question]));
    assert.deepEqual([section.awarded, section.max, section.percent, section.grade, section.coverage.state], [null, null, null, null, 'unassessable'], status);
    assert.equal(counts(question), false);
  }
});

test('empty no-assessment attempt remains reportable with no fabricated paper or marks', () => {
  const completion = { state: 'no_assessment', reason_code: 'paper_unavailable' };
  const sections = sittingSections({ questions: [], outcome: 'no_assessment', completion });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'Assessment status');
  assert.deepEqual([sections[0].questions, sections[0].awarded, sections[0].max, sections[0].percent, sections[0].grade], [[], null, null, null, null]);
  assert.equal(sections[0].coverage.total_max, 0);
  assert.deepEqual(sections[0].completion, completion);
  assert.equal(potentialFor(sections), null);
  assert.equal(needOf(sections), null);
  assert.equal(trainingPlanFor(sections, framework), null);
});

test('complete section cannot stand in for an incomplete whole-teacher category', () => {
  const [complete] = sittingSections(result([q({ marks_awarded: 5 })]));
  const [partial] = sittingSections(result([q({ section: 'Section B', marks_awarded: 5, qualification: 'limited_readability' })], { section: 'B', status: 'supplied_complete' }));
  assert.equal(potentialFor([complete]).level, 'mentor');
  for (const classify of [potentialFor, needOf, (s) => trainingPlanFor(s, framework)]) assert.equal(classify([complete, partial]), null);
  assert.equal(gradeEligible({ ...partial, grade: 'A', grade_eligible: true }), false, 'Cannot override incomplete coverage with a stale grade');
});

test('legacy results retain historical coverage and lenient interpretation', () => {
  const questions = [{ section: 'Section A', question: '1', teacher_answer: 'Answer', marks_awarded: 4, max_marks: 5 }, { section: 'Section A', question: '2', teacher_answer: '', marks_awarded: 0, max_marks: 5 }];
  const [standard] = sittingSections({ questions });
  const [lenient] = sittingSections({ questions, marking: 'lenient' });
  assert.deepEqual([standard.percent, standard.grade, lenient.percent, lenient.grade], [40, 'D', 80, 'B']);
  assert.equal(standard.coverage, undefined);
  const [olderUnreadable] = sittingSections({ questions: [{ ...questions[0], response_status: 'unreadable', marks_awarded: 0 }] });
  assert.equal(olderUnreadable.grade, 'D');
});

test('report fingerprint changes for coverage, eligibility, outcome or completion changes', () => {
  const sections = sittingSections(result([q()]));
  const basis = fingerprint(resultsBasis(sections));
  for (const change of [(s) => { s.coverage.state = 'partial'; }, (s) => { s.grade_eligible = false; }, (s) => { s.outcome = 'no_assessment'; }, (s) => { s.completion = { state: 'no_assessment', reason_code: 'changed' }; }]) {
    const other = structuredClone(sections); change(other[0]);
    assert.notEqual(fingerprint(resultsBasis(other)), basis);
  }
});

const school = Number(db.prepare("INSERT INTO schools (name) VALUES ('Synthetic Coverage School')").run().lastInsertRowid);
const testId = Number(db.prepare("INSERT INTO tests (school_id, name) VALUES (?, 'Evidence Coverage')").run(school).lastInsertRowid);
function persist(name, source) {
  const teacher = Number(db.prepare("INSERT INTO teachers (school_id, name, grade) VALUES (?, ?, 'Grade 5')").run(school, name).lastInsertRowid);
  const assessment = Number(db.prepare("INSERT INTO assessments (school_id, teacher_id, test_id, title, status, ai_status, ai_result) VALUES (?, ?, ?, 'Synthetic sitting', 'evaluated', 'done', ?)").run(school, teacher, testId, JSON.stringify(source)).lastInsertRowid);
  if (source.outcome === 'no_assessment') db.prepare("UPDATE assessments SET status = 'finalized' WHERE id = ?").run(assessment);
  return { teacher, assessment };
}
const partial = persist('Limited Evidence Teacher', result([q({ marks_awarded: 5 }), q({ question: '2', marks_awarded: null, max_marks: 10, assessment_state: 'unassessable', response_status: 'unreadable' })]));
const complete = persist('Complete Evidence Teacher', result([q({ marks_awarded: 4 })]));
const none = persist('No Evidence Teacher', { questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', reason_code: 'paper_unavailable' } });
db.prepare("INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, position) VALUES (?, 'response', 'synthetic-unavailable.png', 'synthetic-unavailable.png', 'image/png', 0)").run(none.assessment);

test('assessment, roster and teacher profile APIs retain evidence limits and no grade', async () => {
  const assessment = await request(`/api/assessments/${partial.assessment}`);
  assert.equal(assessment.status, 200);
  assert.deepEqual([assessment.body.sections[0].percent, assessment.body.sections[0].grade, assessment.body.sections[0].coverage.state], [100, null, 'partial']);
  const roster = await request(`/api/teachers/roster?school_id=${school}&test_id=${testId}`);
  const teacher = roster.body.teachers.find((t) => t.id === partial.teacher);
  assert.equal(teacher.sections[0].grade_eligible, false);
  assert.equal(teacher.sections[0].coverage.unassessable_max, 10);
  const profile = await request(`/api/teachers/${partial.teacher}/profile`);
  assert.equal(profile.body.tests[0].potential, null);
  assert.equal(profile.body.tests[0].sections[0].coverage.state, 'partial');
  const terminal = await request(`/api/assessments/${none.assessment}`);
  assert.equal(terminal.body.sections[0].outcome, 'no_assessment');
  assert.equal(terminal.body.sections[0].completion.state, 'no_assessment');
});

test('correction API preserves unassessable null while another row changes and rejects a fabricated zero', async () => {
  const saved = await request(`/api/assessments/${partial.assessment}/marks`, { marks: [4.5, null] });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.ai_result.questions[1].marks_awarded, null);
  assert.equal(saved.body.sections[0].max, 5);
  assert.equal(saved.body.sections[0].grade, null);
  const rejected = await request(`/api/assessments/${partial.assessment}/marks`, { marks: [4.5, 0] });
  assert.equal(rejected.status, 400);
  assert.equal(teacherResults(partial.teacher, testId)[0].questions[1].marks_awarded, null);
});

test('dashboard counts and averages include only complete coverage and show limited evidence separately', async () => {
  const response = await request(`/api/dashboard/school?school_id=${school}&test_id=${testId}`);
  assert.equal(response.status, 200);
  const section = response.body.sections.find((s) => s.key === 'A');
  assert.deepEqual([section.sat, section.papers, section.average], [1, 1, 80]);
  assert.deepEqual(section.counts, { A: 0, B: 1, C: 0, D: 0 });
  assert.equal(section.limited.some((t) => t.id === partial.teacher), true);
  assert.equal(response.body.limited_assessment.some((t) => t.id === none.teacher), true);
  assert.equal(response.body.waiting.to_evaluate.some((t) => t.id === none.teacher), false);
  assert.equal(response.body.waiting.not_started.some((t) => t.id === none.teacher), false);
  assert.equal(response.body.potential.flatMap((p) => p.teachers).some((t) => t.id === partial.teacher || t.id === none.teacher), false);
});

test('shared chips and teacher progress render limited evidence without false grade or progress delta', async () => {
  const restore = installReportDom({});
  try {
    const { sectionChip, percentChip, sectionScoreText } = await import('../public/js/ui.js');
    const [limited] = sittingSections(result([q({ qualification: 'limited_readability' })]));
    assert.match(sectionChip(limited).textContent, /80%.*assessed only.*no grade/);
    assert.match(percentChip(limited).textContent, /assessed only/);
    assert.doesNotMatch(sectionChip(limited).outerHTML, /grade-B/);
    assert.match(sectionScoreText(limited), /assessed questions only/);
    const [unassessable] = sittingSections(result([q({ assessment_state: 'unassessable', marks_awarded: null })]));
    assert.match(sectionChip(unassessable).textContent, /Not assessed/);
    assert.equal(sectionScoreText(unassessable), 'Not assessed');

    const { renderTeacherProfile } = await import('../public/js/views/teachers.js');
    const completeSection = { ...sittingSections(result([q({ marks_awarded: 3 })]))[0], assessment_id: complete.assessment };
    const tests = [completeSection, limited, { ...completeSection, awarded: 4, percent: 80 }].map((section, i) => ({ test: { id: i + 1, name: `Test ${i + 1}` }, sections: [section], potential: null, sittings: [], report: null }));
    globalThis.fetch = async () => new Response(JSON.stringify({ teacher: { id: complete.teacher, name: 'Synthetic Teacher' }, school: { id: school, name: 'Synthetic School' }, grades: [], tests }), { headers: { 'content-type': 'application/json' } });
    const root = new ReportNode('main');
    await renderTeacherProfile(root, complete.teacher);
    const changes = root.querySelectorAll('.change').map((el) => el.textContent);
    assert.deepEqual(changes, ['+20']);
    assert.doesNotMatch(root.textContent, /null \/ null/);
  } finally { restore(); }
});

test('latest no-assessment attempt supersedes the same section and selected paper only', () => {
  const source = result([q({ section: 'Section B', marks_awarded: 5 })], { section: 'B', status: 'supplied_complete' });
  const { teacher, assessment } = persist('Superseded Section Teacher', source);
  const paperId = Number(db.prepare("INSERT INTO papers (title, sections, subject, stored_name, original_name) VALUES ('Synthetic Science', 'B', 'Science', 'synthetic-science.pdf', 'synthetic-science.pdf')").run().lastInsertRowid);
  const otherPaperId = Number(db.prepare("INSERT INTO papers (title, sections, subject, stored_name, original_name) VALUES ('Synthetic Mathematics', 'B', 'Mathematics', 'synthetic-math.pdf', 'synthetic-math.pdf')").run().lastInsertRowid);
  db.prepare('INSERT INTO assessment_papers (assessment_id, paper_id) VALUES (?, ?)').run(assessment, paperId);
  const add = (value, paper) => {
    const id = Number(db.prepare("INSERT INTO assessments (school_id, teacher_id, test_id, title, section, status, ai_status, ai_result) VALUES (?, ?, ?, 'Later sitting', 'B', 'evaluated', 'done', ?)").run(school, teacher, testId, JSON.stringify(value)).lastInsertRowid);
    db.prepare('INSERT INTO assessment_papers (assessment_id, paper_id) VALUES (?, ?)').run(id, paper);
    return id;
  };
  add(source, otherPaperId);
  const latest = add({ questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', section: 'B', reason_code: 'paper_unavailable' } }, paperId);
  const sections = teacherResults(teacher, testId);
  assert.equal(sections.length, 2);
  const unavailable = sections.find((s) => s.subject === 'Science');
  assert.equal(unavailable.assessment_id, latest);
  assert.equal(unavailable.key, 'B');
  assert.equal(unavailable.grade, null);
  assert.equal(unavailable.outcome, 'no_assessment');
  assert.equal(sections.find((s) => s.subject === 'Mathematics').grade, 'A');
  assert.equal(potentialFor(sections), null);
});

test('dashboard DOM labels limited evidence and never prints a null comparative average', async () => {
  const response = await request(`/api/dashboard/school?school_id=${school}&test_id=${testId}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.assessed, 2, 'Only teachers with a complete section grade count here');
  const restore = installReportDom({});
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ totals: { schools: 1, teachers: response.body.teacher_count, not_started: 0, to_evaluate: 0, marking: 0, failed: 0, reports_to_build: response.body.teacher_count }, schools: [response.body], grades: [{ grade: 'A', label: 'Excellent' }, { grade: 'B', label: 'Good' }, { grade: 'C', label: 'Fair' }, { grade: 'D', label: 'Needs Practice' }] }), { headers: { 'content-type': 'application/json' } });
    const { renderDashboard } = await import('../public/js/views/dashboard.js');
    const root = new ReportNode('main');
    await renderDashboard(root);
    assert.match(root.textContent, /Limited assessment evidence:/);
    assert.match(root.textContent, /excluded from grade comparisons/);
    assert.doesNotMatch(root.textContent, /average null%|average NaN%/);
  } finally { restore(); }
});

test('whole-paper no-ledger outcome replaces earlier whole-paper grades without inventing sections', () => {
  const initial = result([q(), q({ section: 'Section B', marks_awarded: 5 })]);
  initial.submission.sections.push({ section: 'B', status: 'supplied_complete' });
  const { teacher } = persist('Whole Paper Replacement Teacher', initial);
  const add = (source, section) => Number(db.prepare("INSERT INTO assessments (school_id, teacher_id, test_id, title, section, status, ai_status, ai_result) VALUES (?, ?, ?, 'New sitting', ?, 'evaluated', 'done', ?)").run(school, teacher, testId, section, JSON.stringify(source)).lastInsertRowid);
  add(result([q({ section: 'Section C' })], { section: 'C', status: 'supplied_complete' }), 'C');
  const terminal = add({ questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', section: '', reason_code: 'paper_unavailable' } }, null);
  const sections = teacherResults(teacher, testId);
  assert.deepEqual(sections.map((s) => s.key), ['', 'C']);
  assert.equal(sections[0].assessment_id, terminal);
  assert.equal(sections[0].max, null);
  assert.equal(sections[1].grade, 'B');
  assert.equal(needOf(sections), null);
});

test('terminal no-assessment sittings stay closed; later board uploads use a fresh sitting', async () => {
  const { currentAssessmentFor, sittingForPaper } = await import('../server/sittings.js');
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(none.teacher);
  const round = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId);
  const fresh = currentAssessmentFor(teacher, round);
  assert.notEqual(fresh.id, none.assessment);
  assert.equal(fresh.status, 'draft');
  assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(none.assessment).status, 'finalized');

  const source = { questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', section: 'B' } };
  const part = persist('Section Terminal Upload Teacher', source);
  db.prepare("UPDATE assessments SET section = 'B' WHERE id = ?").run(part.assessment);
  const paper = Number(db.prepare("INSERT INTO papers (title, sections, subject, stored_name, original_name) VALUES ('Synthetic Repeat', 'B', 'Science', 'synthetic-repeat.pdf', 'synthetic-repeat.pdf')").run().lastInsertRowid);
  db.prepare('INSERT INTO assessment_papers (assessment_id, paper_id) VALUES (?, ?)').run(part.assessment, paper);
  const person = db.prepare('SELECT * FROM teachers WHERE id = ?').get(part.teacher);
  assert.equal(sittingForPaper(person, round, 'B', paper, { create: false }), null);
  const next = sittingForPaper(person, round, 'B', paper);
  assert.notEqual(next.id, part.assessment);
  assert.equal(next.status, 'draft');
});

test('adding actual evidence to a finalized sitting reopens evaluation and invalidates its old result', async () => {
  const { attachScans, attachStoredPages } = await import('../server/scans.js');
  const { currentSourceBasis, digest } = await import('../server/provenance.js');
  for (const kind of ['uploaded', 'stored']) {
    const source = { questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', section: 'A' } };
    const item = persist(`Reopened ${kind} Teacher`, source);
    source.audit = { source_digest: digest(currentSourceBasis(item.assessment)) };
    db.prepare("UPDATE assessments SET ai_result = ?, evaluation_checkpoint = '{}', evaluation_progress = '{\"stage\":\"complete\"}' WHERE id = ?").run(JSON.stringify(source), item.assessment);
    attachScans(item.assessment, 'response', []);
    assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(item.assessment).status, 'finalized', 'An empty upload is not new evidence');
    if (kind === 'uploaded') attachScans(item.assessment, 'response', [{ filename: 'synthetic-new-page.png', originalname: 'synthetic-new-page.png', mimetype: 'image/png', size: 4 }]);
    else attachStoredPages(item.assessment, 'response', [{ stored_name: 'synthetic-stored-page.png', original_name: 'synthetic-stored-page.png', mime_type: 'image/png', size_bytes: 4 }]);
    const changed = db.prepare('SELECT * FROM assessments WHERE id = ?').get(item.assessment);
    assert.deepEqual([changed.status, changed.ai_status, changed.evaluation_checkpoint, changed.evaluation_progress], ['scanned', 'none', null, null]);
    assert.equal(JSON.parse(changed.ai_result).outcome, 'no_assessment', 'Prior outcome stays in historical evidence');
    assert.equal(teacherResults(item.teacher, testId)[0].evaluation_stale, true);
    const response = await request(`/api/dashboard/school?school_id=${school}&test_id=${testId}`);
    assert.equal(response.body.waiting.to_evaluate.some((t) => t.id === item.teacher), true);
  }
});

test('no-assessment with only excluded sections still yields a neutral status artifact', () => {
  const source = result([q({ section: 'Section B', marks_awarded: null, assessment_state: 'not_supplied', response_status: 'section_not_supplied' })], { section: 'B', status: 'not_supplied' });
  source.outcome = 'no_assessment';
  source.completion = { state: 'no_assessment', section: 'B' };
  const sections = sittingSections(source);
  assert.equal(sections.length, 1);
  assert.deepEqual([sections[0].key, sections[0].questions, sections[0].awarded, sections[0].max, sections[0].grade], ['B', [], null, null, null]);
  assert.equal(sections[0].coverage.total_max, 0);
  assert.equal(sections[0].outcome, 'no_assessment');
});

test('assembling assessments are readable but every assessment mutation is blocked before disk writes', async () => {
  const staged = persist('Batch Owned Teacher', result([q()]));
  db.prepare("UPDATE assessments SET status = 'assembling', ai_status = 'none' WHERE id = ?").run(staged.assessment);
  const file = Number(db.prepare("INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, position) VALUES (?, 'response', 'staged-source.png', 'staged-source.png', 'image/png', 1)").run(staged.assessment).lastInsertRowid);
  const baseline = db.prepare('SELECT * FROM assessments WHERE id = ?').get(staged.assessment);
  const response = await request(`/api/assessments/${staged.assessment}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.response_files.length, 1);
  assert.deepEqual(response.body.sections, []);
  assert.deepEqual(teacherResults(staged.teacher, testId), []);
  for (const [method, suffix, body] of [
    ['PUT', '', { title: 'Tampered', status: 'evaluated', score: 10, max_score: 10 }],
    ['PUT', '/marks', { marks: [5] }], ['PUT', '/papers', { paper_ids: [] }],
    ['POST', '/evaluate', {}], ['POST', '/writing', {}], ['POST', '/swap', {}],
    ['POST', '/move', { teacher_id: complete.teacher }], ['DELETE', `/files/${file}`, {}], ['DELETE', '', {}],
  ]) {
    const attempt = await nativeFetch(`${base}/api/assessments/${staged.assessment}${suffix}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(attempt.status, 409, `${method} ${suffix}`);
    assert.match((await attempt.json()).error, /still being assembled/);
  }
  const { UPLOADS_DIR } = await import('../server/db.js');
  const filesBefore = fs.readdirSync(UPLOADS_DIR);
  const upload = new FormData(); upload.set('kind', 'response'); upload.append('files', new Blob(['synthetic'], { type: 'image/png' }), 'extra.png');
  const deniedUpload = await nativeFetch(`${base}/api/assessments/${staged.assessment}/files`, { method: 'POST', body: upload });
  assert.equal(deniedUpload.status, 409);
  assert.deepEqual(fs.readdirSync(UPLOADS_DIR), filesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM assessments WHERE id = ?').get(staged.assessment), baseline);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessment_files WHERE assessment_id = ?').get(staged.assessment).n, 1);
  const dash = await request(`/api/dashboard/school?school_id=${school}&test_id=${testId}`);
  assert.equal(dash.body.waiting.marking.some((t) => t.id === staged.teacher), true);
  assert.equal(dash.body.waiting.to_evaluate.some((t) => t.id === staged.teacher), false);

  const restore = installReportDom({});
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    globalThis.fetch = async () => new Response(JSON.stringify(response.body), { headers: { 'content-type': 'application/json' } });
    const { renderAssessmentDetail } = await import('../public/js/views/assessments.js');
    const root = new ReportNode('main');
    await renderAssessmentDetail(root, staged.assessment);
    assert.match(root.textContent, /Preparing submission/);
    assert.match(root.textContent, /pages are read-only/);
    assert.doesNotMatch(root.textContent, /Save assessment|Swap question paper and answer paper|80%/);
    const buttons = root.querySelectorAll('button');
    for (const name of ['Delete', 'Remove', 'Choose from the paper library', 'Preparing submission…']) {
      const button = buttons.find((b) => b.textContent === name);
      assert.ok(button, name);
      assert.notEqual(button.getAttribute('disabled'), null, name);
    }
  } finally { restore(); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test('staged sources accept only internal batch appends; teacher-board upload goes to a new sitting', async () => {
  const { attachScans, attachStoredPages, swapScanKinds, movePages } = await import('../server/scans.js');
  const staged = persist('Fresh Upload During Batch Teacher', { questions: [] });
  db.prepare("UPDATE assessments SET status = 'assembling', ai_status = 'none' WHERE id = ?").run(staged.assessment);
  const stored = { stored_name: 'batch-sibling.png', original_name: 'batch-sibling.png', mime_type: 'image/png', size_bytes: 4 };
  assert.throws(() => attachScans(staged.assessment, 'response', []), /still being assembled/);
  assert.throws(() => attachStoredPages(staged.assessment, 'response', [stored]), /still being assembled/);
  assert.throws(() => swapScanKinds(staged.assessment), /still being assembled/);
  assert.throws(() => movePages(complete.assessment, staged.assessment, ['response'], { from: 'One', to: 'Two' }), /still being assembled/);
  assert.throws(() => movePages(staged.assessment, complete.assessment, ['response'], { from: 'One', to: 'Two' }), /still being assembled/);
  attachStoredPages(staged.assessment, 'response', [stored], { allowAssembling: true });
  assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(staged.assessment).status, 'assembling');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessment_files WHERE assessment_id = ?').get(staged.assessment).n, 1);

  const data = new FormData(); data.set('kind', 'response'); data.set('test_id', testId); data.append('files', new Blob(['synthetic'], { type: 'image/png' }), 'new-sitting.png');
  const upload = await nativeFetch(`${base}/api/teachers/${staged.teacher}/scans`, { method: 'POST', body: data });
  assert.equal(upload.status, 201);
  const fresh = await upload.json();
  assert.notEqual(fresh.assessment_id, staged.assessment);
  assert.equal(fresh.assessment_status, 'scanned');
  assert.equal(fresh.response_count, 1);
  assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(staged.assessment).status, 'assembling');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessment_files WHERE assessment_id = ?').get(staged.assessment).n, 1);
});
