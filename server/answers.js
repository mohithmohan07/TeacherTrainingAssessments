// What should have been answered. The marking (evaluate.js) says, for every
// question, what was asked and what a full-marks answer contains, and the
// teacher's reports show that beside what the teacher wrote. Sittings marked
// before the marking did this get it here, when their reports are built:
// OpenAI reads the question paper again with the rows it marked, their marks
// and its feedback, so the answers agree with the marks. No mark changes.
import db from './db.js';
import { friendly, requestJson } from './openai.js';
import { sittingPapers } from './papers.js';
import { OPENAI_IMAGE_TYPES, questionPaperInputs } from './paper-inputs.js';
import { sectionName } from './results.js';

// The same rules for the marking and for papers marked before it, so both
// read alike.
export const QUESTION_TEXT_RULE = `question_text says briefly in English what the row asks, in under 25 words, for example "Name two ways to check that children have understood a lesson." When the question is about particular words or sentences in the paper's language, quote them in that language and script.`;

export const EXPECTED_ANSWER_RULE = `expected_answer says what a full-marks answer to the row contains, as a marking scheme would: the correct option and its text for a multiple-choice question, the word or phrase for a one-word question, and the main points a full answer makes for a written one, in one to three short sentences (about 60 words at most). It is in English, except where the answer itself has to be in the paper's language, such as a word, a sentence or a grammar answer on a language paper: that part is in the paper's language and script.`;

const INSTRUCTIONS = `You are the examiner who marked a teacher training assessment, writing down the marking scheme for the questions you marked.

You are given the QUESTION PAPER (scanned pages, or the paper itself as a PDF), then a numbered list of the rows you marked: each row's section and question number, the marks given out of the marks available, the feedback you wrote and the start of what the teacher wrote. The paper and the answers may be in English or any Indian language, in any script.

For every row in the list, give its number as row, and:
- ${QUESTION_TEXT_RULE}
- ${EXPECTED_ANSWER_RULE}

What you write must agree with the marks and feedback given. Where the teacher got full marks, what they wrote is an acceptable answer: for a multiple-choice question, it is the correct option. Where marks were lost, the expected answer includes what the feedback says was missing. Never copy a wrong answer as the expected one, and do not comment on the marks.`;

const ANSWERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['row', 'question_text', 'expected_answer'],
        properties: {
          row: { type: 'integer', description: 'The row number from the list.' },
          question_text: { type: 'string' },
          expected_answer: { type: 'string' },
        },
      },
    },
  },
};

const selectAssessment = db.prepare('SELECT * FROM assessments WHERE id = ?');
const selectPaperPages = db.prepare(
  `SELECT * FROM assessment_files WHERE assessment_id = ? AND kind = 'question_paper' ORDER BY position, id`
);
// Only the marking it was worked out for is updated: a sitting marked again
// meanwhile has its own answers.
const saveAnswers = db.prepare(
  `UPDATE assessments SET ai_result = ? WHERE id = ? AND ai_evaluated_at IS ? AND ai_status IS NOT 'running'`
);

export const lacksAnswer = (q) => !String(q.expected_answer ?? '').trim();

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// Works out what should have been answered for the rows of one marked
// sitting that lack it. Returns why it could not, or null.
export async function fillAnswers(assessmentId) {
  const assessment = selectAssessment.get(assessmentId);
  if (!assessment?.ai_result || assessment.ai_status === 'running') return null;
  const result = JSON.parse(assessment.ai_result);
  const rows = (result.questions ?? []).map((q, index) => ({ q, index })).filter(({ q }) => lacksAnswer(q));
  if (!rows.length) return null;

  const paper = selectPaperPages.all(assessment.id);
  const library = sittingPapers(assessment.id);
  if (!paper.length && !library.length) return 'the question paper is no longer on the sitting';
  if (paper.some((file) => !OPENAI_IMAGE_TYPES.has(file.mime_type))) return 'OpenAI cannot read the question paper’s pages';

  const list = rows.map(({ q }, i) =>
    [
      `${i + 1}. ${q.section || 'No section'}, question ${q.question}: ${q.marks_awarded} / ${q.max_marks} marks.`,
      q.feedback ? `Feedback: ${clip(q.feedback, 300)}` : '',
      String(q.teacher_answer ?? '').trim() ? `The teacher wrote: ${clip(q.teacher_answer, 300)}` : 'Left blank.',
    ].filter(Boolean).join(' ')
  );
  const raw = await requestJson({
    instructions: INSTRUCTIONS,
    content: [
      ...(await questionPaperInputs({ paper, library })),
      { type: 'input_text', text: `THE ROWS YOU MARKED (${rows.length}):\n${list.join('\n')}` },
    ],
    name: 'answer_key',
    schema: ANSWERS_SCHEMA,
    task: 'work out what should have been answered',
    retry: 'Rebuild the report to try again.',
  });

  // Merged into the marking as it is now, so marks corrected meanwhile stay.
  const fresh = selectAssessment.get(assessment.id);
  if (!fresh?.ai_result || fresh.ai_evaluated_at !== assessment.ai_evaluated_at) return null;
  const current = JSON.parse(fresh.ai_result);
  if (current.questions?.length !== result.questions.length) return null;
  let filled = 0;
  for (const answer of Array.isArray(raw.rows) ? raw.rows : []) {
    const q = current.questions[rows[Number(answer?.row) - 1]?.index];
    const expected = clip(answer?.expected_answer, 1000);
    if (!q || !lacksAnswer(q) || !expected) continue;
    q.question_text = String(q.question_text ?? '').trim() || clip(answer.question_text, 300);
    q.expected_answer = expected;
    filled += 1;
  }
  if (!filled) throw friendly('OpenAI sent back no answers for these questions. Rebuild the report to try again.');
  saveAnswers.run(JSON.stringify(current), assessment.id, assessment.ai_evaluated_at);
  return null;
}

// "Section A", "Sections A and B" or "Sections A, B and C".
function sectionsNamed(keys) {
  if (keys.length < 2 || !keys.every((key) => /^[A-Z]$/.test(key))) return keys.map(sectionName).join(' and ');
  return `Sections ${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
}

// Fills in what should have been answered on every sitting behind a
// teacher's sections that lacks it, one sitting at a time. A sitting that
// cannot be done is left as it is, so the report is still written; the
// reasons come back to show on it.
export async function addMissingAnswers(sections) {
  const problems = [];
  const sittings = [...new Set(sections.filter((s) => s.questions?.some(lacksAnswer)).map((s) => s.assessment_id))];
  for (const id of sittings) {
    const names = sectionsNamed(sections.filter((s) => s.assessment_id === id).map((s) => s.key));
    try {
      const problem = await fillAnswers(id);
      if (problem) problems.push(`${names}: ${problem}.`);
    } catch (error) {
      console.error(`Working out the answers for assessment ${id} failed:`, error);
      problems.push(`${names}: ${error.userMessage ?? error.message}`);
    }
  }
  return problems;
}
