import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const chromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));
test('cross-profile card requires explicit acknowledgement, opens full master, and prevents repeat pending clicks', {
  skip: process.env.CROSS_PROFILE_UI_QA !== '1' ? 'Set CROSS_PROFILE_UI_QA=1 for local Chromium verification.' : !chromium, timeout: 60000,
}, async () => {
  const { default: express } = await import('express');
  const { default: puppeteer } = await import('puppeteer-core');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-profile-ui-'));
  const app = express();
  app.get('/fixture', (_req, res) => res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/styles.css"></head><body><main id="fixture" style="padding:16px;max-width:900px"></main></body></html>'));
  app.use(express.static(path.join(root, 'public')));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: path.join(temp, 'browser'),
      env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_CACHE_HOME: path.join(temp, 'cache') },
      args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    const requests = []; page.on('request', request => requests.push(request));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.evaluate(async () => {
      const { profileReviewCard } = await import('/js/views/bulk.js');
      window.calls = [];
      window.section = { key: 'B', cross_profile_review: { paper_id: 27, token: 'synthetic-token', master_url: '/synthetic-master.pdf', explanation: 'Content points to Biology. Teacher profile: Middle School; Science. Catalogue: secondary; Biology. <img src=x onerror="window.injected=true">', acknowledged: false } };
      window.renderCard = (busy = false) => document.querySelector('#fixture').replaceChildren(profileReviewCard({ id: 88 }, window.section, busy, async (item, data) => {
        window.calls.push({ item, data }); await new Promise(resolve => { window.release = resolve; });
        window.section.cross_profile_review.acknowledged = true; window.renderCard();
      }));
      window.renderCard();
    });
    for (const width of [1100, 390]) {
      await page.setViewport({ width, height: 850 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.match(await page.$eval('#fixture', el => el.innerText), /Middle School; Science/);
    }
    assert.equal(await page.$eval('a', el => el.getAttribute('href')), '/synthetic-master.pdf');
    assert.equal(await page.$eval('a', el => el.target), '_blank');
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
    await page.evaluate(() => window.renderCard(true));
    assert.equal(await page.$eval('button', el => el.disabled), true);
    await page.evaluate(() => window.renderCard(false));
    await page.click('button');
    assert.equal(await page.$eval('button', el => el.disabled), true);
    await page.click('button');
    assert.deepEqual(await page.evaluate(() => window.calls), [{ item: { id: 88 }, data: { papers: { B: 27 }, profile_confirmations: { B: 'synthetic-token' } } }]);
    await page.evaluate(() => window.release());
    await page.waitForFunction(() => !document.querySelector('button'));
    assert.match(await page.$eval('#fixture', el => el.innerText), /Administered master confirmed/);
    assert.match(await page.$eval('#fixture', el => el.innerText), /Automatic Finalize assessments is held/);
    assert.ok(requests.every(request => request.method() === 'GET' && !request.url().includes('/api/')));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('confirmation card structural and event contract preserves explicit acknowledgement', async () => {
  const { installReportDom, ReportNode } = await import('./report-dom-helper.js');
  const restore = installReportDom({});
  const previousListener = ReportNode.prototype.addEventListener;
  ReportNode.prototype.addEventListener = function (type, handler) { this.listeners ??= {}; this.listeners[type] = handler; };
  try {
    const { profileReviewCard } = await import('../public/js/views/bulk.js');
    const item = { id: 88 };
    const section = { key: 'B', cross_profile_review: { paper_id: 27, token: 'review-token', master_url: '/uploads/synthetic.pdf', explanation: 'Middle School / Science differs from Secondary / Biology <script>unsafe</script>', acknowledged: false } };
    const calls = []; let finish;
    const card = profileReviewCard(item, section, false, async (target, data) => { calls.push({ target, data }); await new Promise(resolve => { finish = resolve; }); });
    assert.equal(calls.length, 0);
    assert.match(card.outerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.equal(card.querySelector('a').getAttribute('href'), '/uploads/synthetic.pdf');
    assert.equal(card.querySelector('a').getAttribute('target'), '_blank');
    assert.match(card.textContent, /Automatic Finalize assessments is held/);
    const button = card.querySelector('button');
    const pending = button.listeners.click({ currentTarget: button });
    assert.equal(button.disabled, true);
    assert.deepEqual(calls, [{ target: item, data: { papers: { B: 27 }, profile_confirmations: { B: 'review-token' } } }]);
    finish(); await pending; assert.equal(button.disabled, false);
    section.cross_profile_review.acknowledged = true;
    const acknowledged = profileReviewCard(item, section, false, () => assert.fail('No confirmation action after acknowledgement'));
    assert.equal(acknowledged.querySelector('button'), null);
    assert.match(acknowledged.textContent, /Original profile and source evidence are unchanged/);
    const absent = profileReviewCard(item, { key: 'B' }, false, () => {});
    assert.equal(absent, null);
  } finally { ReportNode.prototype.addEventListener = previousListener; restore(); }
});
