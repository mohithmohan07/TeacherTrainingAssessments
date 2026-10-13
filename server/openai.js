// The one call this app makes to OpenAI: the Responses API with a strict JSON
// schema, through fetch (no SDK). Marking (evaluate.js) and report writing
// (reports.js) both go through it.

// OPENAI_BASE_URL follows the OpenAI SDKs' convention, for a proxy or a test server.
const OPENAI_URL = `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

const TIMEOUT_MS = 5 * 60 * 1000;

export function openaiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// An error whose message is written for the person using the app.
export function friendly(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

// One that should pass by itself, such as OpenAI staying too busy or too slow
// for a while when a school's papers are marked together. Marking that fails
// this way is tried once more (evaluate.js).
export function passing(message) {
  const error = friendly(message);
  error.passing = true;
  return error;
}

// Many requests sent together (a school's answer papers matched or marked at
// once) can pass OpenAI's limit on tokens per minute. It then answers 429 and
// says how long to wait; the request is sent again after that wait, or a
// longer one each time, for up to about a quarter of an hour, as it is after a
// passing server error. No credit left on the account is not waited out.
const RETRIES = 15;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Policies are optional, so evaluation keeps its existing retry behavior.
// Matching shares one deadline across providers, including retry waits.
const retryPause = (ms, requestPolicy) => pause(requestPolicy
  ? Math.max(0, Math.min(ms, requestPolicy.remainingMs()))
  : ms);

// Only token counters enter the meter. Never pass a response, prompt, error
// message, API key, or request headers to an observer of provider attempts.
function tokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = {};
  const copy = (from, to, keys) => {
    for (const key of keys) {
      if (Number.isSafeInteger(from?.[key]) && from[key] >= 0) to[key] = from[key];
    }
  };
  copy(raw, usage, ['input_tokens', 'output_tokens', 'total_tokens']);
  for (const [key, counters] of [['input_tokens_details', ['cached_tokens']], ['output_tokens_details', ['reasoning_tokens']]]) {
    const details = {};
    copy(raw[key], details, counters);
    if (Object.keys(details).length) usage[key] = details;
  }
  return Object.keys(usage).length ? usage : undefined;
}

const busy = (res, payload) =>
  (res.status === 429 && ![payload?.error?.code, payload?.error?.type].includes('insufficient_quota')) ||
  [500, 502, 503, 504].includes(res.status);

// The wait OpenAI asks for, in a header or in its message ("Please try again
// in 12.5s"), or one that doubles each time if that is longer, up to a
// minute. Up to half again is added at random, so requests that waited
// together do not all come back at the same moment.
function waitBefore(res, payload, attempt) {
  const hint = /try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(payload?.error?.message ?? '');
  const asked =
    Number(res?.headers.get('retry-after-ms')) ||
    Number(res?.headers.get('retry-after')) * 1000 ||
    (hint ? Number(hint[1]) * (hint[2].toLowerCase() === 'ms' ? 1 : 1000) : 0);
  return Math.min(60_000, Math.max(asked, 2000 * 2 ** attempt)) * (1 + Math.random() / 2);
}

// Sends one request and returns the parsed JSON object. `task` finishes the
// sentence "OpenAI took more than five minutes to …" and `retry` says what to
// press to try again, so every failure reads as advice.
export async function requestJson({ instructions, content, name, schema, task, retry, maxRetries = RETRIES, timeoutMs = TIMEOUT_MS, requestPolicy }) {
  const retries = Math.min(RETRIES, Math.max(0, Math.floor(Number(maxRetries) || 0)));
  const timeout = Math.min(TIMEOUT_MS, Math.max(1000, Number(timeoutMs) || TIMEOUT_MS));
  const body = {
    model: OPENAI_MODEL,
    instructions,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name, schema, strict: true } },
    store: false,
  };

  const sent = JSON.stringify(body);
  let res;
  let payload;
  for (let attempt = 0; ; attempt += 1) {
    // Reserve immediately before every actual fetch, not once per logical
    // request. Budget errors stay outside the network-error retry handler.
    const tracked = requestPolicy?.beginAttempt({ provider: 'openai', model: OPENAI_MODEL, task: name || task, timeoutMs: timeout });
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: sent,
        signal: AbortSignal.timeout(tracked?.timeoutMs ?? timeout),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      tracked?.finish({ status: timedOut ? 'timeout' : 'error', error: timedOut ? 'timeout' : 'network_error' });
      if (error.code === 'MATCHING_BUDGET_EXHAUSTED') throw error;
      if (!timedOut && attempt < retries) {
        await retryPause(waitBefore(null, null, attempt), requestPolicy);
        continue;
      }
      throw passing(
        timedOut
          ? `OpenAI took more than five minutes to ${task}. ${retry}`
          : `Could not reach OpenAI: ${error.message}`
      );
    }
    let bodyError;
    payload = await res.json().catch((error) => { bodyError = error; return null; });
    const bodyTimedOut = bodyError?.name === 'TimeoutError' || bodyError?.name === 'AbortError';
    tracked?.finish({
      status: bodyTimedOut ? 'timeout' : res.status,
      usage: tokenUsage(payload?.usage),
      error: bodyTimedOut ? 'timeout' : bodyError ? 'invalid_response_json' : res.ok ? undefined : `http_${res.status}`,
    });
    if (bodyTimedOut) throw passing(`OpenAI took too long to ${task}. ${retry}`);
    if (busy(res, payload) && attempt < retries) {
      await retryPause(waitBefore(res, payload, attempt), requestPolicy);
      continue;
    }
    break;
  }

  if (!res.ok) {
    const detail = payload?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw friendly(`OpenAI rejected the API key in OPENAI_API_KEY (${detail}).`);
    if (busy(res, payload)) throw passing(`OpenAI stayed too busy to ${task} (${detail}). ${retry}`);
    if (res.status === 429) throw friendly(`OpenAI refused the request: no credit left on the account (${detail}).`);
    throw friendly(`OpenAI returned an error: ${detail}`);
  }

  if (payload?.status && payload.status !== 'completed') {
    const reason = payload.incomplete_details?.reason;
    throw friendly(`OpenAI stopped before it could finish${reason ? ` (${reason})` : ''}. ${retry}`);
  }

  const parts = (payload?.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);
  const refusal = parts.find((part) => part.type === 'refusal');
  if (refusal) throw friendly(`OpenAI declined to ${task}: ${refusal.refusal}`);
  const text = parts.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
  if (!text) throw friendly(`OpenAI sent back nothing. ${retry}`);

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // reported below
  }
  if (!parsed || typeof parsed !== 'object') {
    throw friendly(`OpenAI sent back an answer that was cut off or garbled. ${retry}`);
  }
  return parsed;
}
