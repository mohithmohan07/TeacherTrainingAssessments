// Calls Google's Gemini API. The key comes from the GEMINI_API_KEY environment
// variable (a Fly secret in production) and is never sent to the browser.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini 3.8 Flash is Google's newest Flash model (checked 29 September 2026).
// GEMINI_MODEL switches to another one without a code change.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Google's current way of asking for JSON output, and the older one, which
// some models and API versions still expect instead.
const outputFormats = {
  current: (schema) => ({ responseFormat: { text: { mimeType: 'application/json', schema } } }),
  legacy: (schema) => ({ responseMimeType: 'application/json', responseJsonSchema: schema }),
};

async function callGemini(key, parts, generationConfig, timeoutMs) {
  let response;
  try {
    response = await fetch(`${API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new GeminiError(timedOut ? 'Gemini took too long to answer. Please try again.' : `Could not reach Gemini: ${error.message}`);
  }
  return { response, payload: await response.json().catch(() => null) };
}

// Many requests at once (a school's answer papers read together) can pass
// Gemini's limit per minute. It then answers 429 and says how long to wait;
// the request is sent again after that wait, or a longer one each time, as it
// is after a passing server error.
const RETRIES = 10;

async function callGeminiPatiently(key, parts, generationConfig, timeoutMs) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await callGemini(key, parts, generationConfig, timeoutMs);
    if (attempt >= RETRIES || ![429, 500, 502, 503, 504].includes(result.response.status)) return result;
    const delay = (result.payload?.error?.details ?? []).find((d) => String(d?.['@type']).endsWith('RetryInfo'))?.retryDelay;
    const asked = delay ? parseFloat(delay) * 1000 : 0;
    const wait = Math.min(60_000, Math.max(asked, 2000 * 2 ** attempt)) * (1 + Math.random() / 2);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// Sends one prompt, followed by any other `parts` such as scanned pages, and
// returns the model's reply parsed as JSON. `schema` is a JSON Schema that
// Gemini shapes its output to. `nothing` (given Gemini's reason) and `garbled`
// say in the caller's words that the reply was empty or not the JSON asked for.
export async function generateJson({
  prompt,
  parts = [],
  schema,
  timeoutMs = 240_000,
  nothing = (reason) => `Gemini returned no paper (${reason}). Try again, or change the topic wording.`,
  garbled = 'Gemini returned something that was not a complete paper. Please try again.',
}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new GeminiError('The Gemini API key is not set up yet. Add GEMINI_API_KEY as a Fly secret, then try again.', 503);
  }

  const content = [{ text: prompt }, ...parts];
  let { response, payload } = await callGeminiPatiently(key, content, outputFormats.current(schema), timeoutMs);
  if (response.status === 400 && /responseFormat|unknown name|invalid json payload/i.test(payload?.error?.message ?? '')) {
    ({ response, payload } = await callGeminiPatiently(key, content, outputFormats.legacy(schema), timeoutMs));
  }

  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`;
    if (/api key/i.test(detail)) {
      throw new GeminiError('Gemini rejected the API key. Check the GEMINI_API_KEY secret on Fly.');
    }
    if (response.status === 404) {
      throw new GeminiError(`Gemini does not know the model "${GEMINI_MODEL}". Set GEMINI_MODEL to a current model name.`);
    }
    if (response.status === 429) {
      throw new GeminiError('Gemini says the usage limit has been reached. Wait a minute and try again, or check the quota on the Google account.');
    }
    throw new GeminiError(`Gemini returned an error: ${detail}`);
  }

  const candidate = payload?.candidates?.[0];
  // Thinking models can return their reasoning as separate "thought" parts.
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
  if (!text) {
    const reason = candidate?.finishReason ?? payload?.promptFeedback?.blockReason ?? 'no content';
    throw new GeminiError(nothing(reason));
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError(garbled);
  }
}
