import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MATCHING_BUDGET_LIMITS, MAX_MATCHING_BUDGET_LIMITS, MatchingBudgetError,
  createMatchingBudget, estimateMatchingCalls, normalizeMatchingUsage,
} from '../server/matching-budget.js';

// All clocks and provider usage are synthetic. No fetch, credentials, source
// documents, application database, timers, or production files are involved.
const epoch = Date.parse('2026-10-13T12:00:00.000Z');
const openai = { provider: 'openai', model: 'synthetic-gpt-model' };
const gemini = { provider: 'gemini', model: 'synthetic-gemini-model' };
const unknownUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cachedTokens: null };
function fixture(options = {}) {
  let time = 0;
  let wallTime = epoch;
  const changes = [];
  const policy = createMatchingBudget({ clock: () => time, wallClock: () => wallTime, onChange: (snapshot) => changes.push(snapshot), ...options });
  return { policy, changes, advance: (ms) => { time += ms; wallTime += ms; }, setTime: (ms) => { time = ms; }, setWall: (ms) => { wallTime = ms; } };
}
function budgetError(reason) {
  return (error) => {
    assert.ok(error instanceof MatchingBudgetError);
    assert.equal(error.code, 'MATCHING_BUDGET_EXHAUSTED');
    assert.equal(error.reason, reason);
    assert.equal(error.passing, false);
    assert.match(error.userMessage, /No new match was assumed/);
    return true;
  };
}

test('defaults bound a packet, each request, and all provider attempts', () => {
  const { policy } = fixture();
  assert.deepEqual(policy.snapshot().limits, DEFAULT_MATCHING_BUDGET_LIMITS);
  assert.equal(policy.deadlineMs, 900000);
  assert.equal(policy.remainingMs(), 900000);
  assert.equal(policy.beginAttempt({ ...openai, timeoutMs: 300000 }).timeoutMs, 90000);
  assert.equal(policy.beginAttempt({ ...gemini, timeoutMs: 20000 }).timeoutMs, 20000);
  assert.deepEqual(policy.snapshot().usage, unknownUsage);
  assert.equal(policy.snapshot().started_at, '2026-10-13T12:00:00.000Z');
  assert.equal(policy.snapshot().expires_at, '2026-10-13T12:15:00.000Z');
});

test('invalid limits fail closed and never silently become defaults', () => {
  for (const key of Object.keys(DEFAULT_MATCHING_BUDGET_LIMITS)) {
    for (const value of [0, -1, 1.5, NaN, Infinity, null, '40', MAX_MATCHING_BUDGET_LIMITS[key] + 1]) {
      assert.throws(() => fixture({ [key]: value }), RangeError, `${key}=${String(value)}`);
    }
    assert.doesNotThrow(() => fixture({ [key]: MAX_MATCHING_BUDGET_LIMITS[key] }));
  }
});

test('attempt reservations are synchronous and shared across providers and unfinished requests', () => {
  const { policy, changes } = fixture({ maxProviderAttempts: 2 });
  const first = policy.beginAttempt(openai);
  const second = policy.beginAttempt(gemini);
  assert.throws(() => policy.beginAttempt(openai), budgetError('provider_attempts'));
  assert.equal(changes.length, 2);
  assert.equal(changes[0].attempts, 1);
  assert.equal(changes[1].activeAttempts, 2);
  assert.equal(policy.snapshot().exhausted, 'provider_attempts');
  first.finish({ status: 'error', error: 'http_429' });
  second.finish({ status: 'success' });
  assert.throws(() => policy.beginAttempt(gemini), budgetError('provider_attempts'));
  assert.equal(policy.snapshot().completedAttempts, 2);
});

test('request timeout cannot exceed remaining packet time and an expired packet rejects before reserving', () => {
  const { policy, advance, changes } = fixture({ packetTimeoutMs: 2500, requestTimeoutMs: 2000 });
  advance(2250.25);
  assert.equal(policy.beginAttempt(openai).timeoutMs, 249);
  advance(249.1);
  assert.equal(policy.remainingMs(), 0, 'sub-millisecond time cannot be a positive integer fetch timeout');
  assert.throws(() => policy.beginAttempt(gemini), budgetError('packet_deadline'));
  assert.equal(policy.snapshot().attempts, 1);
  assert.equal(changes.length, 1);
});

test('wall clock changes cannot extend an active packet and injected monotonic clocks cannot move backwards', () => {
  const { policy, setTime, setWall } = fixture({ packetTimeoutMs: 1000 });
  setTime(900);
  setWall(epoch - 10_000_000);
  assert.equal(policy.remainingMs(), 100);
  setTime(100);
  assert.equal(policy.remainingMs(), 100);
  setTime(1000);
  assert.throws(() => policy.beginAttempt(openai), budgetError('packet_deadline'));
});

test('slow synchronous persistence cannot admit a request beyond the remaining deadline', () => {
  let time = 0;
  const policy = createMatchingBudget({ packetTimeoutMs: 100, clock: () => time, wallClock: () => epoch, onChange: () => { time += 60; } });
  assert.equal(policy.beginAttempt(openai).timeoutMs, 40);
  assert.throws(() => policy.beginAttempt(gemini), budgetError('packet_deadline'));
  assert.equal(policy.snapshot().attempts, 2);
  assert.equal(policy.snapshot().activeAttempts, 1);
  assert.equal(policy.snapshot().records[1].status, 'timeout');
});

test('provider-native usage is normalized without synthesizing missing counters', () => {
  assert.deepEqual(normalizeMatchingUsage('openai', { input_tokens: 21, output_tokens: 8, total_tokens: 31, input_tokens_details: { cached_tokens: 5 } }),
    { inputTokens: 21, outputTokens: 8, totalTokens: 31, cachedTokens: 5 });
  assert.deepEqual(normalizeMatchingUsage('gemini', { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 17, cachedContentTokenCount: 0, thoughtsTokenCount: 6 }),
    { inputTokens: 9, outputTokens: 2, totalTokens: 17, cachedTokens: 0 });
  assert.deepEqual(normalizeMatchingUsage('openai', { input_tokens: 20, output_tokens: 4 }),
    { ...unknownUsage, inputTokens: 20, outputTokens: 4 });
  assert.deepEqual(normalizeMatchingUsage('unknown', { input_tokens: 10 }), unknownUsage);
});

test('missing, invalid, negative, string, and non-finite counters do not become recorded token usage', () => {
  for (const bad of [undefined, null, {}, [], '21']) assert.deepEqual(normalizeMatchingUsage('openai', bad), unknownUsage);
  for (const bad of [-1, Infinity, NaN, '100', true, {}, Number.MAX_VALUE]) {
    assert.deepEqual(normalizeMatchingUsage('openai', { input_tokens: bad, output_tokens: bad, total_tokens: bad, input_tokens_details: { cached_tokens: bad } }), unknownUsage);
    assert.deepEqual(normalizeMatchingUsage('gemini', { promptTokenCount: bad, candidatesTokenCount: bad, totalTokenCount: bad, cachedContentTokenCount: bad }), unknownUsage);
  }
});

test('out-of-order completions persist actual elapsed time and usage exactly once, including billed failures', () => {
  const { policy, advance, changes } = fixture();
  const first = policy.beginAttempt(openai);
  advance(15);
  const second = policy.beginAttempt(gemini);
  advance(35);
  assert.equal(second.finish({ status: 'success', usage: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 10 } }), true);
  advance(25);
  assert.equal(first.finish({ status: 'error', usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 }, error: 'http_429' }), true);
  assert.equal(first.finish({ status: 'success', usage: { input_tokens: 99999, total_tokens: 99999 } }), false);
  const snapshot = policy.snapshot();
  assert.deepEqual(snapshot.usage, { inputTokens: 6, outputTokens: 3, totalTokens: 12, cachedTokens: null });
  assert.equal(snapshot.records[0].elapsedMs, 75);
  assert.equal(snapshot.records[1].elapsedMs, 35);
  assert.equal(snapshot.records[0].error, 'http_429');
  assert.equal(snapshot.activeAttempts, 0);
  assert.equal(changes.length, 4);
  assert.equal(changes[2].completedAttempts, 1);
  assert.equal(changes[3].completedAttempts, 2);
});

test('late finishes still record usage after the deadline without enabling further requests', () => {
  const { policy, advance } = fixture({ packetTimeoutMs: 10 });
  const attempt = policy.beginAttempt(openai);
  advance(20);
  attempt.finish({ status: 'timeout', usage: { input_tokens: 10 }, error: new Error('PRIVATE provider body') });
  assert.equal(policy.snapshot().usage.inputTokens, 10);
  assert.equal(policy.snapshot().records[0].elapsedMs, 20);
  assert.equal(policy.snapshot().records[0].error, 'timeout');
  assert.throws(() => policy.beginAttempt(gemini), budgetError('packet_deadline'));
});

test('cancellation prevents new attempts but completion still counts and cancellation survives resume', () => {
  const { policy } = fixture();
  const attempt = policy.beginAttempt(gemini);
  assert.equal(policy.cancel(), true);
  assert.equal(policy.cancel(), false);
  attempt.finish({ status: 'success', usage: { promptTokenCount: 5 } });
  assert.equal(policy.snapshot().usage.inputTokens, 5);
  assert.throws(() => policy.beginAttempt(openai), budgetError('cancelled'));
  const resumed = fixture({ initialSnapshot: JSON.parse(JSON.stringify(policy.snapshot())) }).policy;
  assert.throws(() => resumed.beginAttempt(openai), budgetError('cancelled'));
});

test('persisted snapshots contain identifiers and fixed error codes but no task, payload, source text, keys, or arbitrary errors', () => {
  const { policy } = fixture();
  const attempt = policy.beginAttempt({ ...openai, task: 'PRIVATE source teacher text', content: 'PRIVATE original pages', key: 'PRIVATE key' });
  attempt.finish({ status: 'success', usage: { input_tokens: 12, payload: 'PRIVATE response payload' }, error: { message: 'PRIVATE provider body', code: 'PRIVATE key' } });
  const stored = JSON.stringify(policy.snapshot());
  assert.doesNotMatch(stored, /PRIVATE|teacher|payload|source|content|key/);
  assert.equal(policy.snapshot().records[0].provider, 'openai');
  assert.equal(policy.snapshot().records[0].model, openai.model);
  assert.equal(policy.snapshot().records[0].error, 'provider_error');
});

test('snapshots are immutable detached values, including nested records and counters', () => {
  const { policy, changes } = fixture();
  const attempt = policy.beginAttempt(openai);
  const snapshot = changes[0];
  assert.throws(() => { snapshot.records[0].usage.inputTokens = 999; }, TypeError);
  assert.throws(() => { snapshot.records.push({}); }, TypeError);
  assert.throws(() => { snapshot.limits.maxProviderAttempts = 999; }, TypeError);
  attempt.finish({ status: 'success', usage: { input_tokens: 3 } });
  assert.equal(snapshot.completedAttempts, 0);
  assert.equal(snapshot.usage.inputTokens, null);
  assert.equal(policy.snapshot().usage.inputTokens, 3);
});

test('synchronous persistence failure blocks provider admission and leaves no active unfinished handle', () => {
  const { policy } = fixture({ onChange: () => { throw new Error('disk unavailable'); } });
  assert.throws(() => policy.beginAttempt(openai), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
  assert.equal(policy.snapshot().attempts, 1);
  assert.equal(policy.snapshot().activeAttempts, 0);
  assert.equal(policy.snapshot().records[0].error, 'persistence_error');
  assert.throws(() => policy.beginAttempt(gemini), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
  assert.equal(policy.snapshot().attempts, 1);
});

test('failed finish persistence never causes usage to be counted twice', () => {
  let calls = 0;
  const { policy } = fixture({ onChange: () => { if (++calls === 2) throw new Error('disk unavailable'); } });
  const attempt = policy.beginAttempt(openai);
  const completion = { status: 'success', usage: { input_tokens: 20 } };
  assert.throws(() => attempt.finish(completion), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
  assert.equal(attempt.finish(completion), false);
  assert.equal(policy.snapshot().usage.inputTokens, 20);
  assert.equal(policy.snapshot().activeAttempts, 0);
});

test('async persistence and reentrant changes cannot overlap an unfinished callback', () => {
  assert.throws(() => fixture({ onChange: async () => {} }), /synchronous/);
  const asynchronous = fixture({ onChange: () => Promise.resolve() }).policy;
  assert.throws(() => asynchronous.beginAttempt(openai), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
  assert.throws(() => asynchronous.beginAttempt(openai), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
  let policy;
  ({ policy } = fixture({ onChange: () => policy.beginAttempt(gemini) }));
  assert.throws(() => policy.beginAttempt(openai), { code: 'MATCHING_BUDGET_PERSISTENCE_FAILED' });
  assert.equal(policy.snapshot().attempts, 1);
});

test('restart preserves limits, consumed attempts, actual counters, and the original absolute deadline', () => {
  const first = fixture({ packetTimeoutMs: 10000, requestTimeoutMs: 2000, maxProviderAttempts: 3 });
  first.policy.beginAttempt(openai).finish({ status: 'success', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
  first.advance(1000);
  const saved = JSON.parse(JSON.stringify(first.policy.snapshot()));
  let time = 100;
  const resumed = createMatchingBudget({ initialSnapshot: saved, clock: () => time, wallClock: () => epoch + 5000 });
  assert.equal(resumed.remainingMs(), 5000);
  assert.equal(resumed.snapshot().elapsedMs, 5000);
  assert.deepEqual(resumed.snapshot().limits, saved.limits);
  assert.deepEqual(resumed.snapshot().usage, saved.usage);
  assert.equal(resumed.snapshot().expires_at, saved.expires_at);
  assert.equal(resumed.snapshot().attempts, 1);
  resumed.beginAttempt(gemini).finish({ status: 'success', usage: { promptTokenCount: 2 } });
  assert.equal(resumed.snapshot().usage.inputTokens, 14);
  time += 5000;
  assert.throws(() => resumed.beginAttempt(openai), budgetError('packet_deadline'));
});

test('a restart with a backwards wall clock never restores already-used time', () => {
  const first = fixture({ packetTimeoutMs: 10000 });
  first.advance(8000);
  const resumed = fixture({ initialSnapshot: first.policy.snapshot(), wallClock: () => epoch - 10000 });
  assert.equal(resumed.policy.remainingMs(), 2000);
  resumed.advance(2000);
  assert.throws(() => resumed.policy.beginAttempt(openai), budgetError('packet_deadline'));
});

test('expired or attempt-exhausted snapshots cannot reset the packet on restart', () => {
  const deadline = fixture({ packetTimeoutMs: 1000 });
  const expired = fixture({ initialSnapshot: deadline.policy.snapshot(), wallClock: () => epoch + 1001 }).policy;
  assert.throws(() => expired.beginAttempt(openai), budgetError('packet_deadline'));
  const capped = fixture({ maxProviderAttempts: 1 });
  capped.policy.beginAttempt(openai).finish({ status: 'error' });
  const resumed = fixture({ initialSnapshot: capped.policy.snapshot() }).policy;
  assert.throws(() => resumed.beginAttempt(gemini), budgetError('provider_attempts'));
});

test('requests interrupted by restart remain consumed and unknown, with no fabricated successful usage', () => {
  const first = fixture();
  first.policy.beginAttempt(openai);
  first.advance(3000);
  const resumed = fixture({ initialSnapshot: first.policy.snapshot(), wallClock: () => epoch + 5000 }).policy;
  const snapshot = resumed.snapshot();
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.activeAttempts, 0);
  assert.equal(snapshot.completedAttempts, 1);
  assert.equal(snapshot.interruptedAttempts, 1);
  assert.equal(snapshot.usageIncomplete, true);
  assert.equal(snapshot.records[0].error, 'interrupted');
  assert.equal(snapshot.records[0].elapsedMs, null);
  assert.deepEqual(snapshot.usage, unknownUsage);
  assert.doesNotThrow(() => fixture({ initialSnapshot: JSON.parse(JSON.stringify(snapshot)) }));
});

test('resume drops all unrecognized saved fields instead of forwarding old payloads', () => {
  const { policy } = fixture();
  policy.beginAttempt(openai).finish({ status: 200, usage: { input_tokens: 3 } });
  const saved = JSON.parse(JSON.stringify(policy.snapshot()));
  saved.payload = 'PRIVATE old source';
  saved.records[0].body = 'PRIVATE old provider body';
  saved.records[0].usage.secret = 'PRIVATE old key';
  const resumed = fixture({ initialSnapshot: saved }).policy;
  assert.doesNotMatch(JSON.stringify(resumed.snapshot()), /PRIVATE|secret|payload|body/);
});

test('corrupt or incompatible saved limits, attempt counts, usage, and timestamps are rejected', () => {
  const { policy } = fixture();
  policy.beginAttempt(openai).finish({ status: 'success', usage: { input_tokens: 20 } });
  const saved = policy.snapshot();
  assert.throws(() => fixture({ initialSnapshot: saved, maxProviderAttempts: 50 }), /incompatible/);
  for (const mutate of [
    (snapshot) => { snapshot.version = 999; },
    (snapshot) => { snapshot.attempts = 0; },
    (snapshot) => { snapshot.records = []; },
    (snapshot) => { snapshot.usage.inputTokens = 999; },
    (snapshot) => { snapshot.records[0].usage.inputTokens = -1; },
    (snapshot) => { snapshot.expires_at = 'invalid'; },
    (snapshot) => { snapshot.expires_at = '2026-10-14T12:15:00Z'; },
    (snapshot) => { snapshot.remainingMs = Infinity; },
    (snapshot) => { snapshot.records[0].startedElapsedMs = -1; },
    (snapshot) => { snapshot.records[0].error = 'PRIVATE source text'; },
  ]) {
    const corrupt = JSON.parse(JSON.stringify(saved));
    mutate(corrupt);
    assert.throws(() => fixture({ initialSnapshot: corrupt }), /invalid|incompatible/);
  }
});

test('invalid clocks and invalid request parameters do not consume provider attempts', () => {
  for (const value of [NaN, Infinity, '100']) assert.throws(() => fixture({ clock: () => value }), /clock/);
  for (const value of [NaN, Infinity, '100', 1.5]) assert.throws(() => fixture({ wallClock: () => value }), /wallClock/);
  const { policy } = fixture();
  for (const timeoutMs of [0, -1, '1000', NaN, Infinity]) assert.throws(() => policy.beginAttempt({ ...openai, timeoutMs }), RangeError);
  assert.throws(() => policy.beginAttempt({ provider: 'not a provider', model: 'model' }), TypeError);
  assert.equal(policy.snapshot().attempts, 0);
});

test('logical-call estimate covers every eight-paper batch and conditional final comparison', () => {
  for (const count of [1, 4, 8]) {
    const estimate = estimateMatchingCalls(count);
    assert.equal(estimate.totalCalls, 2);
    assert.equal(estimate.comparisonCalls, 1);
    assert.equal(estimate.finalCalls, 0);
    assert.equal(estimate.finalConditional, false);
  }
  for (const count of [9, 16, 17, 100]) {
    const expected = 1 + Math.ceil(count / 8) + 1;
    assert.equal(estimateMatchingCalls(count).totalCalls, expected);
    assert.equal(estimateMatchingCalls(count).minCalls, expected - 1);
    assert.equal(estimateMatchingCalls(count).maxCalls, expected);
    assert.equal(estimateMatchingCalls(count).finalConditional, true);
    assert.equal(estimateMatchingCalls(count, { hasContenders: false }).totalCalls, expected - 1);
    assert.equal(estimateMatchingCalls(count, { hasContenders: true }).totalCalls, expected);
    assert.equal(estimateMatchingCalls(count, { hasContenders: true }).finalConditional, false);
  }
  assert.equal(estimateMatchingCalls(0).totalCalls, 1);
  assert.equal(estimateMatchingCalls(17).includesRetries, false);
  assert.equal(estimateMatchingCalls(17).includesProviderFallbacks, false);
  for (const count of [-1, 1.5, '8', NaN, Infinity]) assert.throws(() => estimateMatchingCalls(count), RangeError);
});
