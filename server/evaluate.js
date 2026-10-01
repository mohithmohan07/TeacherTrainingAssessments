// Marking an assessment with the OpenAI API. Evaluate sends the question
// paper (scanned pages, or PDFs confirmed from the paper library) and the
// teacher's scanned response to the model, which reads both and marks every
// question. It runs in the background: the request that
// starts it returns straight away and the page polls the assessment until the
// marking is done or has failed. Once it is done, the teacher's reports for
// the test are rebuilt (reports.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import db, { UPLOADS_DIR } from './db.js';
import { OPENAI_MODEL, friendly, openaiConfigured, requestJson } from './openai.js';
import { queueTeacherReports } from './reports.js';
import { swapScanKinds } from './scans.js';
import { sittingPapers } from './papers.js';
import { sectionKey } from './results.js';

// Types the OpenAI API accepts as image input. The scanner helper saves JPEG.
const OPENAI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const INSTRUCTIONS = `You are an experienced examiner marking a teacher training assessment.

You are given two groups: first the QUESTION PAPER (scanned pages, or the paper itself as a PDF), then the TEACHER'S RESPONSE (scanned pages of the answers the teacher wrote on separate sheets, usually by hand). Each page or file is labelled with its group just before it.

Pages are sometimes filed under the wrong group. If every page labelled QUESTION PAPER is plainly the teacher's own handwritten answers, and the pages labelled TEACHER'S RESPONSE are plainly the printed question paper, the two groups were swapped: mark them the right way round and set pages_swapped to true. In every other case, including when you are unsure or the teacher wrote on the question paper itself, use the groups as labelled and set pages_swapped to false.

The paper and the answers may be in English or any Indian language, in any script: for example Hindi, Marathi, Sanskrit, Kannada, Tamil, Telugu, Malayalam, Bengali, Assamese, Urdu or Kashmiri (Urdu and Kashmiri are written right to left). Read everything in the language it is written in, and never take marks off for the language an answer is written in.

Mark the response against the question paper:
- Work through every question on the question paper in order, including questions the teacher did not answer (award 0 for those). The teacher may have sat only some sections of the paper on this date: still list every question of every section, with an empty teacher_answer where nothing was written.
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
  required: ['pages_swapped', 'questions', 'summary', 'strengths', 'areas_to_improve'],
  properties: {
    pages_swapped: { type: 'boolean', description: 'True only when the question paper and the response were plainly filed the wrong way round.' },
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
  const library = sittingPapers(assessment.id);
  const response = selectFiles.all(assessment.id, 'response');
  const hasPaper = paper.length || library.length;
  if (!hasPaper && !response.length) return 'Choose the question paper from the library or scan it, and scan the teacher’s answer paper, first.';
  if (!hasPaper) return 'Choose the question paper from the library, or scan or upload it, first.';
  if (!response.length) return 'Scan or upload the teacher’s answer paper first.';

  const unsupported = [...paper, ...response].filter((file) => !OPENAI_IMAGE_TYPES.has(file.mime_type));
  if (unsupported.length) {
    return `OpenAI can only read JPG, PNG, WEBP or GIF pages. Remove and re-upload these in one of those formats: ${unsupported
      .map((file) => file.original_name)
      .join(', ')}.`;
  }

  markRunning.run(assessment.id);
  evaluate(assessment, { paper, library, response }).catch((error) => {
    console.error(`Evaluating assessment ${assessment.id} failed:`, error);
    markFailed.run(error.userMessage ?? `Marking failed: ${error.message}`, assessment.id);
  });
  return null;
}

async function evaluate(assessment, { paper, library, response }) {
  const assessmentId = assessment.id;
  const content = [
    ...(await libraryInputs(library)),
    ...(paper.length
      ? [
          { type: 'input_text', text: `QUESTION PAPER (${paper.length} scanned page${paper.length === 1 ? '' : 's'}):` },
          ...(await pageInputs('QUESTION PAPER', paper)),
        ]
      : []),
    { type: 'input_text', text: `TEACHER'S RESPONSE (${response.length} page${response.length === 1 ? '' : 's'}):` },
    ...(await pageInputs("TEACHER'S RESPONSE", response)),
  ];

  const marks = await requestJson({
    instructions: INSTRUCTIONS + sectionInstructions(assessment.section),
    content,
    name: 'assessment_marks',
    schema: RESULT_SCHEMA,
    task: 'mark this',
    retry: 'Press Evaluate to try again.',
  });
  const result = normalise({
    ...marks,
    questions: scopeToSection(marks.questions ?? [], assessment.section),
    // Only scanned pages can have been filed the wrong way round.
    pages_swapped: marks.pages_swapped === true && paper.length > 0 && !library.length,
  });
  if (!result.questions.length) {
    throw friendly('OpenAI found no questions to mark. Check the question paper pages are readable and the right way up, then press Evaluate again.');
  }
  saveMarking(assessmentId, result);

  // The teacher's reports for this test are rewritten to take in the new
  // sections. Pressing Evaluate is what asked for this, so it is not a
  // marking that started on its own.
  const saved = selectAssessment.get(assessmentId);
  if (saved.test_id) queueTeacherReports(saved.teacher_id, saved.test_id);
}

// A sitting of one section is marked on that section alone, even when the
// question paper has others.
function sectionInstructions(section) {
  if (!section) return '';
  return `

This sitting is for Section ${section} only: the teacher sat just that section on this date. Mark only the Section ${section} questions, give every row the section "Section ${section}", and leave out the other sections even if the question paper has them.`;
}

// Rows from other sections are dropped, and every row is filed under the
// sitting's section, including on papers that name no sections at all.
export function scopeToSection(questions, section) {
  if (!section) return questions;
  const inSection = questions.filter((q) => sectionKey(q.section) === section);
  return (inSection.length ? inSection : questions).map((q) => ({ ...q, section: `Section ${section}` }));
}

// Papers confirmed from the library go to OpenAI as the PDFs themselves,
// each introduced with what it is.
async function libraryInputs(papers) {
  const inputs = await Promise.all(
    papers.map(async (paper) => {
      const data = await fs.readFile(path.join(UPLOADS_DIR, paper.stored_name));
      const sections = String(paper.sections).split(',').filter(Boolean);
      const about = [
        sections.length ? `Section${sections.length > 1 ? 's' : ''} ${sections.join(' and ')}` : '',
        paper.subject,
        paper.language && paper.language !== 'English' ? `in ${paper.language}` : '',
      ].filter(Boolean).join(', ');
      return [
        { type: 'input_text', text: `QUESTION PAPER from the paper library: "${paper.title}"${about ? ` (${about})` : ''}. It is a PDF:` },
        { type: 'input_file', filename: `${paper.title.replace(/[^\w .-]+/g, ' ').trim() || 'question paper'}.pdf`, file_data: `data:application/pdf;base64,${data.toString('base64')}` },
      ];
    })
  );
  return inputs.flat();
}

// Every page carries its group and number, so a long run of images cannot
// blur where the question paper ends and the response begins.
async function pageInputs(group, files) {
  const pages = await Promise.all(files.map(imageInput));
  return pages.flatMap((page, i) => [{ type: 'input_text', text: `${group}, page ${i + 1} of ${files.length}:` }, page]);
}

async function imageInput(file) {
  const data = await fs.readFile(path.join(UPLOADS_DIR, file.stored_name));
  return { type: 'input_image', image_url: `data:${file.mime_type};base64,${data.toString('base64')}`, detail: 'high' };
}

// When the marking found the question paper and the response filed the wrong
// way round, it marked them the right way round, and the stored pages are
// swapped back to match, so the evaluation screen shows them correctly.
const saveMarking = db.transaction((assessmentId, result) => {
  saveResult.run({
    id: assessmentId,
    result: JSON.stringify(result),
    model: OPENAI_MODEL,
    score: result.total_score,
    max_score: result.max_score,
  });
  if (result.pages_swapped) swapScanKinds(assessmentId);
});

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
    pages_swapped: raw.pages_swapped === true,
    questions,
    total_score: sum('marks_awarded'),
    max_score: sum('max_marks'),
    summary: String(raw.summary ?? '').trim(),
    strengths: (raw.strengths ?? []).map(String),
    areas_to_improve: (raw.areas_to_improve ?? []).map(String),
  };
}
