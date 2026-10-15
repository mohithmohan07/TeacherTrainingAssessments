import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankComparisonEvidence, contentMatchEvidence, identityReviewEvidence, MATCH_EVIDENCE_LIMITS, questionMatchEvidence, questionMatchEvidenceDrawer, sourceMetadataEvidence } from '../public/js/matching-evidence.js';
import { installReportDom } from './report-dom-helper.js';

// Synthetic evidence only. No provider, database, credentials or production
// source is involved; even the optional browser test serves only local files.
const sourcePage = (extra = {}) => ({ position: 15, match: {
  paper_id: 7,
  source_heading: 'Knowledge, pedagogy, classroom management & child psychology',
  header_evidence: { status: 'descriptive', reason: 'The heading describes the matched question content.' },
  confidence: 'high', reason: 'The classroom scenario corresponds to question 5A.',
  questions: ['5A', '5B'], issues: [], matched_question_labels: ['5A', '5B'], alternatives: [], summary_count: 1,
  ...extra,
} });
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const contentMatch = (extra = {}) => ({
  status: 'complete',
  coverage: { complete: true, candidate_count: 3, completed_candidate_ids: [7, 8, 11], batch_count: 1, final_compared: true, finalist_ids: [7, 8], phase: 'final_comparison' },
  sections: [{ section: 'B', paper_id: 7, confidence: 'low', reason: 'Two supplied masters share these question labels.', matched_question_labels: ['5A'], alternatives: [8], page_ids: [101] }],
  ...extra,
});

test('question match projection shows actual stored evidence without mutating it', () => {
  const page = deepFreeze(sourcePage());
  const before = JSON.stringify(page);
  const view = questionMatchEvidence(page);
  assert.equal(view.page, 15);
  assert.equal(view.available, true);
  assert.equal(view.proposedMaster, '7');
  assert.equal(view.headerStatus, 'descriptive');
  assert.equal(view.headerReason, page.match.header_evidence.reason);
  assert.equal(view.confidence, 'high');
  assert.equal(view.reason, page.match.reason);
  assert.deepEqual(view.questions.values, ['5A', '5B']);
  assert.deepEqual(view.matchedQuestionLabels.values, ['5A', '5B']);
  assert.deepEqual(view.alternatives.values, []);
  assert.equal(view.summaryCount, 1);
  assert.equal(JSON.stringify(page), before);
});

test('legacy, missing, malformed and explicit empty evidence remain distinct', () => {
  for (const page of [undefined, null, {}, { match: [] }, { match: 'bad' }]) assert.equal(questionMatchEvidence(page).available, false);
  const view = questionMatchEvidence({ position: '<img>', match: {} });
  assert.equal(view.page, null);
  for (const key of ['proposedMaster', 'sourceHeading', 'headerStatus', 'headerReason', 'confidence', 'reason']) assert.equal(view[key], 'Not recorded');
  assert.equal(view.summaryCount, null);
  assert.equal(view.alternatives.available, false);
  assert.equal(questionMatchEvidence(sourcePage({ paper_id: null })).proposedMaster, 'None proposed');
  assert.equal(questionMatchEvidence(sourcePage({ paper_id: 0 })).proposedMaster, 'None proposed');
  assert.equal(questionMatchEvidence(sourcePage({ paper_id: '7' })).proposedMaster, 'Not recorded');
  assert.equal(questionMatchEvidence(sourcePage({ source_heading: '' })).sourceHeading, '(blank)');
  assert.equal(questionMatchEvidence({ match: { source_page: 3 } }).page, 3);
  const malformed = questionMatchEvidence(sourcePage({ summary_count: -1, alternatives: ['7', 0, -1, {}, 8], confidence: 'guaranteed', header_evidence: [] }));
  assert.equal(malformed.summaryCount, null);
  assert.equal(malformed.confidence, 'Not recorded');
  assert.equal(malformed.headerStatus, 'Not recorded');
  assert.deepEqual(malformed.alternatives.values, [8]);
  assert.equal(malformed.alternatives.invalid, 4);
});

test('summary cardinality and alternatives report conflicts rather than implying a selected master', () => {
  const view = questionMatchEvidence(sourcePage({ summary_count: 2, alternatives: [8, 11], confidence: 'low', issues: ['Two paper summaries disagree.'] }));
  assert.equal(view.summaryCount, 2);
  assert.deepEqual(view.alternatives.values, [8, 11]);
  assert.equal(view.issues.values[0], 'Two paper summaries disagree.');
  assert.equal(questionMatchEvidence(sourcePage({ summary_count: 0 })).summaryCount, 0);
});

test('bank projection requires explicit stored status and counts; finalists do not imply completeness', () => {
  assert.equal(bankComparisonEvidence().available, false);
  const partial = bankComparisonEvidence({ finalist_ids: [7], complete: 'yes', batch_count: -1, final_compared: 'true' });
  assert.equal(partial.complete, null);
  assert.equal(partial.finalCompared, null);
  assert.equal(partial.batchCount, null);
  assert.equal(partial.candidateCount, null);
  const bank = bankComparisonEvidence({ complete: true, candidate_count: 17, batch_count: 3, finalist_ids: [7, 17], final_compared: false });
  assert.equal(bank.complete, true);
  assert.equal(bank.finalCompared, false);
  assert.equal(bank.candidateCount, 17);
  assert.equal(bank.batchCount, 3);
  assert.deepEqual(bank.finalistIds.values, [7, 17]);
});

test('indexed all-bank consideration stays distinct from full-PDF screening and finalist verification', () => {
  const coverage = deepFreeze({ coverage_mode: 'content_first', complete: true, candidate_count: 4,
    text_screened_ids: [7, 8, 9, 7], full_pdf_screened_ids: [11], full_pdf_verified_ids: [7, 8],
    ambiguous_equivalent_ids: [7, 8], finalist_ids: [7, 8], final_compared: true, phase: 'indexing' });
  const bank = bankComparisonEvidence(coverage);
  assert.equal(bank.completedCandidates, 4);
  assert.equal(bank.textScreenedCandidates, 3);
  assert.equal(bank.pdfScreenedCandidates, 1);
  assert.deepEqual(bank.fullPdfVerifiedIds.values, [7, 8]);
  assert.deepEqual(bank.ambiguousEquivalentIds.values, [7, 8]);
  assert.equal(bank.phase, 'indexing');
  const restore = installReportDom({});
  try {
    const drawer = questionMatchEvidenceDrawer([], coverage);
    assert.match(drawer.textContent, /All-bank coverage: 4 of 4 candidate papers considered/);
    assert.match(drawer.textContent, /Papers screened using complete text: 3. Papers screened as full PDFs: 1/);
    assert.match(drawer.textContent, /Text screening is not full-PDF inspection/);
    assert.match(drawer.textContent, /Full-PDF verified finalist master IDs:78/);
    assert.match(drawer.textContent, /Content-equivalent master IDs \(ambiguity retained\):78/);
    assert.doesNotMatch(drawer.textContent, /All-bank[^.]*PDF/);
  } finally { restore(); }
  assert.equal(bankComparisonEvidence({ ...coverage, coverage_mode: 'unknown', completed_candidate_ids: undefined }).completedCandidates, null);
  assert.equal(bankComparisonEvidence({ ...coverage, full_pdf_screened_ids: undefined }).completedCandidates, null);
  assert.equal(bankComparisonEvidence({ ...coverage, completed_candidate_ids: [7] }).completedCandidates, 1);
});

test('diagnostics explicitly allowlist fields and reject nested values in visible fields', () => {
  const secret = { provider_prompt: 'PRIVATE PROMPT', api_key: 'PRIVATE KEY', answer_text: 'PRIVATE ANSWER', image_url: 'PRIVATE IMAGE', result: { nested: 'PRIVATE NESTED' } };
  const page = sourcePage({ ...secret, questions: [{ text: 'PRIVATE QUESTION' }], issues: [{ reason: 'PRIVATE ISSUE' }], header_evidence: { status: 'conflict', reason: 'Known conflict', ...secret } });
  const result = JSON.stringify([questionMatchEvidence({ ...page, ...secret }), bankComparisonEvidence({ complete: true, ...secret })]);
  for (const value of ['PRIVATE PROMPT', 'PRIVATE KEY', 'PRIVATE ANSWER', 'PRIVATE IMAGE', 'PRIVATE NESTED', 'PRIVATE QUESTION', 'PRIVATE ISSUE']) assert.ok(!result.includes(value), value);
  assert.equal(questionMatchEvidence(page).questions.invalid, 1);
  assert.equal(questionMatchEvidence(page).issues.invalid, 1);
  for (const filename of ['server/reports.js', 'server/report-html.js', 'public/js/views/reports.js'].filter(file => fs.existsSync(file))) assert.ok(!fs.readFileSync(filename, 'utf8').includes('matching-evidence'));
  const bulk = fs.readFileSync('public/js/views/bulk.js', 'utf8');
  assert.match(bulk, /questionMatchEvidenceDrawer\(item\.pages, item\.bank_comparison, \{ content_match: item\.content_match, identity_review: item\.identity_review \}\)/);
});

test('content completion and identity review are projected independently without confirming a match', () => {
  const content = deepFreeze(contentMatch());
  const before = JSON.stringify(content);
  const view = contentMatchEvidence(content);
  assert.equal(view.status, 'Complete');
  assert.equal(view.coverage.complete, true);
  assert.equal(view.coverage.completedCandidates, 3);
  assert.equal(view.sections.values[0].proposedMaster, '7');
  assert.equal(view.sections.values[0].confidence, 'low');
  assert.deepEqual(view.sections.values[0].alternatives.values, [8]);
  assert.deepEqual(view.sections.values[0].pageIds.values, [101]);
  assert.deepEqual(view.sections.values[0].matchedQuestionLabels.values, ['5A']);
  assert.equal(identityReviewEvidence({ status: 'needs_review', problems: ['The written name is unresolved.'] }).status, 'Needs review');
  assert.equal(identityReviewEvidence({ status: 'verified', problems: [] }).status, 'Verified');
  assert.equal(JSON.stringify(content), before);
});

test('missing, unknown and malformed new statuses never infer completion or verification', () => {
  for (const value of [undefined, null, [], 'complete']) {
    assert.equal(contentMatchEvidence(value).available, false);
    assert.equal(identityReviewEvidence(value).available, false);
  }
  assert.equal(contentMatchEvidence({ status: 'accepted', coverage: { complete: true } }).status, 'Not recorded');
  assert.equal(identityReviewEvidence({ status: 'complete', problems: [] }).status, 'Not recorded');
  assert.equal(contentMatchEvidence({ status: 'running' }).status, 'Running');
  assert.equal(contentMatchEvidence({ status: 'failed' }).status, 'Failed');
  assert.equal(contentMatchEvidence({ status: 'not_started' }).status, 'Not started');
  const malformed = contentMatchEvidence({ sections: [null, [], { section: {}, paper_id: '7', confidence: 'certain', page_ids: ['101'] }] });
  assert.equal(malformed.sections.invalid, 2);
  assert.equal(malformed.sections.values[0].section, 'Not recorded');
  assert.equal(malformed.sections.values[0].proposedMaster, 'Not recorded');
  assert.equal(malformed.sections.values[0].confidence, 'Not recorded');
  assert.equal(malformed.sections.values[0].pageIds.invalid, 1);
  assert.equal(contentMatchEvidence(contentMatch({ sections: [{ paper_id: null }] })).sections.values[0].proposedMaster, 'None proposed');
});

test('source metadata preserves recorded, observed and earlier values without accepting nested payloads', () => {
  const page = deepFreeze({ position: 15, source_file: 'Original scan.pdf', identity: {
    name_written: 'Synthetic Teacher', grade_written: '', field_observations: { grade_written: 'Class 6' },
    context_verification: { original_fields: { grade_written: { value: 'Class 7', provider_prompt: 'PRIVATE PROMPT' } } },
    provider_prompt: 'PRIVATE PROMPT', answer_text: 'PRIVATE ANSWER', api_key: 'PRIVATE KEY',
  } });
  const before = JSON.stringify(page);
  const view = sourceMetadataEvidence(page);
  assert.equal(view.page, 15);
  assert.equal(view.sourceFile, 'Original scan.pdf');
  assert.deepEqual(view.fields[1], { label: 'Class', recorded: '(blank)', observed: 'Class 6', original: 'Class 7' });
  assert.equal(sourceMetadataEvidence({ identity: [] }).available, false);
  assert.equal(sourceMetadataEvidence({ identity: { name_written: { text: 'PRIVATE NESTED' } } }).fields[0].recorded, 'Not recorded');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE/);
  assert.equal(JSON.stringify(page), before);
});

test('content and identity diagnostics are allowlisted and bounded', () => {
  const secret = { provider_prompt: 'PRIVATE PROMPT', api_key: 'PRIVATE KEY', answer_text: 'PRIVATE ANSWER', nested: { text: 'PRIVATE NESTED' } };
  const content = contentMatchEvidence(contentMatch({ ...secret, error: 'e'.repeat(10000), sections: Array.from({ length: 10000 }, () => ({ ...secret, section: 's'.repeat(10000), paper_id: null, reason: 'r'.repeat(10000), alternatives: [8, '9'], page_ids: [101, {}], matched_question_labels: [{ text: 'PRIVATE QUESTION' }] })) }));
  const identity = identityReviewEvidence({ ...secret, status: 'needs_review', problems: ['p'.repeat(10000), { reason: 'PRIVATE ISSUE' }] });
  assert.equal(content.sections.values.length, MATCH_EVIDENCE_LIMITS.sections);
  assert.equal(content.sections.omitted, 10000 - MATCH_EVIDENCE_LIMITS.sections);
  assert.equal(content.sections.values[0].section.length, MATCH_EVIDENCE_LIMITS.label + '… [truncated]'.length);
  assert.equal(content.error.length, MATCH_EVIDENCE_LIMITS.text + '… [truncated]'.length);
  assert.equal(identity.problems.invalid, 1);
  assert.equal(identity.problems.values[0].length, MATCH_EVIDENCE_LIMITS.text + '… [truncated]'.length);
  assert.doesNotMatch(JSON.stringify([content, identity]), /PRIVATE/);
});

test('drawer distinctly displays completed content with unresolved identity, alternatives and retained metadata', () => {
  const restore = installReportDom({});
  try {
    const pages = deepFreeze([{ ...sourcePage(), source_file: 'Original scan.pdf', identity: { name_written: 'Uncertain Name', grade_written: '', field_observations: { grade_written: 'Class 6' }, context_verification: { original_fields: { grade_written: { value: 'Class 7' } } } } }]);
    const options = deepFreeze({ content_match: contentMatch(), identity_review: { status: 'needs_review', problems: ['The written name is unresolved.'] } });
    const before = JSON.stringify([pages, options]);
    const drawer = questionMatchEvidenceDrawer(pages, null, options);
    assert.match(drawer.querySelector('summary').textContent, /Content Match: Complete · Identity Review: Needs review/);
    const [content, identity] = drawer.querySelectorAll('section');
    assert.equal(content.getAttribute('data-content-match'), '');
    assert.match(content.textContent, /All-bank coverage: 3 of 3 candidate papers/);
    assert.match(content.textContent, /Section B: proposed master 7/);
    assert.match(content.textContent, /Alternative master IDs:8/);
    assert.doesNotMatch(content.textContent, /Content section findings: None recorded/);
    assert.match(content.textContent, /does not mean every section has a unique master/);
    assert.equal(identity.getAttribute('data-identity-review'), '');
    assert.match(identity.textContent, /The written name is unresolved/);
    assert.match(identity.textContent, /does not clear identity conflicts or authorize filing/);
    assert.match(identity.textContent, /original file: Original scan.pdf/);
    assert.match(identity.textContent, /Class: recorded \(blank\); observed Class 6; before independent check Class 7/);
    assert.equal(JSON.stringify([pages, options]), before);
  } finally { restore(); }
});

test('running, failed, not-started and partial coverage remain explicit without forced masters', () => {
  const restore = installReportDom({});
  try {
    for (const [status, label] of [['running', 'Running'], ['failed', 'Failed'], ['not_started', 'Not started']]) {
      const drawer = questionMatchEvidenceDrawer([], null, { content_match: contentMatch({ status, error: status === 'failed' ? 'Comparison interrupted.' : undefined, coverage: { complete: false, candidate_count: 3, completed_candidate_ids: [7] }, sections: [{ section: 'B', paper_id: null, alternatives: [7, 8] }] }), identity_review: { status: 'verified', problems: [] } });
      assert.ok(drawer.textContent.includes(`Content Match: ${label}`));
      assert.match(drawer.textContent, /Identity Review: Verified/);
      assert.match(drawer.textContent, /All-bank coverage: 1 of 3/);
      assert.match(drawer.textContent, /proposed master None proposed/);
      assert.match(drawer.textContent, /cannot confirm a new match/);
      if (status === 'failed') assert.match(drawer.textContent, /Content matching error: Comparison interrupted/);
    }
    const unknown = questionMatchEvidenceDrawer([], null, { content_match: contentMatch({ status: 'future_status' }) });
    assert.match(unknown.textContent, /Content Match: Not recorded/);
    assert.match(unknown.textContent, /Identity Review: Not recorded/);
  } finally { restore(); }
});

test('new status sections safely escape every text field, make no requests, and display truncation', () => {
  const restore = installReportDom({});
  try {
    globalThis.fetch = () => { throw new Error('Read-only diagnostics must make no requests'); };
    const injected = '<img src="/private-image" onerror="alert(1)"><script>alert(2)</script>';
    const drawer = questionMatchEvidenceDrawer([{ position: 1, source_file: injected, identity: { name_written: injected, field_observations: { grade_written: injected }, context_verification: { original_fields: { grade_written: { value: injected } } } } }], null, {
      content_match: contentMatch({ error: injected, sections: Array.from({ length: MATCH_EVIDENCE_LIMITS.sections + 2 }, () => ({ section: injected, reason: injected, matched_question_labels: [injected] })) }),
      identity_review: { status: 'needs_review', problems: [injected] },
    });
    assert.match(drawer.outerHTML, /&lt;img/);
    assert.match(drawer.textContent, /2 more recorded entries not displayed \(display limit\)/);
    for (const tag of ['img', 'script', 'iframe', 'a', 'button', 'input', 'form']) assert.equal(drawer.querySelectorAll(tag).length, 0);
    const source = fs.readFileSync('public/js/matching-evidence.js', 'utf8');
    assert.doesNotMatch(source, /innerHTML|\bhtml\s*:|\bfetch\s*\(/);
  } finally { restore(); }
});

test('strings and lists are bounded with explicit truncation notices', () => {
  const view = questionMatchEvidence(sourcePage({
    reason: 'x'.repeat(10000), source_heading: 'h'.repeat(10000),
    questions: Array.from({ length: 10000 }, () => 'q'.repeat(10000)),
    issues: Array.from({ length: 10000 }, () => 'i'.repeat(10000)),
    alternatives: Array.from({ length: 10000 }, (_, index) => index + 1),
  }));
  assert.equal(view.reason.length, MATCH_EVIDENCE_LIMITS.text + '… [truncated]'.length);
  assert.equal(view.sourceHeading.length, MATCH_EVIDENCE_LIMITS.heading + '… [truncated]'.length);
  assert.equal(view.questions.values.length, MATCH_EVIDENCE_LIMITS.labels);
  assert.equal(view.questions.values[0].length, MATCH_EVIDENCE_LIMITS.label + '… [truncated]'.length);
  assert.equal(view.questions.omitted, 10000 - MATCH_EVIDENCE_LIMITS.labels);
  assert.equal(view.issues.values.length, MATCH_EVIDENCE_LIMITS.issues);
  assert.equal(view.alternatives.values.length, MATCH_EVIDENCE_LIMITS.ids);
  assert.equal(questionMatchEvidence(sourcePage({ reason: 'Before\u0000\u0007After' })).reason, 'BeforeAfter');
});

test('drawer uses text nodes, exposes explicit unknowns, caps pages, and makes no requests', () => {
  const restore = installReportDom({});
  try {
    globalThis.fetch = () => { throw new Error('Read-only diagnostics must make no requests'); };
    const injected = '<img src="/private-image" onerror="alert(1)"><script>alert(2)</script>';
    const pages = deepFreeze([sourcePage({ source_heading: injected, reason: injected, questions: [injected], issues: [injected] }), { position: 16 }, { position: 17, match: {} }]);
    const before = JSON.stringify(pages);
    const drawer = questionMatchEvidenceDrawer(pages);
    assert.match(drawer.textContent, /Question match evidence/);
    assert.match(drawer.textContent, /Proposed master ID: 7/);
    assert.match(drawer.textContent, /Header status: descriptive/);
    assert.match(drawer.textContent, /No stored question match evidence for this page/);
    assert.match(drawer.textContent, /Alternative master IDs: Not recorded/);
    assert.match(drawer.textContent, /Alternative master IDs: None recorded/);
    assert.match(drawer.outerHTML, /&lt;img/);
    for (const tag of ['img', 'script', 'iframe', 'a', 'button', 'input', 'form']) assert.equal(drawer.querySelectorAll(tag).length, 0);
    assert.equal(JSON.stringify(pages), before);
    assert.equal(questionMatchEvidenceDrawer([]), null);
    const limited = questionMatchEvidenceDrawer(Array.from({ length: MATCH_EVIDENCE_LIMITS.pages + 2 }, (_, index) => ({ position: index + 1 })));
    assert.equal(limited.querySelectorAll('details').length, MATCH_EVIDENCE_LIMITS.pages);
    assert.match(limited.textContent, /2 more pages are not displayed/);
    const unknownBank = questionMatchEvidenceDrawer([], { finalist_ids: [7] });
    assert.match(unknownBank.textContent, /recorded complete: Not recorded/);
    assert.match(unknownBank.textContent, /Final comparison performed: Not recorded/);
    assert.doesNotMatch(unknownBank.textContent, /unique|accepted|success/i);
  } finally { restore(); }
});

const chromium = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-headless-shell'].find(file => fs.existsSync(file));
test('local Chromium drawer opens, closes and reopens without writes, navigation or injected elements', {
  skip: process.env.MATCHING_UI_QA !== '1' ? 'Set MATCHING_UI_QA=1 for local Chromium verification.' : !chromium,
  timeout: 60_000,
}, async () => {
  const { default: express } = await import('express');
  const { default: puppeteer } = await import('puppeteer-core');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-matching-ui-'));
  const app = express();
  app.get('/fixture', (_req, res) => res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/styles.css"></head><body><main id="fixture" style="padding:16px;max-width:1000px"></main></body></html>'));
  app.use(express.static(path.join(root, 'public')));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: path.join(temp, 'browser'),
      env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_CACHE_HOME: path.join(temp, 'cache') },
      args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    const requests = [];
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.evaluate(async ({ pages, options }) => {
      const { questionMatchEvidenceDrawer } = await import('/js/matching-evidence.js');
      window.fixturePages = pages;
      window.fixtureOptions = options;
      window.fixtureBefore = JSON.stringify([pages, options]);
      document.querySelector('#fixture').append(questionMatchEvidenceDrawer(pages, { complete: true, batch_count: 3, final_compared: true, finalist_ids: [7, 17] }, options));
      window.fetch = () => { throw new Error('Unexpected request from diagnostics'); };
    }, { pages: [{ ...sourcePage({ source_heading: '<img src="/private-image" onerror="window.injected=true">', reason: 'q'.repeat(900) }), source_file: 'Original scan.pdf', identity: { name_written: '<img src="/private-image" onerror="window.injected=true">', field_observations: { grade_written: 'Class 6' } } }, { position: 16 }],
      options: { content_match: contentMatch(), identity_review: { status: 'needs_review', problems: ['The written name is unresolved.'] } } });
    const url = page.url();
    const historyLength = await page.evaluate(() => history.length);
    for (const width of [1100, 390]) {
      await page.setViewport({ width, height: 900 });
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await page.click('[data-question-match-evidence] > summary');
        assert.equal(await page.$eval('[data-question-match-evidence]', element => element.open), true);
        await page.click('[data-question-match-page="15"] > summary');
        assert.equal(await page.$eval('[data-question-match-page="15"]', element => element.open), true);
        await page.click('[data-content-match-section="1"] > summary');
        await page.click('[data-identity-review] details > summary');
        const state = await page.evaluate(() => ({
          text: document.querySelector('#fixture').innerText,
          unchanged: window.fixtureBefore === JSON.stringify([window.fixturePages, window.fixtureOptions]),
          injected: Boolean(window.injected), forbidden: document.querySelectorAll('#fixture img, #fixture script, #fixture button, #fixture input, #fixture iframe').length,
          overflows: document.documentElement.scrollWidth > window.innerWidth,
        }));
        assert.match(state.text, /Proposed master ID: 7/);
        assert.match(state.text, /Header status: descriptive/);
        assert.match(state.text, /Content Match: Complete/);
        assert.match(state.text, /Identity Review: Needs review/);
        assert.match(state.text, /The written name is unresolved/);
        assert.match(state.text, /Two supplied masters share these question labels/);
        assert.match(state.text, /original file: Original scan.pdf/);
        assert.equal(state.unchanged, true);
        assert.equal(state.injected, false);
        assert.equal(state.forbidden, 0);
        assert.equal(state.overflows, false);
        if (repeat === 0 && process.env.MATCHING_UI_QA_DIR) {
          fs.mkdirSync(process.env.MATCHING_UI_QA_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.MATCHING_UI_QA_DIR, `matching-evidence-${width}.png`), fullPage: true });
        }
        await page.click('[data-identity-review] details > summary');
        await page.click('[data-content-match-section="1"] > summary');
        await page.click('[data-question-match-page="15"] > summary');
        await page.click('[data-question-match-evidence] > summary');
        assert.equal(await page.$eval('[data-question-match-evidence]', element => element.open), false);
      }
    }
    assert.equal(page.url(), url);
    assert.equal(await page.evaluate(() => history.length), historyLength);
    assert.ok(requests.every(request => request.method === 'GET' && !request.url.includes('/api/') && !request.url.includes('/private-image')));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('confirmed bank UI displays source count, distinct PDFs, manifest hash and folder link', async () => {
  const { confirmedBankSummary } = await import('../public/js/views/bulk.js');
  const restore=installReportDom({});
  try {
    const bank={source_file_count:78,canonical_pdf_count:65,id:'a'.repeat(64),source_root:'https://drive.google.com/drive/folders/confirmed'};
    const card=confirmedBankSummary(bank);
    assert.match(card.textContent,/78 source files · 65 distinct PDFs/);
    assert.ok(card.textContent.includes(bank.id));
    assert.equal(card.querySelector('a').getAttribute('href'),bank.source_root);
    assert.match(confirmedBankSummary(null).textContent,/No confirmed source folder selected/);
  } finally {restore();}
});
