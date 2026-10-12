import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Synthetic fixture data only. No credentials or provider access.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-report-finalization-'));
process.env.DATA_DIR = dataDir;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const { GRADES, NEEDS, SECTION_TITLES, teacherResults } = await import('../server/results.js');
const { queueTeacherReports, queueSchoolReport, findReport, schoolOverview, questionsOf, teacherReportBasis, isStale, reportNarrative } = await import('../server/reports.js');
const { evidenceFor, default: reportRoutes } = await import('../server/routes/reports.js');
const { ReportNode, installReportDom } = await import('./report-dom-helper.js');
const schoolId = Number(db.prepare('INSERT INTO schools (name) VALUES (?)').run('Synthetic Coverage School').lastInsertRowid);
const testId = Number(db.prepare('INSERT INTO tests (school_id, name) VALUES (?, ?)').run(schoolId, 'Synthetic finalization').lastInsertRowid);
const insertTeacher = db.prepare('INSERT INTO teachers (school_id, name, grade) VALUES (?, ?, ?)');
const insertAssessment = db.prepare("INSERT INTO assessments (school_id, teacher_id, test_id, title, status, ai_status, ai_result, ai_evaluated_at) VALUES (?, ?, ?, 'Synthetic sitting', 'evaluated', 'done', ?, '2026-10-12 00:00:00')");
const q = (n, state, awarded, extra = {}) => ({ section: 'Section A', question: String(n), max_marks: 5, marks_awarded: awarded, assessment_state: state, response_status: state === 'assessed' ? 'answered' : 'unreadable', question_text: 'Explain an AI model and review its classroom uses.', teacher_answer: state === 'assessed' ? 'OpenAI tools can help. Review a model answer carefully.' : '[illegible]', expected_answer: 'Review an AI model’s suggestions and verify the information.', feedback: 'A relevant classroom example.', ...extra });
const addTeacher = (name, result) => {
  const teacherId = Number(insertTeacher.run(schoolId, name, 'Grade 5').lastInsertRowid);
  const assessmentId = Number(insertAssessment.run(schoolId, teacherId, testId, JSON.stringify(result)).lastInsertRowid);
  return { teacherId, assessmentId, name };
};
const complete = addTeacher('Complete Teacher', { outcome: 'complete', questions: [q(1, 'assessed', 4)], submission: { sections: [{ section: 'A', status: 'supplied_complete' }] } });
const partial = addTeacher('Partial Teacher', { outcome: 'partial', questions: [q(1, 'assessed', 4, { feedback: 'A relevant classroom example. EXTRACTION_PROCESS_SENTINEL', audit: { uncertainty: 'EXTRACTION_PROCESS_SENTINEL' } }), q(2, 'unassessable', null), q(3, 'assessed', 0, { teacher_answer: '', response_status: 'unanswered' })], submission: { sections: [{ section: 'A', status: 'supplied_complete' }] }, audit: { excluded_response_pages: [2], model: 'MODEL_PROCESS_SENTINEL', match_reason: 'MATCH_PROCESS_SENTINEL' } });
const unavailable = addTeacher('Unavailable Teacher', { questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', reason_code: 'PROVIDER_PROCESS_SENTINEL' }, audit: { excluded_response_pages: [1] } });
const insertFile = db.prepare('INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, position) VALUES (?, ?, ?, ?, ?, ?)');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB7sAAAAASUVORK5CYII=', 'base64');
for (const [assessment, names] of [[partial, ['safe-response.png', 'wrong-teacher.png', 'safe-response-2.png']], [unavailable, ['unresolved-response.png']]]) {
  names.forEach((name, index) => { fs.writeFileSync(path.join(UPLOADS_DIR, name), png); insertFile.run(assessment.assessmentId, 'response', name, name, 'image/png', index); });
}
insertFile.run(unavailable.assessmentId, 'question_paper', 'unavailable-question.png', 'unavailable-question.png', 'image/png', 0);
const done = async (kind, teacherId = null, targetTest = testId) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const report = findReport(kind, targetTest, teacherId);
    if (report?.status !== 'running') { assert.equal(report?.status, 'done', report?.error); return report; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic report did not reach a terminal state.');
};
after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('no provider is required to persist professional complete, partial and no-result reports', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Finalization without configuration must not call a provider.'));
  for (const teacher of [complete, partial, unavailable]) {
    assert.equal(queueTeacherReports(teacher.teacherId, testId), null);
    const report = await done('teacher', teacher.teacherId);
    assert.ok(report.content.teacher.summary);
    assert.ok(report.content.management.summary);
    assert.equal(isStale(report, teacherResults(teacher.teacherId, testId)), false);
    assert.doesNotMatch(JSON.stringify(report.content), /PROCESS_SENTINEL/);
    if (teacher !== complete) assert.equal(report.content.potential, null);
  }
  assert.equal(queueSchoolReport(schoolId, testId), null);
  const school = await done('school');
  assert.match(school.content.summary, /incomplete coverage/);
  assert.equal(school.content.submitted, 3);
  assert.equal(school.content.assessed, 2);
  assert.equal(fetch.mock.callCount(), 0);
});

test('a failed narrative provider preserves a deterministic teacher and school artifact', async (t) => {
  process.env.OPENAI_API_KEY = 'synthetic-test-only';
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'SYNTHETIC_PROVIDER_FAILURE' } }), { status: 401 }));
  try {
    assert.equal(queueTeacherReports(complete.teacherId, testId), null);
    const report = await done('teacher', complete.teacherId);
    assert.equal(report.model, 'deterministic-v2');
    assert.doesNotMatch(JSON.stringify(report.content), /SYNTHETIC_PROVIDER_FAILURE|OpenAI rejected/);
    assert.ok(fetch.mock.callCount() > 0);
    // School with partial evidence must not ask a provider to interpret incomplete grades.
    const calls = fetch.mock.callCount();
    assert.equal(queueSchoolReport(schoolId, testId), null);
    const school = await done('school');
    assert.equal(school.model, 'deterministic-v2');
    assert.equal(fetch.mock.callCount(), calls);
  } finally { delete process.env.OPENAI_API_KEY; }
});

test('school provider failure and empty teacher narrative both retain a final report', async (t) => {
  const completeTest = Number(db.prepare('INSERT INTO tests (school_id, name) VALUES (?, ?)').run(schoolId, 'Synthetic complete school').lastInsertRowid);
  insertAssessment.run(schoolId, complete.teacherId, completeTest, JSON.stringify({ outcome: 'complete', questions: [q(1, 'assessed', 4)] }));
  process.env.OPENAI_API_KEY = 'synthetic-test-only';
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'SYNTHETIC_SCHOOL_FAILURE' } }), { status: 401 }));
  try {
    assert.equal(queueSchoolReport(schoolId, completeTest), null);
    const school = await done('school', null, completeTest);
    assert.equal(school.model, 'deterministic-v2');
    assert.match(school.content.summary, /1 of 3 teachers/);
    assert.ok(fetch.mock.callCount() > 0);
    fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }), { status: 200 }));
    assert.equal(queueTeacherReports(complete.teacherId, testId), null);
    const report = await done('teacher', complete.teacherId);
    assert.equal(report.model, 'deterministic-v2');
    assert.match(report.content.teacher.summary, /Thank you/);
    assert.ok(report.content.management.summary);
  } finally { delete process.env.OPENAI_API_KEY; }
});

test('a school with only terminal no-result submissions still gets a neutral final artifact', async (t) => {
  const statusTest = Number(db.prepare('INSERT INTO tests (school_id, name) VALUES (?, ?)').run(schoolId, 'Synthetic status-only school').lastInsertRowid);
  insertAssessment.run(schoolId, unavailable.teacherId, statusTest, JSON.stringify({ questions: [], outcome: 'no_assessment', completion: { state: 'no_assessment', reason_code: 'INTERNAL_ONLY' } }));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Status-only reports cannot invoke a provider.'));
  assert.equal(queueSchoolReport(schoolId, statusTest), null);
  const school = await done('school', null, statusTest);
  assert.equal(school.content.submitted, 1);
  assert.equal(school.content.assessed, 0);
  assert.deepEqual(school.content.section_stats, []);
  assert.equal(school.content.whole.classified, 0);
  assert.match(school.content.summary, /No assessment result is available/);
  assert.doesNotMatch(JSON.stringify(school.content), /INTERNAL_ONLY/);
});

test('final question projection retains null, genuine zero and academic AI content without operational uncertainty', () => {
  const rows = questionsOf(teacherResults(partial.teacherId, testId)[0]);
  assert.deepEqual(rows.map((row) => row.marks_awarded), [4, null, 0]);
  assert.deepEqual(rows.map((row) => row.blank), [false, false, true]);
  assert.equal(rows[0].feedback, 'A relevant classroom example.');
  assert.equal(rows[1].feedback, '');
  assert.match(rows[0].question_text, /AI model and review/);
  assert.match(rows[0].teacher_answer, /OpenAI/);
  assert.match(rows[0].expected_answer, /AI model/);
  assert.equal('audit' in rows[0], false);
  for (const response_status of ['identity_unresolved', 'unmatched', 'paper_unavailable']) {
    const row = questionsOf({ questions: [q(4, 'unassessable', null, { response_status, max_marks: null, teacher_answer: 'UNALIGNED_PRIVATE_SENTINEL' })] })[0];
    assert.equal(row.teacher_answer, '');
    assert.equal(row.max_marks, null);
  }
  assert.equal(reportNarrative('The teacher explains how to review an AI model.'), 'The teacher explains how to review an AI model.');
  assert.equal(reportNarrative('Paper matching: high confidence. Pending review: human confirmation. The teacher explains how to review an AI model.'), 'The teacher explains how to review an AI model.');
  assert.equal(reportNarrative('The teacher wrote, “Paper matching: high confidence.” This is an academic example.'), 'The teacher wrote, “Paper matching: high confidence.” This is an academic example.');
});

test('school categories and means use complete results and disclose coverage', () => {
  const overview = schoolOverview(schoolId, testId);
  assert.equal(overview.section_stats.find((section) => section.key === 'A').sat, 1);
  assert.equal(overview.section_stats.find((section) => section.key === 'A').average, 80);
  assert.equal(overview.whole.classified, 1);
  assert.deepEqual(overview.incomplete, ['Partial Teacher', 'Unavailable Teacher']);
  assert.equal(overview.whole.needs.on_track, 1);
  assert.equal(overview.whole.needs.support, 0);
});

test('current audit excludes wrong-teacher scans using one-based response ordering', () => {
  const scans = evidenceFor(partial.teacherId, teacherResults(partial.teacherId, testId));
  assert.deepEqual(scans[0].response.map((file) => file.url), ['/uploads/safe-response.png', '/uploads/safe-response-2.png']);
  const statusScans = evidenceFor(unavailable.teacherId, teacherResults(unavailable.teacherId, testId));
  assert.deepEqual(statusScans[0].response, []);
  assert.deepEqual(statusScans[0].question_paper, []);
});

test('actual report GET routes and DOM finalize all audiences without process text or false zero', async () => {
  const { default: express } = await import('express');
  const app = express(); app.use('/api/reports', reportRoutes);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const payload = await fetch(`${base}/api/reports/teacher?teacher_id=${partial.teacherId}&test_id=${testId}`).then((r) => r.json());
    const statusPayload = await fetch(`${base}/api/reports/teacher?teacher_id=${unavailable.teacherId}&test_id=${testId}`).then((r) => r.json());
    const schoolPayload = await fetch(`${base}/api/reports/school?school_id=${schoolId}&test_id=${testId}`).then((r) => r.json());
    const restore = installReportDom({ teacher: payload, school: schoolPayload });
    try {
      const { renderTeacherReport, renderSchoolReport } = await import('../public/js/views/reports.js');
      for (const audience of ['teacher', 'management', 'school']) {
        const root = new ReportNode('main');
        if (audience === 'school') await renderSchoolReport(root, schoolId, testId);
        else await renderTeacherReport(root, partial.teacherId, testId, new URLSearchParams(audience === 'management' ? 'for=management' : ''));
        await Promise.all(root.querySelectorAll('.report-evidence').map((node) => node.ready));
        const sheet = root.querySelector('.report-sheet'); assert.ok(sheet);
        assert.equal(sheet.querySelector('.report-footer').textContent, 'Report Generated by UpSchool');
        assert.equal(sheet.querySelector('.report-footer').querySelector('img').getAttribute('src'), '/img/upschool-logo.png');
        assert.match(sheet.textContent, /Synthetic Coverage School/);
        assert.doesNotMatch(sheet.textContent, /PROCESS_SENTINEL|pending review|inferred rubric|Report Date|Press Build|Marked by|AI assistant/i);
        assert.equal(sheet.querySelectorAll('figcaption').length, 0);
        if (audience !== 'school') {
          assert.match(sheet.textContent, /— \/ 5/);
          assert.match(sheet.textContent, /0 \/ 5/);
          assert.match(sheet.textContent, /Not assessable from the submitted response/);
          assert.match(sheet.textContent, /OpenAI tools/);
          assert.match(sheet.textContent, /Final grade withheld/);
          assert.equal(sheet.querySelectorAll('.grade-chip').length, 0);
          assert.equal(sheet.querySelectorAll('.evidence-page').length, 2);
          assert.equal(sheet.querySelectorAll('.potential-box').length, 0);
        } else assert.match(sheet.textContent, /Incomplete assessment coverage/);
      }
      // An unrenderable original cannot prevent a neutral status artifact.
      statusPayload.evidence[0].question_paper.push({ url: '/synthetic-unrenderable.tiff', type: 'image/tiff' });
      globalThis.fetch = async () => new Response(JSON.stringify(statusPayload), { headers: { 'content-type': 'application/json' } });
      const root = new ReportNode('main');
      await renderTeacherReport(root, unavailable.teacherId, testId);
      await Promise.all(root.querySelectorAll('.report-evidence').map((node) => node.ready));
      const sheet = root.querySelector('.report-sheet'); assert.ok(sheet);
      assert.match(sheet.textContent, /No assessment result is available for this submission/);
      assert.equal(sheet.querySelectorAll('.evidence-missing').length, 0);
      assert.doesNotMatch(sheet.textContent, /TIFF|Upload it|could not be shown/);
      assert.equal(sheet.querySelectorAll('.q-marks').length, 0);
      assert.equal(sheet.querySelectorAll('.grade-chip').length, 0);
      assert.equal(sheet.querySelectorAll('.evidence-page').length, 0);
    } finally { restore(); }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

const chromium = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-headless-shell'].find((p) => fs.existsSync(p));
test('actual report routes print partial and status artifacts cleanly in Chromium PDF', { skip: process.env.REPORT_PDF_QA !== '1' ? 'Set REPORT_PDF_QA=1 for Chromium PDF verification.' : !chromium, timeout: 60_000 }, async () => {
  const { default: express } = await import('express');
  const { default: puppeteer } = await import('puppeteer-core');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const app = express();
  app.get('/fixture', (_req, res) => res.send('<html><head><link rel="stylesheet" href="/css/styles.css"></head><body><main id="view"></main><div id="toasts"></div></body></html>'));
  app.use('/api/reports', reportRoutes);
  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/fonts', express.static(path.join(repoRoot, 'node_modules', '@fontsource')));
  app.use(express.static(path.join(repoRoot, 'public')));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  let browser;
  const qaDir = process.env.REPORT_QA_DIR ? path.resolve(process.env.REPORT_QA_DIR) : path.join(dataDir, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  try {
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: path.join(dataDir, 'browser-profile'), env: { ...process.env, HOME: dataDir, XDG_CONFIG_HOME: path.join(dataDir, 'config'), XDG_CACHE_HOME: path.join(dataDir, 'cache') }, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    for (const audience of ['teacher', 'management', 'school', 'status']) {
      await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
      await page.evaluate(async ({ audience, partialId, unavailableId, schoolId, testId }) => {
        const view = await import('/js/views/reports.js');
        const root = document.querySelector('#view');
        if (audience === 'school') await view.renderSchoolReport(root, schoolId, testId);
        else await view.renderTeacherReport(root, audience === 'status' ? unavailableId : partialId, testId, new URLSearchParams(audience === 'management' ? 'for=management' : ''));
      }, { audience, partialId: partial.teacherId, unavailableId: unavailable.teacherId, schoolId, testId });
      await page.waitForFunction(() => !document.querySelector('[data-evidence="loading"]') && [...document.images].every((img) => img.complete));
      const dom = await page.evaluate(() => ({ text: document.querySelector('.report-sheet').innerText, images: [...document.querySelectorAll('.evidence-page img')].map((img) => img.naturalWidth), captions: document.querySelectorAll('.report-sheet figcaption').length }));
      assert.doesNotMatch(dom.text, /PROCESS_SENTINEL|wrong-teacher|inferred rubric|Marked by|Report Date|pending review/i);
      assert.equal(dom.captions, 0);
      if (['teacher', 'management'].includes(audience)) {
        assert.match(dom.text, /— \/ 5/); assert.match(dom.text, /0 \/ 5/);
        assert.match(dom.text, /Final grade withheld/);
        assert.equal(dom.images.length, 2); assert.ok(dom.images.every((width) => width > 0));
      }
      if (audience === 'status') { assert.match(dom.text, /No assessment result is available/); assert.equal(dom.images.length, 0); }
      const pdfPath = path.join(qaDir, `bounded-${audience}.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4', preferCSSPageSize: true, printBackground: true });
      await page.screenshot({ path: path.join(qaDir, `bounded-${audience}.png`), fullPage: false });
      fs.writeFileSync(path.join(qaDir, `bounded-${audience}.html`), await page.content());
      const pdfText = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
      assert.match(pdfText, /Report Generated by UpSchool/);
      assert.match(pdfText, /Synthetic Coverage School/);
      assert.doesNotMatch(pdfText, /PROCESS_SENTINEL|pending review|inferred rubric|Report Date|SYNTHETIC_PROVIDER_FAILURE/i);
      if (['teacher', 'management'].includes(audience)) { assert.match(pdfText, /—\s*\/\s*5/); assert.match(pdfText, /0\s*\/\s*5/); assert.match(pdfText, /OpenAI tools/); }
    }
  } finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});
