// Marking an assessment with the OpenAI API. Evaluate sends the scanned
// question paper and the teacher's scanned response to the model, which reads
// both and marks every question. It runs in the background: the request that
// starts it returns straight away and the page polls the assessment until the
// marking is done or has failed.
import fs from 'node:fs/promises';
import path from 'node:path';
import db, { UPLOADS_DIR } from './db.js';

// OPENAI_BASE_URL follows the OpenAI SDKs' convention, for a proxy or a test server.
const OPENAI_URL = `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

// Types the OpenAI API accepts as image input. The scanner helper saves JPEG.
const OPENAI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Marking a handful of handwritten pages can take a while; give up after this.
const TIMEOUT_MS = 5 * 60 * 1000;

export function openaiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

const INSTRUCTIONS = `You are an experienced examiner marking a teacher training assessment.

You are given scanned pages in two groups: first the QUESTION PAPER, then the TEACHER'S RESPONSE (the answers the teacher wrote on separate sheets, usually by hand).

The paper and the answers may be in English or any Indian language, in any script: for example Hindi, Marathi, Sanskrit, Kannada, Tamil, Telugu, Malayalam, Bengali, Assamese, Urdu or Kashmiri (Urdu and Kashmiri are written right to left). Read everything in the language it is written in, and never take marks off for the language an answer is written in.

Mark the response against the question paper:
- Work through every question on the question paper in order, including questions the teacher did not answer (award 0 for those).
- Questions usually have lettered parts (A, B, C, D) with the marks for each part printed beside it in brackets, for example "(3)". Mark every part as its own row, numbered like "1A", "1B", with those printed marks as max_marks. A question without lettered parts is one row, numbered like "4", out of the marks printed for it (for example "[Total Marks: 10]"). If no marks are printed at all, use 1 and say so in the feedback.
- Give each row the section it is in, written in English as "Section A", "Section B" and so on, even when the paper names it in another language (for example खंड 'ख' is Section B). If the paper has no sections, use an empty string.
- In teacher_answer, write down what the teacher wrote for that row, in the language and script they wrote it in, copied faithfully including mistakes. If it is long, give the first 500 characters or so and end with "…". Write [illegible] for words you cannot read, and use an empty string if the teacher did not answer.
- For multiple-choice or one-word questions, award full marks for the correct answer and 0 otherwise.
- For written answers, award marks for each correct and relevant point, the way a fair examiner following a marking scheme would. Partial marks are allowed in steps of 0.5. Never award more than max_marks.
- If handwriting is illegible, mark only what you can read and say what you could not read in the feedback.
- Keep feedback short and specific: what was right, what was missing.
- Write the feedback, summary, strengths and areas to improve in English, for the teacher's trainer.`;

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'summary', 'strengths', 'areas_to_improve'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'question', 'teacher_answer', 'max_marks', 'marks_awarded', 'feedback'],
        properties: {
          section: { type: 'string', description: 'Section in English, e.g. "Section A", or "".' },
          question: { type: 'string', description: 'Question and part as printed, e.g. "1A", "2B", "4".' },
          teacher_answer: { type: 'string', description: 'What the teacher wrote, in their own language, or "".' },
          max_marks: { type: 'number' },
          marks_awarded: { type: 'number' },
          feedback: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    areas_to_improve: { type: 'array', items: { type: 'string' } },
  },
};

const selectAssessment = db.prepare('SELECT * FROM assessments WHERE id = ?');
const selectFiles = db.prepare(
  'SELECT * FROM assessment_files WHERE assessment_id = ? AND kind = ? ORDER BY position, id'
);

const markRunning = db.prepare(
  `UPDATE assessments SET ai_status = 'running', ai_error = NULL, updated_at = datetime('now') WHERE id = ?`
);
const markFailed = db.prepare(
  `UPDATE assessments SET ai_status = 'failed', ai_error = ?, updated_at = datetime('now') WHERE id = ?`
);
const saveResult = db.prepare(
  `UPDATE assessments
      SET ai_status = 'done', ai_error = NULL, ai_result = @result, ai_model = @model,
          ai_evaluated_at = datetime('now'), score = @score, max_score = @max_score,
          status = 'evaluated', updated_at = datetime('now')
    WHERE id = @id`
);

// Checks an assessment can be marked and starts marking it. Returns an error
// message for the person if it cannot start, or null once it is running.
export function startEvaluation(assessmentId) {
  const assessment = selectAssessment.get(assessmentId);
  if (!assessment) return 'Assessment not found.';
  if (!openaiConfigured()) {
    return 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.';
  }
  if (assessment.ai_status === 'running') return null; // already on it

  const paper = selectFiles.all(assessment.id, 'question_paper');
  const response = selectFiles.all(assessment.id, 'response');
  if (!paper.length && !response.length) return 'Scan or upload the question paper and the teacher’s response first.';
  if (!paper.length) return 'Scan or upload the question paper first.';
  if (!response.length) return 'Scan or upload the teacher’s response first.';

  const unsupported = [...paper, ...response].filter((file) => !OPENAI_IMAGE_TYPES.has(file.mime_type));
  if (unsupported.length) {
    return `OpenAI can only read JPG, PNG, WEBP or GIF pages. Remove and re-upload these in one of those formats: ${unsupported
      .map((file) => file.original_name)
      .join(', ')}.`;
  }

  markRunning.run(assessment.id);
  evaluate(assessment.id, paper, response).catch((error) => {
    console.error(`Evaluating assessment ${assessment.id} failed:`, error);
    markFailed.run(error.userMessage ?? `Marking failed: ${error.message}`, assessment.id);
  });
  return null;
}

async function evaluate(assessmentId, paper, response) {
  const content = [
    { type: 'input_text', text: `QUESTION PAPER (${paper.length} page${paper.length === 1 ? '' : 's'}):` },
    ...(await Promise.all(paper.map(imageInput))),
    { type: 'input_text', text: `TEACHER'S RESPONSE (${response.length} page${response.length === 1 ? '' : 's'}):` },
    ...(await Promise.all(response.map(imageInput))),
  ];

  const body = {
    model: OPENAI_MODEL,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: 'assessment_marks', schema: RESULT_SCHEMA, strict: true } },
    store: false,
  };

  const result = normalise(parseMarks(await callOpenAI(body)));
  if (!result.questions.length) {
    throw friendly('OpenAI found no questions to mark. Check the question paper pages are readable and the right way up, then press Evaluate again.');
  }
  saveResult.run({
    id: assessmentId,
    result: JSON.stringify(result),
    model: OPENAI_MODEL,
    score: result.total_score,
    max_score: result.max_score,
  });
}

async function imageInput(file) {
  const data = await fs.readFile(path.join(UPLOADS_DIR, file.stored_name));
  return { type: 'input_image', image_url: `data:${file.mime_type};base64,${data.toString('base64')}`, detail: 'high' };
}

async function callOpenAI(body) {
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
        ? 'OpenAI took more than five minutes to mark this. Press Evaluate to try again.'
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

  if (payload.status && payload.status !== 'completed') {
    const reason = payload.incomplete_details?.reason;
    throw friendly(`OpenAI stopped before finishing the marking${reason ? ` (${reason})` : ''}. Press Evaluate to try again.`);
  }

  const parts = (payload.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);
  const refusal = parts.find((part) => part.type === 'refusal');
  if (refusal) throw friendly(`OpenAI declined to mark this: ${refusal.refusal}`);
  const text = parts.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
  if (!text) throw friendly('OpenAI sent back no marks. Press Evaluate to try again.');
  return text;
}

function parseMarks(text) {
  let marks = null;
  try {
    marks = JSON.parse(text);
  } catch {
    // reported below
  }
  if (!marks || typeof marks !== 'object') {
    throw friendly('OpenAI sent back marks that were cut off or garbled. Press Evaluate to try again.');
  }
  return marks;
}

// Totals are added up here rather than taken from the model, and marks are
// kept within each question's maximum.
export function normalise(raw) {
  const questions = (raw.questions ?? []).map((q) => {
    const max = Math.max(0, Number(q.max_marks) || 0);
    const awarded = Math.min(max, Math.max(0, Number(q.marks_awarded) || 0));
    return {
      section: String(q.section ?? '').trim(),
      question: String(q.question ?? '').trim(),
      teacher_answer: String(q.teacher_answer ?? '').trim(),
      max_marks: max,
      marks_awarded: awarded,
      feedback: String(q.feedback ?? '').trim(),
    };
  });
  const sum = (key) => Math.round(questions.reduce((total, q) => total + q[key], 0) * 100) / 100;
  return {
    questions,
    total_score: sum('marks_awarded'),
    max_score: sum('max_marks'),
    summary: String(raw.summary ?? '').trim(),
    strengths: (raw.strengths ?? []).map(String),
    areas_to_improve: (raw.areas_to_improve ?? []).map(String),
  };
}

function friendly(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}
