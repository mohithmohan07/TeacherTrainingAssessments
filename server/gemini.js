// Calls Google's Gemini API. The key comes from the GEMINI_API_KEY environment
// variable (a Fly secret in production) and is never sent to the browser.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// `gemini-flash-latest` is Google's alias for the newest Flash model, so the
// app keeps working as models are retired. GEMINI_MODEL pins a specific one.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Sends one prompt and returns the model's reply parsed as JSON. `schema` is an
// OpenAPI-style schema Gemini uses to shape its output.
export async function generateJson({ prompt, schema, temperature = 0.7, timeoutMs = 120_000 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new GeminiError('The Gemini API key is not set up yet. Add GEMINI_API_KEY as a Fly secret, then try again.', 503);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new GeminiError(timedOut ? 'Gemini took too long to answer. Please try again.' : `Could not reach Gemini: ${error.message}`);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 400 && /api key/i.test(detail)) {
      throw new GeminiError('Gemini rejected the API key. Check the GEMINI_API_KEY secret on Fly.');
    }
    if (response.status === 429) {
      throw new GeminiError('Gemini says the usage limit has been reached. Wait a minute and try again, or check the quota on the Google account.');
    }
    throw new GeminiError(`Gemini returned an error: ${detail}`);
  }

  const candidate = payload?.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  if (!text) {
    const reason = candidate?.finishReason ?? payload?.promptFeedback?.blockReason ?? 'no content';
    throw new GeminiError(`Gemini returned no paper (${reason}). Try again, or change the topic wording.`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError('Gemini returned something that was not a complete paper. Please try again.');
  }
}
