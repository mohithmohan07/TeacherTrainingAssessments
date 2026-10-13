// A single packet's provider-attempt and elapsed-time budget. This module has
// no provider, database, filesystem, timer, or environment side effects.
import { performance } from 'node:perf_hooks';

export const DEFAULT_MATCHING_BUDGET_LIMITS = Object.freeze({
  packetTimeoutMs: 15 * 60 * 1000,
  requestTimeoutMs: 90 * 1000,
  maxProviderAttempts: 40,
});

export const MAX_MATCHING_BUDGET_LIMITS = Object.freeze({
  packetTimeoutMs: 60 * 60 * 1000,
  requestTimeoutMs: 5 * 60 * 1000,
  maxProviderAttempts: 200,
});

const usageFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens'];
const emptyUsage = () => Object.fromEntries(usageFields.map((field) => [field, null]));
const validCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

// Never derive missing totals from input/output counts: providers can account
// for other tokens, and absent usage means unknown rather than free usage.
export function normalizeMatchingUsage(provider, usage) {
  const normalized = emptyUsage();
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return normalized;
  const source = provider === 'openai'
    ? {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: usage.input_tokens_details?.cached_tokens,
    }
    : provider === 'gemini'
      ? {
        inputTokens: usage.promptTokenCount,
        outputTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
        cachedTokens: usage.cachedContentTokenCount,
      }
      : {};
  for (const field of usageFields) if (validCount(source[field])) normalized[field] = source[field];
  return normalized;
}

export class MatchingBudgetError extends Error {
  constructor(reason) {
    const message = reason === 'cancelled'
      ? 'Matching for this packet was stopped. No new match was assumed. The original pages are retained.'
      : reason === 'packet_deadline'
      ? 'Matching reached this packet’s time limit. No new match was assumed. The original pages are retained; please retry matching or select the paper yourself.'
      : 'Matching reached this packet’s provider-attempt limit. No new match was assumed. The original pages are retained; please retry matching or select the paper yourself.';
    super(message);
    this.name = 'MatchingBudgetError';
    this.code = 'MATCHING_BUDGET_EXHAUSTED';
    this.reason = reason;
    this.userMessage = message;
    this.passing = false;
  }
}

function persistenceError(cause) {
  const error = new Error('Matching usage could not be saved safely. Please retry matching.', { cause });
  error.name = 'MatchingBudgetPersistenceError';
  error.code = 'MATCHING_BUDGET_PERSISTENCE_FAILED';
  error.userMessage = error.message;
  error.passing = false;
  return error;
}

function label(value, name) {
  // These are identifiers supplied by our adapters, never task/source text.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)) {
    throw new TypeError(`${name} must be a provider/model identifier.`);
  }
  return value;
}

function safeError(error, status) {
  if (status === 'timeout' || error === 'timeout' || ['TimeoutError', 'AbortError'].includes(error?.name)) return 'timeout';
  if (['network_error', 'invalid_response_json'].includes(error)) return error;
  if (typeof error === 'string' && /^http_[1-5]\d\d$/.test(error)) return error;
  return error ? 'provider_error' : null;
}

function safeStatus(status, error) {
  if (['success', 'error', 'timeout'].includes(status)) return status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return error ? 'error' : null;
}

function restoreSnapshot(saved, limits) {
  const invalid = () => { throw new TypeError('The saved matching budget is invalid or has incompatible limits.'); };
  if (!saved || saved.version !== 1 || !saved.limits || Object.keys(limits).some((key) => saved.limits[key] !== limits[key])) invalid();
  const startedAt = typeof saved.started_at === 'string' ? Date.parse(saved.started_at) : NaN;
  const expiresAt = typeof saved.expires_at === 'string' ? Date.parse(saved.expires_at) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt) || expiresAt - startedAt !== limits.packetTimeoutMs) invalid();
  if (!Number.isSafeInteger(saved.elapsedMs) || saved.elapsedMs < 0 || !Number.isSafeInteger(saved.remainingMs) ||
      saved.remainingMs < 0 || saved.remainingMs > limits.packetTimeoutMs ||
      !Number.isSafeInteger(saved.attempts) || saved.attempts < 0 || saved.attempts > limits.maxProviderAttempts ||
      !Array.isArray(saved.records) || saved.records.length !== saved.attempts) invalid();
  const usage = emptyUsage();
  const records = saved.records.map((record, index) => {
    if (!record || record.attempt !== index + 1 || typeof record.completed !== 'boolean' ||
        !Number.isSafeInteger(record.startedElapsedMs) || record.startedElapsedMs < 0 || record.startedElapsedMs > saved.elapsedMs ||
        !Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1 || record.timeoutMs > limits.requestTimeoutMs ||
        (record.completed && record.error !== 'interrupted' ? !Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0 : record.elapsedMs !== null) ||
        !record.usage || !usageFields.every((field) => record.usage[field] === null || validCount(record.usage[field])) ||
        (record.status !== null && record.status !== safeStatus(record.status)) ||
        (record.error !== null && !['provider_error', 'persistence_error', 'interrupted', 'timeout', 'network_error', 'invalid_response_json'].includes(record.error) && !/^http_[1-5]\d\d$/.test(record.error))) invalid();
    // In-progress requests at a crash may have reached the provider. Keep the
    // reservation; never invent their result or zero-token usage on restart.
    if (!record.completed && (record.status !== null || record.error !== null || usageFields.some((field) => record.usage[field] !== null))) invalid();
    for (const field of usageFields) if (record.usage[field] !== null) usage[field] = (usage[field] ?? 0) + record.usage[field];
    return {
      attempt: record.attempt,
      provider: label(record.provider, 'provider'),
      model: label(record.model, 'model'),
      startedElapsedMs: record.startedElapsedMs,
      timeoutMs: record.timeoutMs,
      status: record.completed ? record.status : 'error',
      elapsedMs: record.completed ? record.elapsedMs : null,
      usage: Object.fromEntries(usageFields.map((field) => [field, record.usage[field]])),
      error: record.completed ? record.error : 'interrupted',
      completed: true,
    };
  });
  if (!saved.usage || usageFields.some((field) => saved.usage[field] !== usage[field]) ||
      typeof saved.cancelled !== 'boolean' ||
      saved.completedAttempts !== saved.records.filter((record) => record.completed).length ||
      saved.activeAttempts !== saved.records.filter((record) => !record.completed).length) invalid();
  return { startedAt, expiresAt, records, usage };
}

/**
 * Pass the returned policy to every provider used for this packet, including
 * every retry and fallback. beginAttempt reserves synchronously before fetch.
 * Always finish an admitted attempt, including transport/HTTP failures.
 *
 * onChange must synchronously persist its immutable snapshot. Async callbacks
 * and reentrant begin/finish calls fail closed, so older callbacks cannot
 * overwrite a newer attempt. Persistence failures block further admissions.
 */
export function createMatchingBudget({
  initialSnapshot,
  packetTimeoutMs = initialSnapshot?.limits?.packetTimeoutMs ?? DEFAULT_MATCHING_BUDGET_LIMITS.packetTimeoutMs,
  requestTimeoutMs = initialSnapshot?.limits?.requestTimeoutMs ?? DEFAULT_MATCHING_BUDGET_LIMITS.requestTimeoutMs,
  maxProviderAttempts = initialSnapshot?.limits?.maxProviderAttempts ?? DEFAULT_MATCHING_BUDGET_LIMITS.maxProviderAttempts,
  clock = () => performance.now(),
  wallClock = () => Date.now(),
  onChange,
} = {}) {
  const limits = Object.freeze(Object.fromEntries(Object.entries({ packetTimeoutMs, requestTimeoutMs, maxProviderAttempts })
    .map(([key, value]) => [key, positiveInteger(value, key, MAX_MATCHING_BUDGET_LIMITS[key])])));
  if (typeof clock !== 'function') throw new TypeError('clock must be a monotonic clock function.');
  if (typeof wallClock !== 'function') throw new TypeError('wallClock must be a wall clock function.');
  if (onChange !== undefined && typeof onChange !== 'function') throw new TypeError('onChange must be a synchronous function.');
  if (onChange?.constructor?.name === 'AsyncFunction') throw new TypeError('onChange must be synchronous.');

  let lastNow = -Infinity;
  const now = () => {
    const value = clock();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('clock must return a finite number of milliseconds.');
    // Production uses performance.now(), not wall time. Clamping also protects
    // injected clocks from moving the deadline backwards after a clock jump.
    lastNow = Math.max(lastNow, value);
    return lastNow;
  };
  const startedAt = now();
  const wallNow = wallClock();
  if (!Number.isSafeInteger(wallNow) || !Number.isFinite(new Date(wallNow).getTime()) || !Number.isFinite(new Date(wallNow + packetTimeoutMs).getTime())) {
    throw new TypeError('wallClock must return a valid integer Unix timestamp in milliseconds.');
  }
  const restored = initialSnapshot === undefined ? null : restoreSnapshot(initialSnapshot, limits);
  const started_at = new Date(restored?.startedAt ?? wallNow).toISOString();
  const expires_at = new Date(restored?.expiresAt ?? wallNow + packetTimeoutMs).toISOString();
  const initialRemainingMs = restored
    ? Math.max(0, Math.min(initialSnapshot.remainingMs, restored.expiresAt - wallNow, packetTimeoutMs - initialSnapshot.elapsedMs))
    : packetTimeoutMs;
  const previousElapsedMs = restored
    ? Math.max(initialSnapshot.elapsedMs, packetTimeoutMs - initialRemainingMs)
    : 0;
  const deadlineMs = startedAt + initialRemainingMs;
  if (!Number.isFinite(deadlineMs)) throw new RangeError('The packet deadline is out of range.');
  const records = restored?.records ?? [];
  const usage = restored?.usage ?? emptyUsage();
  let notifying = false;
  let persistenceFailure = null;
  let cancelled = initialSnapshot?.cancelled ?? false;

  const remainingAt = (time) => Math.max(0, Math.floor(deadlineMs - time));
  const exhaustionAt = (time) => cancelled ? 'cancelled' : remainingAt(time) === 0 ? 'packet_deadline'
    : records.length >= maxProviderAttempts ? 'provider_attempts' : null;
  const snapshotAt = (time) => Object.freeze({
    version: 1,
    limits,
    started_at,
    expires_at,
    elapsedMs: previousElapsedMs + Math.max(0, Math.floor(time - startedAt)),
    remainingMs: remainingAt(time),
    cancelled,
    exhausted: exhaustionAt(time),
    attempts: records.length,
    completedAttempts: records.filter((record) => record.completed).length,
    activeAttempts: records.filter((record) => !record.completed).length,
    interruptedAttempts: records.filter((record) => record.error === 'interrupted').length,
    usageIncomplete: records.some((record) => record.error === 'interrupted'),
    usage: Object.freeze({ ...usage }),
    records: Object.freeze(records.map(({ startedAt: unused, ...record }) => Object.freeze({
      ...record,
      usage: Object.freeze({ ...record.usage }),
    }))),
  });
  const assertNotNotifying = () => {
    if (notifying) throw new Error('Matching budget changes cannot be made inside onChange.');
  };
  const emitChange = (time) => {
    if (!onChange) return;
    if (persistenceFailure) throw persistenceFailure;
    notifying = true;
    try {
      const result = onChange(snapshotAt(time));
      if (result && typeof result.then === 'function') {
        // Avoid an unhandled rejection from an incorrectly supplied callback;
        // no subsequent provider request may begin after this contract error.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('onChange must finish synchronously and must not return a Promise.');
      }
    } catch (error) {
      persistenceFailure = persistenceError(error);
      throw persistenceFailure;
    } finally {
      notifying = false;
    }
  };

  return Object.freeze({
    deadlineMs,
    remainingMs: () => remainingAt(now()),
    snapshot: () => snapshotAt(now()),
    cancel() {
      assertNotNotifying();
      if (cancelled) return false;
      cancelled = true;
      emitChange(now());
      return true;
    },
    beginAttempt({ provider, model, timeoutMs = requestTimeoutMs } = {}) {
      assertNotNotifying();
      if (persistenceFailure) throw persistenceFailure;
      const time = now();
      const reason = exhaustionAt(time);
      if (reason) throw new MatchingBudgetError(reason);
      const timeout = Math.min(positiveInteger(timeoutMs, 'timeoutMs'), requestTimeoutMs, remainingAt(time));
      const record = {
        attempt: records.length + 1,
        provider: label(provider, 'provider'),
        model: label(model, 'model'),
        startedAt: time,
        startedElapsedMs: previousElapsedMs + Math.max(0, Math.floor(time - startedAt)),
        timeoutMs: timeout,
        status: null,
        elapsedMs: null,
        usage: emptyUsage(),
        error: null,
        completed: false,
      };
      records.push(record);
      try {
        emitChange(time);
      } catch (error) {
        // No attempt handle escaped, so there can be no associated fetch.
        // Keep the reservation conservative without leaving an active handle.
        record.completed = true;
        record.status = 'error';
        record.error = 'persistence_error';
        record.elapsedMs = 0;
        throw error;
      }
      // Persistence is synchronous but can still consume the remaining time.
      // Recheck after it so a slow disk cannot admit a post-deadline fetch.
      const admittedAt = now();
      const effectiveTimeout = Math.min(timeout, remainingAt(admittedAt));
      if (effectiveTimeout === 0) {
        record.completed = true;
        record.status = 'timeout';
        record.error = 'timeout';
        record.elapsedMs = Math.max(0, Math.floor(admittedAt - time));
        emitChange(admittedAt);
        throw new MatchingBudgetError('packet_deadline');
      }
      record.timeoutMs = effectiveTimeout;
      return Object.freeze({
        timeoutMs: effectiveTimeout,
        finish({ status, usage: suppliedUsage, error } = {}) {
          assertNotNotifying();
          if (record.completed) return false;
          const finishedAt = now();
          record.completed = true;
          record.status = safeStatus(status, error);
          record.error = safeError(error, status);
          record.elapsedMs = Math.max(0, Math.floor(finishedAt - record.startedAt));
          record.usage = normalizeMatchingUsage(record.provider, suppliedUsage);
          for (const field of usageFields) {
            if (record.usage[field] !== null) usage[field] = (usage[field] ?? 0) + record.usage[field];
          }
          emitChange(finishedAt);
          return true;
        },
      });
    },
  });
}

// Logical calls, not HTTP attempts, token forecasts, prices, or a promise of a
// match. Retries and cross-provider fallbacks consume additional attempts.
// A large bank needs a final comparison only when screening finds contenders.
export const MAX_INDEPENDENT_IDENTITY_VERIFICATIONS = 4;

export function estimateMatchingCalls(compatibleCandidates, { hasContenders, sourcePages } = {}) {
  if (!Number.isSafeInteger(compatibleCandidates) || compatibleCandidates < 0) {
    throw new RangeError('compatibleCandidates must be a non-negative integer.');
  }
  if (hasContenders !== undefined && typeof hasContenders !== 'boolean') throw new TypeError('hasContenders must be a boolean when supplied.');
  if (sourcePages !== undefined && (!Number.isSafeInteger(sourcePages) || sourcePages < 1)) throw new RangeError('sourcePages must be a positive integer.');
  const identityCalls = sourcePages === undefined ? 1 : Math.ceil(sourcePages / 8);
  const maximumFocusedRereads = sourcePages === undefined ? 0 : Math.ceil(sourcePages / 4);
  const maximumIndependentVerifications = sourcePages === undefined ? 0 : Math.min(sourcePages, MAX_INDEPENDENT_IDENTITY_VERIFICATIONS);
  const batchSize = 8;
  const comparisonCalls = Math.ceil(compatibleCandidates / batchSize);
  const needsScreening = compatibleCandidates > batchSize;
  const finalCalls = needsScreening && hasContenders !== false ? 1 : 0;
  const finalConditional = needsScreening && hasContenders === undefined;
  const totalCalls = identityCalls + comparisonCalls + finalCalls;
  return Object.freeze({
    compatibleCandidates,
    batchSize,
    identityCalls,
    maximumFocusedRereads,
    maximumIndependentVerifications,
    comparisonCalls,
    finalCalls,
    finalConditional,
    totalCalls,
    minCalls: totalCalls - (finalConditional ? 1 : 0),
    maxCalls: totalCalls + maximumFocusedRereads + maximumIndependentVerifications,
    includesRetries: false,
    includesProviderFallbacks: false,
  });
}
