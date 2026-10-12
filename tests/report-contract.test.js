import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Only synthetic fixtures, a disposable database, and local HTTP are used.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-report-contract-'));
process.env.DATA_DIR = dataDir;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const { GRADES, NEEDS, SECTION_TITLES, teacherResults, potentialFor, needOf } = await import('../server/results.js');
const { LAYOUT, reportContract, reportNarrative, teacherReportBasis, schoolBasis, schoolOverview, isStale, schoolReportIsStale, questionsOf, queueTeacherReports, queueSchoolReport } = await import('../server/reports.js');
const { fileName, reportArtifactNames, startZip } = await import('../server/bundle.js');
const { currentSourceBasis, digest } = await import('../server/provenance.js');
const { WRITING_VERSION, writingBasis } = await import('../server/writing.js');

const schoolId = Number(db.prepare('INSERT INTO schools (name) VALUES (?)').run('Synthetic Example School').lastInsertRowid);
const testId = Number(db.prepare('INSERT INTO tests (school_id, name) VALUES (?, ?)').run(schoolId, 'Synthetic Assessment').lastInsertRowid);
const teacherId = Number(db.prepare('INSERT INTO teachers (school_id, name, grade, subjects) VALUES (?, ?, ?, ?)').run(schoolId, 'Example Teacher', 'Grade 5', 'Science').lastInsertRowid);
const colleagueId = Number(db.prepare('INSERT INTO teachers (school_id, name, grade) VALUES (?, ?, ?)').run(schoolId, 'Second Teacher', 'Grade 5').lastInsertRowid);
const question = (section, n, max, awarded, answer) => ({
  section: `Section ${section}`, question: String(n), max_marks: max, marks_awarded: awarded,
  question_text: n === 1 ? 'How can OpenAI tools support a teacher?' : 'Describe a safe classroom routine.',
  teacher_answer: answer, expected_answer: 'Teachers should check accuracy and protect student information.',
  feedback: 'A clear example; add a check of the information.',
  criteria: [{ credit: 1, criterion: 'INTERNAL_CRITERION_SENTINEL', evidence: 'INTERNAL_EVIDENCE_SENTINEL', reason: 'INTERNAL_REASON_SENTINEL' }],
});
const questions = [question('A', 1, 5, 4, 'OpenAI tools can support practice. The teacher check facts. I would compare each suggestion with the textbook, remove personal information, and give pupils a clear example before asking them to explain the idea in their own words.'), question('A', 2, 5, 4, 'Use a clear routine.'), question('B', 1, 35, 28, 'A practical science example.')];
const rawWriting = {
  evidence_version: 1, version: WRITING_VERSION, basis: writingBasis(questions),
  sections: [{ section: 'Section A', judged: true, sentence_formation: 4, grammar: 3, spelling_punctuation: 4, vocabulary: 4, score: 7.5, summary: 'Check subject and verb agreement.' }],
  errors: [{ section: 'Section A', question: '1', type: 'Grammar', wrote: 'The teacher check facts.', problem: 'The singular subject needs a matching verb.', correction: 'The teacher checks facts.' }],
};
const result = { questions, marking: 'standard', writing: rawWriting, audit: { rubric_version: 'fixture-v1', model: 'synthetic-only', source_hash: 'fixture-source' } };
const insertAssessment = db.prepare("INSERT INTO assessments (school_id, teacher_id, test_id, title, status, ai_status, ai_result, ai_evaluated_at) VALUES (?, ?, ?, ?, 'evaluated', 'done', ?, '2026-10-12 00:00:00')");
const assessmentId = Number(insertAssessment.run(schoolId, teacherId, testId, 'Synthetic sitting', JSON.stringify(result)).lastInsertRowid);
insertAssessment.run(schoolId, colleagueId, testId, 'Second sitting', JSON.stringify({ questions: [question('A', 1, 10, 4, 'A short answer.')], marking: 'standard' }));
const scanPath = path.join(UPLOADS_DIR, 'synthetic-source.png');
// A generated 1x1 PNG is enough to exercise the source image appendix.
const scan = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB7sAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(scanPath, scan);
db.prepare('INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, position) VALUES (?, ?, ?, ?, ?, ?)').run(assessmentId, 'response', path.basename(scanPath), 'synthetic-source.png', 'image/png', 0);
const getSections = () => teacherResults(teacherId, testId);
const contentFor = (sections) => ({
  layout: LAYOUT, answers: true, writing: true, plain: true, test_name: 'Synthetic Assessment',
  sections: sections.map((s) => ({ ...s, questions: questionsOf(s) })), potential: potentialFor(sections), need: needOf(sections), training: null,
  teacher: { summary: 'Thank you for taking the assessment. You use practical examples and can make your explanations clearer.', went_well: [{ title: 'Practical examples', detail: 'You connect ideas to classroom activities.' }], next_steps: [{ title: 'Check understanding', detail: 'Ask pupils to explain the idea in their own words.' }], practice_ideas: ['Review one answer with a colleague.'] },
  management: { summary: 'The teacher uses practical examples and needs to check explanations.', findings: [{ title: 'Clear examples', summary: 'The classroom examples make the ideas easy to follow.' }], school_needs: ['Set aside time for practice.'], roles: [], support: ['Review explanations together.'] },
});
const reportFor = (sections = getSections()) => ({ kind: 'teacher', status: 'done', teacher_id: teacherId, test_id: testId, content: contentFor(sections), basis: teacherReportBasis(sections, { teacherId, testId }), written_at: '2026-10-12 00:00:00' });

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('report input changes invalidate caches even when marks and percentages are unchanged', () => {
  const original = getSections();
  const report = reportFor(original);
  assert.equal(isStale(report, original), false);
  for (const mutate of [
    (s) => { s[0].questions[0].teacher_answer += ' Added detail.'; },
    (s) => { s[0].questions[0].feedback = 'Revised professional feedback.'; },
    (s) => { s[0].questions[0].expected_answer = 'Revised expected guidance.'; },
    (s) => { s[0].writing.summary = 'Revised writing feedback.'; },
    (s) => { s[0].assessment_audit = { ...s[0].assessment_audit, rubric_version: 'fixture-v2' }; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.equal(isStale(report, changed), true);
  }
  fs.writeFileSync(scanPath, Buffer.concat([scan, Buffer.from('changed bytes')]));
  assert.equal(isStale(report, original), true);
  fs.writeFileSync(scanPath, scan);
  assert.equal(isStale(report, original), false);
  assert.equal(isStale({ ...report, basis: null }, original), true);
  assert.notEqual(reportContract('teacher'), reportContract('school'));
});

test('changing the configured report model invalidates the report contract', () => {
  const code = "import { reportContract } from './server/reports.js'; console.log(reportContract('teacher'));";
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repoRoot, env: { ...process.env, DATA_DIR: path.join(dataDir, 'alternate-model'), OPENAI_MODEL: 'synthetic-alternate-model', OPENAI_API_KEY: '' }, encoding: 'utf8' }).trim();
  assert.notEqual(output, reportContract('teacher'));
});

test('master metadata and absent source files invalidate reports, and stale marking cannot be re-reported', () => {
  const baseline = teacherReportBasis(getSections(), { teacherId, testId });
  db.exec('SAVEPOINT report_source_contract');
  try {
    const paperId = Number(db.prepare('INSERT INTO papers (title, sections, subject, stored_name, original_name) VALUES (?, ?, ?, ?, ?)').run('Synthetic master', 'B', 'Science', 'synthetic-master.pdf', 'synthetic-master.pdf').lastInsertRowid);
    fs.writeFileSync(path.join(UPLOADS_DIR, 'synthetic-master.pdf'), '%PDF-synthetic-hash-only');
    db.prepare('INSERT INTO assessment_papers (assessment_id, paper_id) VALUES (?, ?)').run(assessmentId, paperId);
    const withMaster = teacherReportBasis(getSections(), { teacherId, testId });
    assert.notEqual(withMaster, baseline);
    db.prepare('UPDATE papers SET total_marks = 35, notes = ? WHERE id = ?').run('Revised administered master metadata', paperId);
    assert.notEqual(teacherReportBasis(getSections(), { teacherId, testId }), withMaster);
    const audited = { ...result, audit: { ...result.audit, source_digest: digest(currentSourceBasis(assessmentId)) } };
    db.prepare('UPDATE assessments SET ai_result = ? WHERE id = ?').run(JSON.stringify(audited), assessmentId);
    assert.equal(getSections().some((section) => section.evaluation_stale), false);
    fs.rmSync(path.join(UPLOADS_DIR, 'synthetic-master.pdf'));
    assert.equal(getSections().some((section) => section.evaluation_stale), true);
    assert.match(queueTeacherReports(teacherId, testId), /Re-evaluate/);
    assert.match(queueSchoolReport(schoolId, testId), /Re-evaluate/);
    assert.match(startZip(schoolId, testId), /Re-evaluate/);
  } finally { db.exec('ROLLBACK TO report_source_contract; RELEASE report_source_contract'); }
});

test('school figures use section denominators and a full narrative dependency basis', () => {
  const overview = schoolOverview(schoolId, testId);
  const a = overview.section_stats.find((s) => s.key === 'A');
  const b = overview.section_stats.find((s) => s.key === 'B');
  assert.deepEqual([a.sat, a.papers, a.average], [2, 2, 60]);
  assert.deepEqual([b.sat, b.papers, b.average], [1, 1, 80]);
  assert.equal(Object.values(a.counts).reduce((x, y) => x + y, 0), a.papers);
  assert.equal(overview.whole.sat.B, 1);
  assert.equal(overview.whole.averages.B, 80);
  assert.equal(getSections().find((s) => s.key === 'B').max, 35);
  const report = { content: { layout: LAYOUT }, basis: schoolBasis(overview) };
  assert.equal(schoolReportIsStale(report, overview), false);
  const changed = structuredClone(overview);
  changed.teachers[0].input_basis = 'updated-answer-same-score';
  assert.equal(schoolReportIsStale(report, changed), true);
  changed.teachers[0].input_basis = overview.teachers[0].input_basis;
  changed.context.framework = { version: 'new-training-path' };
  assert.equal(schoolReportIsStale(report, changed), true);
});

test('school averages retain the same percentage precision as section results', () => {
  db.exec('SAVEPOINT report_aggregate_contract');
  try {
    db.prepare('UPDATE assessments SET ai_result = ? WHERE id = ?').run(JSON.stringify({ questions: [question('A', 1, 13, 11, 'An example answer.')] }), assessmentId);
    const section = getSections()[0];
    assert.equal(section.percent, 84.62);
    assert.equal(section.grade, 'B');
    const overview = schoolOverview(schoolId, testId);
    assert.equal(overview.section_stats[0].average, 62.31);
    assert.equal(overview.whole.averages.A, 62.31);
    assert.equal(overview.stage_stats[0].averages.A, 62.31);
  } finally { db.exec('ROLLBACK TO report_aggregate_contract; RELEASE report_aggregate_contract'); }
});

test('narrative cleanup preserves academic AI content and question evidence', () => {
  assert.equal(reportNarrative('This report was generated by OpenAI. The teacher uses clear examples.'), 'The teacher uses clear examples.');
  assert.equal(reportNarrative('As an AI assistant, I prepared this report. Review subject and verb agreement.'), 'Review subject and verb agreement.');
  assert.equal(reportNarrative('The teacher explained OpenAI tools and their limitations.'), 'The teacher explained OpenAI tools and their limitations.');
  assert.equal(reportNarrative('The score is 7.5 out of 10.'), 'The score is 7.5 out of 10.');
  for (const academic of [
    'The teacher explains, ‘I used OpenAI to prepare a lesson and checked the facts.’ This is a relevant example.',
    'The response correctly says that a computer assistant generated the report requested by the head teacher.',
    'The teacher quoted “as an AI assistant” while describing a chatbot.',
    '“As an AI assistant, I prepared this report.” This is a quotation from the answer.',
    'The teacher quoted “Chatbots can make mistakes. As an AI assistant, I prepared this report.” The example was discussed accurately.',
    'The teacher wrote, \'I used OpenAI to prepare a lesson. As an AI assistant, I prepared this report.\' This is an example from the answer.',
    'The report was generated by a computer assistant for a classroom exercise.',
    'I used OpenAI to prepare a lesson and checked the facts.',
  ]) assert.equal(reportNarrative(academic), academic);
  assert.equal(reportNarrative('I used OpenAI to prepare this report. The teacher gives clear examples.'), 'The teacher gives clear examples.');
  assert.equal(reportNarrative('This report was generated by OpenAI. The teacher quoted “as an AI assistant.” Review the example.'), 'The teacher quoted “as an AI assistant.” Review the example.');
  const q = questionsOf({ questions, marking: 'standard' })[0];
  assert.match(q.question_text, /OpenAI/);
  assert.match(q.teacher_answer, /OpenAI/);
  assert.equal(q.marks_awarded, 4);
  assert.equal(q.max_marks, 5);
  assert.equal('criteria' in q, false);
  assert.ok(q.feedback && q.expected_answer);
});

test('artifact filenames are safe and independent of input order and audience failures', () => {
  const teachers = [{ id: 3, name: 'Alex' }, { id: 2, name: 'alex' }, { id: 1, name: 'Alex (2)' }];
  assert.deepEqual([...reportArtifactNames(teachers)], [...reportArtifactNames([...teachers].reverse())]);
  const names = [...reportArtifactNames(teachers).values()];
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3);
  assert.equal(fileName('../A: B?'), '.. A B');
  assert.equal(fileName('CON.txt'), '_CON.txt');
  assert.equal(fileName(' '), 'Unnamed');
  assert.ok(fileName('a'.repeat(300)).length <= 120);
});

test('ZIP export refuses outdated reports instead of packaging old marks', () => {
  const sections = getSections();
  const report = reportFor(sections);
  db.prepare("INSERT INTO reports (kind, school_id, teacher_id, test_id, status, content, basis) VALUES ('teacher', ?, ?, ?, 'done', ?, ?)").run(schoolId, teacherId, testId, JSON.stringify(report.content), report.basis);
  fs.writeFileSync(scanPath, Buffer.concat([scan, Buffer.from('modified')]));
  assert.match(startZip(schoolId, testId), /out of date.*Rebuild/i);
  fs.writeFileSync(scanPath, scan);
});

test('all report audiences preserve the final structural contract and source appendix', async () => {
  const { ReportNode, installReportDom } = await import('./report-dom-helper.js');
  const sections = getSections();
  const overview = schoolOverview(schoolId, testId);
  const common = { school: { id: schoolId, name: 'Synthetic Example School' }, test: { id: testId, name: 'Synthetic Assessment' }, grades: GRADES, needs: NEEDS, section_titles: SECTION_TITLES };
  const teacherPayload = { ...common, teacher: { id: teacherId, school_id: schoolId, name: 'Example Teacher', grade: 'Grade 5', subjects: 'Science' }, sections, report: reportFor(sections), potential: potentialFor(sections), training: { set: false }, evidence: [{ assessment_id: assessmentId, date: '2026-10-12', papers: [], question_paper: [{ url: '/uploads/synthetic-source.png', type: 'image/png' }], response: [{ url: '/uploads/synthetic-source.png', type: 'image/png' }] }] };
  const schoolPayload = { ...common, ...overview, training: null, training_state: { set: false }, report: { status: 'done', written_at: '2026-10-12 00:00:00', content: { ...overview, layout: LAYOUT, summary: 'Two teachers were assessed. Support needs differ by section.', findings: [], actions: [], school_needs: [], training: null, written_expression: null } } };
  const restore = installReportDom({ teacher: teacherPayload, school: schoolPayload });
  try {
    const { renderTeacherReport, renderSchoolReport } = await import('../public/js/views/reports.js');
    for (const audience of ['teacher', 'management', 'school']) {
      const root = new ReportNode('main');
      if (audience === 'school') await renderSchoolReport(root, schoolId, testId);
      else await renderTeacherReport(root, teacherId, testId, new URLSearchParams(audience === 'management' ? 'for=management' : ''));
      await Promise.all(root.querySelectorAll('.report-evidence').map((node) => node.ready));
      const sheet = root.querySelector('.report-sheet');
      assert.ok(sheet);
      assert.match(sheet.textContent, /Synthetic Example School/);
      assert.match(sheet.textContent, /70% to below 85%/);
      assert.match(sheet.textContent, /50% to below 70%/);
      assert.equal(sheet.querySelector('.report-footer').textContent, 'Report Generated by UpSchool');
      assert.equal(sheet.querySelector('.report-footer').querySelector('img').getAttribute('src'), '/img/upschool-logo.png');
      assert.ok(!sheet.querySelectorAll('th').some((th) => /^(?:Credit|Criterion|Evidence|Reason)$/i.test(th.textContent.trim())));
      assert.doesNotMatch(sheet.textContent, /INTERNAL_\w+_SENTINEL|How to Read These Results|(?:report was generated by|AI assistant)/i);
      if (audience !== 'school') {
        assert.match(sheet.textContent, /OpenAI tools/);
        assert.match(sheet.textContent, /What Should Have Been Answered/);
        assert.match(sheet.textContent, /Feedback: A clear example/);
        assert.match(sheet.textContent, /The teacher checks facts/);
        assert.match(sheet.textContent, /Good 7 to below 8.5/);
        assert.match(sheet.textContent, /Fair 5 to below 7/);
        assert.match(sheet.textContent, /28\s*\/\s*35/);
        const appendix = sheet.querySelector('.report-evidence');
        assert.equal(appendix.querySelectorAll('.evidence-page').length, 2);
        assert.equal(appendix.querySelectorAll('.evidence-missing').length, 0);
      }
      if (process.env.REPORT_QA_DIR) {
        fs.mkdirSync(process.env.REPORT_QA_DIR, { recursive: true });
        const logo = `data:image/png;base64,${fs.readFileSync(path.join(repoRoot, 'public/img/upschool-logo.png')).toString('base64')}`;
        const html = sheet.outerHTML.replaceAll('/img/upschool-logo.png', logo).replace(/blob:[^\"]+/g, `data:image/png;base64,${scan.toString('base64')}`);
        fs.writeFileSync(path.join(process.env.REPORT_QA_DIR, `${audience}-structure.html`), `<!doctype html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(repoRoot, 'public/css/styles.css'), 'utf8')}</style></head><body>${html}</body></html>`);
      }
    }
    teacherPayload.sections[0].evaluation_stale = true;
    const blocked = new ReportNode('main');
    await renderTeacherReport(blocked, teacherId, testId);
    assert.equal(blocked.querySelector('.report-sheet'), null);
    assert.match(blocked.textContent, /Re-evaluate this sitting/);
  } finally { restore(); }
});

const chromium = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-headless-shell'].find((p) => fs.existsSync(p));
test('synthetic teacher, management and school HTML/PDF keep the final report contract', { skip: process.env.REPORT_PDF_QA !== '1' ? 'Set REPORT_PDF_QA=1 in an environment that permits Chromium sockets.' : !chromium, timeout: 60_000 }, async () => {
  const { default: express } = await import('express');
  const { default: puppeteer } = await import('puppeteer-core');
  const sections = getSections();
  const report = reportFor(sections);
  const overview = schoolOverview(schoolId, testId);
  const common = { school: { id: schoolId, name: 'Synthetic Example School' }, test: { id: testId, name: 'Synthetic Assessment' }, grades: GRADES, needs: NEEDS, section_titles: SECTION_TITLES };
  const payload = { ...common, teacher: { id: teacherId, school_id: schoolId, name: 'Example Teacher', grade: 'Grade 5', subjects: 'Science' }, sections, report, potential: potentialFor(sections), training: { set: false }, evidence: [{ assessment_id: assessmentId, date: '2026-10-12', papers: [], question_paper: [{ url: '/uploads/synthetic-source.png', type: 'image/png' }], response: [{ url: '/uploads/synthetic-source.png', type: 'image/png' }] }] };
  const schoolPayload = { ...common, ...overview, training: null, training_state: { set: false }, report: { status: 'done', written_at: '2026-10-12 00:00:00', content: { ...overview, layout: LAYOUT, summary: 'Two teachers were assessed. Support needs differ by section.', findings: [], actions: [], school_needs: [], training: null, written_expression: null } } };
  const app = express();
  app.get('/fixture', (_req, res) => res.send('<html><head><link rel="stylesheet" href="/css/styles.css"></head><body><main id="view"></main><div id="toasts"></div></body></html>'));
  app.get('/api/reports/teacher', (_req, res) => res.json(payload));
  app.get('/api/reports/school', (_req, res) => res.json(schoolPayload));
  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use(express.static(path.join(repoRoot, 'public')));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try { browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: path.join(dataDir, 'browser-profile'), env: { ...process.env, HOME: dataDir, XDG_CONFIG_HOME: path.join(dataDir, 'config'), XDG_CACHE_HOME: path.join(dataDir, 'cache') }, args: ['--no-sandbox', '--disable-gpu'] }); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  const qaDir = process.env.REPORT_QA_DIR ? path.resolve(process.env.REPORT_QA_DIR) : path.join(dataDir, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    for (const audience of ['teacher', 'management', 'school']) {
      await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
      await page.evaluate(async ({ audience, teacherId, schoolId, testId }) => {
        const view = await import('/js/views/reports.js');
        const root = document.querySelector('#view');
        if (audience === 'school') await view.renderSchoolReport(root, schoolId, testId);
        else await view.renderTeacherReport(root, teacherId, testId, new URLSearchParams(audience === 'management' ? 'for=management' : ''));
      }, { audience, teacherId, schoolId, testId });
      await page.waitForFunction(() => !document.querySelector('[data-evidence="loading"]') && [...document.images].every((img) => img.complete));
      const dom = await page.evaluate(() => ({
        text: document.querySelector('.report-sheet').innerText,
        footer: document.querySelector('.report-footer').textContent,
        logo: document.querySelector('.report-footer img').getAttribute('src'),
        headings: [...document.querySelectorAll('.report-sheet th')].map((th) => th.textContent.trim()),
        images: [...document.querySelectorAll('.evidence-page img')].map((img) => ({ alt: img.alt, width: img.naturalWidth })),
        missing: document.querySelectorAll('.evidence-missing').length,
      }));
      assert.match(dom.text, /Synthetic Example School/);
      assert.equal(dom.footer, 'Report Generated by UpSchool');
      assert.equal(dom.logo, '/img/upschool-logo.png');
      assert.ok(!dom.headings.some((h) => /^(?:Credit|Criterion|Evidence|Reason)$/i.test(h)));
      assert.doesNotMatch(dom.text, /INTERNAL_\w+_SENTINEL|How to Read These Results|(?:report was generated by|AI assistant)/i);
      if (audience !== 'school') {
        assert.match(dom.text, /OpenAI tools/);
        assert.match(dom.text, /What Should Have Been Answered/);
        assert.match(dom.text, /Feedback: A clear example/);
        assert.match(dom.text, /The teacher checks facts/);
        assert.match(dom.text, /28\s*\/\s*35/);
        assert.equal(dom.images.length, 2);
        assert.equal(dom.missing, 0);
        assert.ok(dom.images.every((image) => image.width > 0));
      }
      const pdfPath = path.join(qaDir, `${audience}.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4', preferCSSPageSize: true, printBackground: true });
      await page.screenshot({ path: path.join(qaDir, `${audience}.png`), fullPage: false });
      fs.writeFileSync(path.join(qaDir, `${audience}.html`), await page.content());
      const pdfText = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
      assert.match(pdfText, /Report Generated by UpSchool/);
      assert.match(pdfText, /Synthetic Example School/);
      assert.doesNotMatch(pdfText, /How to Read These Results|INTERNAL_\w+_SENTINEL/);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
