import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankComparisonEvidence, MATCH_EVIDENCE_LIMITS, questionMatchEvidence, questionMatchEvidenceDrawer } from '../public/js/matching-evidence.js';
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

test('diagnostics explicitly allowlist fields and reject nested values in visible fields', () => {
  const secret = { provider_prompt: 'PRIVATE PROMPT', api_key: 'PRIVATE KEY', answer_text: 'PRIVATE ANSWER', image_url: 'PRIVATE IMAGE', result: { nested: 'PRIVATE NESTED' } };
  const page = sourcePage({ ...secret, questions: [{ text: 'PRIVATE QUESTION' }], issues: [{ reason: 'PRIVATE ISSUE' }], header_evidence: { status: 'conflict', reason: 'Known conflict', ...secret } });
  const result = JSON.stringify([questionMatchEvidence({ ...page, ...secret }), bankComparisonEvidence({ complete: true, ...secret })]);
  for (const value of ['PRIVATE PROMPT', 'PRIVATE KEY', 'PRIVATE ANSWER', 'PRIVATE IMAGE', 'PRIVATE NESTED', 'PRIVATE QUESTION', 'PRIVATE ISSUE']) assert.ok(!result.includes(value), value);
  assert.equal(questionMatchEvidence(page).questions.invalid, 1);
  assert.equal(questionMatchEvidence(page).issues.invalid, 1);
  for (const filename of ['server/reports.js', 'server/report-html.js', 'public/js/views/reports.js'].filter(file => fs.existsSync(file))) assert.ok(!fs.readFileSync(filename, 'utf8').includes('matching-evidence'));
  const bulk = fs.readFileSync('public/js/views/bulk.js', 'utf8');
  assert.match(bulk, /questionMatchEvidenceDrawer\(item\.pages, item\.bank_comparison\)/);
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
    await page.evaluate(async pages => {
      const { questionMatchEvidenceDrawer } = await import('/js/matching-evidence.js');
      window.fixturePages = pages;
      window.fixtureBefore = JSON.stringify(pages);
      document.querySelector('#fixture').append(questionMatchEvidenceDrawer(pages, { complete: true, batch_count: 3, final_compared: true, finalist_ids: [7, 17] }));
      window.fetch = () => { throw new Error('Unexpected request from diagnostics'); };
    }, [sourcePage({ source_heading: '<img src="/private-image" onerror="window.injected=true">', reason: 'q'.repeat(900) }), { position: 16 }]);
    const url = page.url();
    const historyLength = await page.evaluate(() => history.length);
    for (const width of [1100, 390]) {
      await page.setViewport({ width, height: 900 });
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await page.click('[data-question-match-evidence] > summary');
        assert.equal(await page.$eval('[data-question-match-evidence]', element => element.open), true);
        await page.click('[data-question-match-page="15"] > summary');
        assert.equal(await page.$eval('[data-question-match-page="15"]', element => element.open), true);
        const state = await page.evaluate(() => ({
          text: document.querySelector('#fixture').innerText,
          unchanged: window.fixtureBefore === JSON.stringify(window.fixturePages),
          injected: Boolean(window.injected), forbidden: document.querySelectorAll('#fixture img, #fixture script, #fixture button, #fixture input, #fixture iframe').length,
          overflows: document.documentElement.scrollWidth > window.innerWidth,
        }));
        assert.match(state.text, /Proposed master ID: 7/);
        assert.match(state.text, /Header status: descriptive/);
        assert.equal(state.unchanged, true);
        assert.equal(state.injected, false);
        assert.equal(state.forbidden, 0);
        assert.equal(state.overflows, false);
        if (repeat === 0 && process.env.MATCHING_UI_QA_DIR) {
          fs.mkdirSync(process.env.MATCHING_UI_QA_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.MATCHING_UI_QA_DIR, `matching-evidence-${width}.png`), fullPage: true });
        }
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
