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

// Sends one request and returns the parsed JSON object. `task` finishes the
// sentence "OpenAI took more than five minutes to …" and `retry` says what to
// press to try again, so every failure reads as advice.
export async function requestJson({ instructions, content, name, schema, task, retry }) {
  const body = {
    model: OPENAI_MODEL,
    instructions,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name, schema, strict: true } },
    store: false,
  };

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw friendly(
      error.name === 'TimeoutError'
        ? `OpenAI took more than five minutes to ${task}. ${retry}`
        : `Could not reach OpenAI: ${error.message}`
    );
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw friendly(`OpenAI rejected the API key in OPENAI_API_KEY (${detail}).`);
    if (res.status === 429) throw friendly(`OpenAI refused the request: rate limit or no credit left on the account (${detail}).`);
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
