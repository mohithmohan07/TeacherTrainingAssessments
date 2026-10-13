import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real local HTTP transport with entirely synthetic prompts, scans and keys.
// Gemini URLs are redirected here by the test, never by production code.
const nativeFetch = globalThis.fetch;
let respond;
let received = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = { path: req.url, body: JSON.parse(body) };
  received.push(request);
  respond(request, res, received.length);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-policy-'));
process.env.DATA_DIR = data;
process.env.OPENAI_BASE_URL = `${base}/v1`;
process.env.OPENAI_API_KEY = 'synthetic-secret-openai';
process.env.GEMINI_API_KEY = 'synthetic-secret-gemini';
const { requestJson, OPENAI_MODEL } = await import('../server/openai.js');
const { generateJson, GEMINI_MODEL } = await import('../server/gemini.js');
const { readAnswers } = await import('../server/reading.js');
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await fs.rm(data, { recursive: true, force: true });
});

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const openaiReply = (usage, value = { ok: true }) => ({ status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const geminiReply = (usageMetadata, value = { ok: true }) => ({ usageMetadata, candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const openai = (requestPolicy, options = {}) => requestJson({
  instructions: 'synthetic-private-prompt', content: [{ type: 'input_text', text: 'synthetic-private-source' }],
  name: 'synthetic_match', schema, task: 'match the paper', retry: 'Try again.', maxRetries: 1, timeoutMs: 90_000,
  requestPolicy, ...options,
});
const gemini = (requestPolicy, options = {}) => generateJson({ prompt: 'synthetic-private-prompt', schema, maxRetries: 1, timeoutMs: 90_000, requestPolicy, task: 'synthetic_match', ...options });

function local(t, handler) {
  received = [];
  respond = handler;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const target = String(url).startsWith('https://generativelanguage.googleapis.com/') ? `${base}/gemini` : String(url);
    assert.ok(target.startsWith(`${base}/`), 'tests must never call a live provider');
    return nativeFetch(target, options);
  });
}

function policy({ limit = Infinity, timeoutMs = 1000, deadline, pauseMs = 5 } = {}) {
  const events = [];
  const rejection = Object.assign(new Error('Synthetic packet budget exhausted.'), { code: 'MATCHING_BUDGET_EXHAUSTED', reason: deadline ? 'packet_deadline' : 'provider_attempts', passing: false });
  let checks = 0;
  return {
    events, rejection,
    get checks() { return checks; },
    remainingMs: () => deadline ? Math.max(0, deadline - Date.now()) : pauseMs,
    beginAttempt(info) {
      checks += 1;
      if (events.length >= limit || (deadline && Date.now() >= deadline)) throw rejection;
      const event = { begin: info, finishes: [] };
      events.push(event);
      return {
        timeoutMs: Math.min(info.timeoutMs, timeoutMs, deadline ? Math.max(1, deadline - Date.now()) : Infinity),
        finish(result) {
          assert.equal(event.finishes.length, 0, 'each admitted attempt must finish exactly once');
          event.finishes.push(result);
        },
      };
    },
  };
}

function checkPrivate(events) {
  const saved = JSON.stringify(events);
  for (const forbidden of ['synthetic-secret', 'synthetic-private', 'authorization', 'x-goog-api-key', 'inlineData', 'generationConfig']) {
    assert.ok(!saved.includes(forbidden), `meter must not receive ${forbidden}`);
  }
  assert.ok(events.every((event) => event.finishes.length === 1));
}

test('OpenAI meters actual success usage and passes only whitelisted counters', async (t) => {
  local(t, (_req, res) => json(res, 200, openaiReply({
    input_tokens: 17, output_tokens: 8, total_tokens: 25,
    input_tokens_details: { cached_tokens: 0, prompt: 'synthetic-private-source' },
    output_tokens_details: { reasoning_tokens: 3, authorization: 'synthetic-secret' },
    unknown: 'synthetic-private-source',
  })));
  const meter = policy();
  assert.deepEqual(await openai(meter), { ok: true });
  assert.equal(received.length, 1);
  assert.deepEqual(meter.events[0].begin, { provider: 'openai', model: OPENAI_MODEL, task: 'synthetic_match', timeoutMs: 90_000 });
  assert.deepEqual(meter.events[0].finishes[0], {
    status: 200, error: undefined,
    usage: { input_tokens: 17, output_tokens: 8, total_tokens: 25, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } },
  });
  checkPrivate(meter.events);
});

test('OpenAI HTTP retries count separately and retain usage on error responses', async (t) => {
  local(t, (_req, res, count) => json(res, count === 1 ? 429 : 200, count === 1
    ? { error: { message: 'synthetic-private-error', code: 'rate_limit' }, usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } }
    : openaiReply({ input_tokens: 6, output_tokens: 2, total_tokens: 8 })));
  const meter = policy();
  assert.deepEqual(await openai(meter), { ok: true });
  assert.equal(received.length, 2);
  assert.deepEqual(meter.events.map((entry) => entry.finishes[0].status), [429, 200]);
  assert.equal(meter.events[0].finishes[0].usage.input_tokens, 5);
  assert.equal(meter.events[0].finishes[0].error, 'http_429');
  checkPrivate(meter.events);
});

test('Gemini meters retries and current-to-legacy format fallback as separate attempts', async (t) => {
  local(t, (_req, res, count) => json(res, count === 1 ? 503 : count === 2 ? 400 : 200, count === 1
    ? { error: { message: 'synthetic-private-error' }, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 } }
    : count === 2 ? { error: { message: 'Unknown name responseFormat' }, usageMetadata: { promptTokenCount: 4 } }
      : geminiReply({ promptTokenCount: 10, candidatesTokenCount: 6, totalTokenCount: 19, thoughtsTokenCount: 3, cachedContentTokenCount: 2, source: 'synthetic-private-source' })));
  const meter = policy();
  assert.deepEqual(await gemini(meter), { ok: true });
  assert.equal(received.length, 3);
  assert.ok(received.slice(0, 2).every((entry) => entry.body.generationConfig.responseFormat));
  assert.equal(received[2].body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(meter.events.map((entry) => entry.finishes[0].status), [503, 400, 200]);
  assert.deepEqual(meter.events[2].begin, { provider: 'gemini', model: GEMINI_MODEL, task: 'synthetic_match', timeoutMs: 90_000 });
  assert.deepEqual(meter.events[2].finishes[0].usage, { promptTokenCount: 10, candidatesTokenCount: 6, totalTokenCount: 19, thoughtsTokenCount: 3, cachedContentTokenCount: 2 });
  checkPrivate(meter.events);
});

for (const [name, request, success] of [['OpenAI', openai, openaiReply], ['Gemini', gemini, geminiReply]]) {
  test(`${name} preserves callers without a policy and does not fabricate absent usage`, async (t) => {
    local(t, (_req, res) => json(res, 200, success(undefined)));
    assert.deepEqual(await request(undefined), { ok: true });
    const meter = policy();
    assert.deepEqual(await request(meter), { ok: true });
    assert.equal(received.length, 2);
    assert.equal(meter.events[0].finishes[0].usage, undefined);
    checkPrivate(meter.events);
  });

  test(`${name} rejects an exhausted budget before any fetch without wrapping its code`, async (t) => {
    local(t, () => assert.fail('An exhausted packet must not reach the provider.'));
    const meter = policy({ limit: 0 });
    await assert.rejects(request(meter), (error) => error === meter.rejection);
    assert.equal(received.length, 0);
    assert.equal(meter.checks, 1);
    assert.equal(meter.events.length, 0);
  });

  test(`${name} rechecks the shared attempt budget before retrying`, async (t) => {
    local(t, (_req, res) => json(res, 503, { error: { message: 'synthetic-private-error' } }));
    const meter = policy({ limit: 1 });
    await assert.rejects(request(meter), (error) => error === meter.rejection);
    assert.equal(received.length, 1);
    assert.equal(meter.checks, 2);
    checkPrivate(meter.events);
  });

  test(`${name} records transport errors once and reserves again for a retry`, async (t) => {
    local(t, (_req, res, count) => count === 1 ? res.destroy() : json(res, 200, success(undefined)));
    const meter = policy();
    assert.deepEqual(await request(meter), { ok: true });
    assert.equal(received.length, 2);
    assert.equal(meter.events.length, 2);
    assert.deepEqual(meter.events[0].finishes[0], { status: 'error', error: 'network_error' });
    checkPrivate(meter.events);
  });

  test(`${name} obeys the policy timeout and does not retry an aborted fetch`, async (t) => {
    local(t, () => {});
    const meter = policy({ timeoutMs: 40 });
    await assert.rejects(request(meter), /too long|more than five minutes/);
    assert.equal(received.length, 1);
    assert.equal(meter.events.length, 1);
    assert.deepEqual(meter.events[0].finishes[0], { status: 'timeout', error: 'timeout' });
    checkPrivate(meter.events);
  });

  test(`${name} also bounds response-body reading by the admitted timeout`, async (t) => {
    local(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
    const meter = policy({ timeoutMs: 40 });
    await assert.rejects(request(meter), /too long/);
    assert.equal(received.length, 1);
    assert.equal(meter.events.length, 1);
    assert.deepEqual(meter.events[0].finishes[0], { status: 'timeout', usage: undefined, error: 'timeout' });
    checkPrivate(meter.events);
  });

  test(`${name} propagates policy persistence failures without network retries`, async (t) => {
    local(t, (_req, res) => json(res, 200, success(undefined)));
    const failure = Object.assign(new Error('Synthetic usage persistence failure.'), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
    let begins = 0;
    const blocked = { beginAttempt() { begins += 1; throw failure; } };
    await assert.rejects(request(blocked), (error) => error === failure);
    assert.equal(begins, 1);
    assert.equal(received.length, 0);
    const unfinished = {
      beginAttempt() { begins += 1; return { timeoutMs: 1000, finish() { throw failure; } }; },
    };
    await assert.rejects(request(unfinished), (error) => error === failure);
    assert.equal(begins, 2);
    assert.equal(received.length, 1);
  });

  test(`${name} bounds retry waiting by the packet deadline`, async (t) => {
    local(t, (_req, res) => json(res, 503, { error: { message: 'synthetic-private-error' } }));
    const started = Date.now();
    const meter = policy({ deadline: started + 70 });
    await assert.rejects(request(meter), (error) => error === meter.rejection);
    assert.ok(Date.now() - started < 1500, 'the normal 2+ second backoff must not outlive the packet deadline');
    assert.equal(received.length, 1);
    checkPrivate(meter.events);
  });

  test(`${name} accounts for malformed HTTP response bodies without retaining their contents`, async (t) => {
    local(t, (_req, res) => { res.writeHead(200); res.end('synthetic-private-not-json'); });
    t.mock.method(console, 'warn', () => {});
    const meter = policy();
    await assert.rejects(request(meter));
    assert.equal(meter.events[0].finishes[0].error, 'invalid_response_json');
    assert.equal(meter.events[0].finishes[0].usage, undefined);
    checkPrivate(meter.events);
  });
}

test('Gemini cannot bypass the packet budget by switching to the legacy format', async (t) => {
  local(t, (_req, res) => json(res, 400, { error: { message: 'Unknown name responseFormat' } }));
  const meter = policy({ limit: 1 });
  await assert.rejects(gemini(meter), (error) => error === meter.rejection);
  assert.equal(received.length, 1);
  assert.equal(meter.checks, 2);
  checkPrivate(meter.events);
});

test('readAnswers shares its request policy with both batch and single-page fallback calls', async (t) => {
  const files = [1, 2].map((id) => ({ id, stored_name: `synthetic-${id}.png`, original_name: `synthetic-${id}.png`, mime_type: 'image/png' }));
  await Promise.all(files.map((file) => fs.writeFile(path.join(UPLOADS_DIR, file.stored_name), Buffer.from('synthetic-private-source'))));
  local(t, (req, res) => {
    const labels = req.body.contents[0].parts.filter((part) => /^Page \d+:$/.test(part.text ?? '')).map((part) => Number(part.text.match(/\d+/)[0]));
    json(res, 200, labels.length > 1
      ? { usageMetadata: { promptTokenCount: 4 }, candidates: [{ finishReason: 'OTHER', content: { parts: [] } }] }
      : geminiReply({ promptTokenCount: 2, candidatesTokenCount: 1 }, { pages: [{ page: labels[0], text: `Synthetic answer ${labels[0]}`, status: 'read', reason: '' }] }));
  });
  t.mock.method(console, 'warn', () => {});
  const meter = policy();
  const result = await readAnswers(files, ['Hindi'], { includeDetails: true, requestPolicy: meter });
  assert.deepEqual(result.texts, ['Synthetic answer 1', 'Synthetic answer 2']);
  assert.equal(received.length, 3);
  assert.equal(meter.events.length, 3);
  assert.ok(meter.events.every((event) => event.begin.task === 'read_answer_pages' && event.begin.timeoutMs === 90_000));
  checkPrivate(meter.events);
});

test('readAnswers does not downgrade a typed budget failure into an unreadable page', async (t) => {
  const file = { id: 3, stored_name: 'synthetic-budget.png', original_name: 'synthetic-budget.png', mime_type: 'image/png' };
  await fs.writeFile(path.join(UPLOADS_DIR, file.stored_name), Buffer.from('synthetic-private-source'));
  local(t, () => assert.fail('An exhausted reader must not reach Gemini.'));
  const meter = policy({ limit: 0 });
  await assert.rejects(readAnswers([file], ['Hindi'], { includeDetails: true, requestPolicy: meter }), (error) => error === meter.rejection);
  assert.equal(received.length, 0);
});
