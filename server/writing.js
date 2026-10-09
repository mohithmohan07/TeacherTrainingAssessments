// Written Expression: how well the teacher writes, apart from whether the
// answers are right. Once the answers are marked, Evaluate has OpenAI check
// the teacher's written answers for sentence formation, grammar, spelling and
// punctuation, and word choice, and list every error with the teacher's own
// words and the correction. Each section the teacher wrote in gets a score
// out of 10 from the four, worked out here. It changes no mark, grade or
// total. Answers are judged in the language they are written in.
//
// OpenAI judges from what the marking read: the scanned pages for answers in
// English, or Gemini's reading for answers in other languages. Sittings
// marked before the check get it when their reports are built, judged from
// what the marking wrote down of each answer.
import db from './db.js';
import { OPENAI_MODEL, openaiConfigured, requestJson } from './openai.js';
import { pageInputs } from './paper-inputs.js';
import { sectionKey, sectionName } from './results.js';

export const WRITING_NAME = 'Written Expression';

// The four things judged, each from 1 to 5.
export const WRITING_CRITERIA = [
  { key: 'sentence_formation', label: 'Sentence Formation' },
  { key: 'grammar', label: 'Grammar' },
  { key: 'spelling_punctuation', label: 'Spelling and Punctuation' },
  { key: 'vocabulary', label: 'Word Choice' },
];

export const ERROR_TYPES = ['Sentence Formation', 'Grammar', 'Spelling', 'Punctuation', 'Word Choice'];

// Bands for the score out of 10.
export const WRITING_LEVELS = [
  { min: 8.5, label: 'Excellent' },
  { min: 7, label: 'Good' },
  { min: 5, label: 'Fair' },
  { min: 0, label: 'Needs Practice' },
];

export const levelFor = (score) => WRITING_LEVELS.find((band) => score >= band.min)?.label ?? null;

const INSTRUCTIONS = `You are an experienced language teacher checking the written expression of a teacher's answers to a teacher training assessment. The answers have already been marked for content; you judge only how well they are written: sentence formation, grammar, spelling and punctuation, and word choice. Never judge whether an answer is right.

The answers may be in English or any Indian language, in any script, and one paper may mix several. Judge each answer in the language it is written in, by the standards of that language and script (in Hindi or Kannada, for example, gender and case agreement, verb endings and matras). Never count writing in a language other than English as an error, and do not count common English words used inside another language, such as "blackboard" or "project", as errors.

Judge only answers written in words: sentences, phrases or points. Leave out blank answers, option letters, one-word answers, numbers and drawings. Points in a list are fine when the question asks for points; judge whether each is clear and correct. Handwriting, words that could not be read, crossed-out words and abbreviations usual in exam answers (such as "eg" or "&") are not errors.

For every section in the list, give:
- judged: false when the section has too little writing to judge (fewer than about 30 words in sentences or phrases), and then 1 for each score and an empty summary; true otherwise.
- sentence_formation: complete, well-ordered sentences whose meaning is clear, without run-ons or fragments.
- grammar: tense, agreement, articles, prepositions, word forms and word order.
- spelling_punctuation: spelling (or the spelling of the script, such as matras and conjuncts), capital letters and punctuation.
- vocabulary: precise, suitable words for a teacher writing about teaching, without wrong or repeated words.
  Score each from 1 to 5: 5 clear and fluent with almost no errors; 4 a few small errors that never affect the meaning; 3 noticeable errors but the meaning is clear; 2 frequent errors that sometimes make the meaning unclear; 1 errors in most sentences, the meaning often hard to follow.
- summary: one short sentence in English on the writing in that section, saying the main thing to work on.

In errors, list each error you find, the most serious first, at most 15 for each section:
- section and question: as given in the list, such as "Section A" and "2B".
- type: one of ${ERROR_TYPES.map((t) => `"${t}"`).join(', ')}.
- wrote: the teacher's words with the error, exactly as written, in their language and script: just the phrase or sentence, under 20 words.
- problem: what is wrong, in plain English, in under 15 words.
- correction: the same words corrected, in the same language and script.
When the same mistake comes up again and again, list it once and say "repeated" in the problem. List only real errors you are sure of, not matters of style.`;

const SOURCE_NOTES = {
  scans: `You are given the TEACHER'S RESPONSE as scanned pages of what the teacher wrote, usually by hand, then the list of sections and questions as marked, with what each question asks and the start of what the teacher wrote, to tell you which answer is which. Judge the writing on the pages.`,
  reading: `The teacher's answers are not all in English, so they were read from the scanned pages, word for word with mistakes kept. You are given that reading, page by page, then the list of sections and questions as marked, with what each question asks and the start of what the teacher wrote, to tell you which answer is which. Judge the writing in the reading.`,
  transcripts: `You are given the list of sections and questions as marked: for each question, what it asks and what the teacher wrote, copied from the scanned pages with mistakes kept ("…" marks where a long answer was cut short). Judge the writing in what the teacher wrote. Spelling and punctuation are as copied.`,
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'errors'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'judged', ...WRITING_CRITERIA.map((c) => c.key), 'summary'],
        properties: {
          section: { type: 'string' },
          judged: { type: 'boolean' },
          ...Object.fromEntries(WRITING_CRITERIA.map((c) => [c.key, { type: 'integer', description: 'From 1 to 5.' }])),
          summary: { type: 'string' },
        },
      },
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'question', 'type', 'wrote', 'problem', 'correction'],
        properties: {
          section: { type: 'string' },
          question: { type: 'string' },
          type: { type: 'string', enum: ERROR_TYPES },
          wrote: { type: 'string' },
          problem: { type: 'string' },
          correction: { type: 'string' },
        },
      },
    },
  },
};

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const written = (q) => String(q.teacher_answer ?? '').trim() !== '';

// The sections and questions as marked, so OpenAI can say which answer each
// error is in. From the scans or a reading, only the start of each answer is
// needed to tell them apart; from transcripts, the whole of what was copied.
function questionList(questions, full) {
  const keys = [...new Set(questions.map((q) => sectionKey(q.section)))];
  const lines = [];
  for (const key of keys) {
    lines.push(`== ${sectionName(key)}`);
    for (const q of questions.filter((x) => sectionKey(x.section) === key)) {
      const asked = q.question_text ? ` Asks: ${clip(q.question_text, 200)}` : '';
      const wrote = written(q) ? `The teacher wrote: ${full ? String(q.teacher_answer).trim() : clip(q.teacher_answer, 80)}` : 'Left blank.';
      lines.push(`${q.question}.${asked} ${wrote}`);
    }
  }
  return `SECTIONS AND QUESTIONS (${keys.length} section${keys.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
}

// Checks the writing in a marked sitting's answers. `source` is what to judge
// from: { pages } for the scanned answer pages, { reading } for Gemini's
// reading of them, or nothing for what the marking wrote down. Returns the
// check to keep with the marking, or null when nothing was written.
export async function checkWriting(questions, source = {}) {
  if (!questions.some(written)) return null;
  const from = source.pages?.length ? 'scans' : source.reading?.length ? 'reading' : 'transcripts';
  const content = [];
  if (from === 'scans') {
    content.push({ type: 'input_text', text: `TEACHER'S RESPONSE (${source.pages.length} page${source.pages.length === 1 ? '' : 's'}):` });
    content.push(...(await pageInputs("TEACHER'S RESPONSE", source.pages)));
  } else if (from === 'reading') {
    source.reading.forEach((text, i) =>
      content.push({ type: 'input_text', text: `TEACHER'S RESPONSE, page ${i + 1} of ${source.reading.length}:\n${text || '(nothing written on this page)'}` })
    );
  }
  content.push({ type: 'input_text', text: questionList(questions, from === 'transcripts') });

  const raw = await requestJson({
    instructions: `${INSTRUCTIONS}\n\n${SOURCE_NOTES[from]}`,
    content,
    name: 'written_expression',
    schema: SCHEMA,
    task: 'check the written expression',
    retry: 'Rebuild the report to try again.',
  });
  return writingOf({ ...raw, from, model: OPENAI_MODEL, checked_at: new Date().toISOString() }, questions);
}

const score = (value) => Math.min(5, Math.max(1, Math.round(Number(value) || 1)));

// The check as kept with the marking: sections named and scored the same way
// as the marks, and errors only for questions that were marked. Also used to
// tidy a stored check when marks are corrected.
export function writingOf(raw, questions) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.problem) return { problem: clip(raw.problem, 600), sections: [], errors: [] };
  const keys = new Set(questions.map((q) => sectionKey(q.section)));
  const seen = new Set();
  const sections = [];
  for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
    const key = sectionKey(s?.section);
    if (!keys.has(key) || seen.has(key)) continue;
    seen.add(key);
    const judged = s.judged !== false;
    const criteria = Object.fromEntries(WRITING_CRITERIA.map((c) => [c.key, judged ? score(s[c.key]) : null]));
    const total = judged ? WRITING_CRITERIA.reduce((sum, c) => sum + criteria[c.key], 0) / 2 : null;
    sections.push({ section: sectionName(key), judged, ...criteria, score: total, summary: judged ? clip(s.summary, 400) : '' });
  }
  const errors = (Array.isArray(raw.errors) ? raw.errors : [])
    .map((e) => ({
      section: sectionName(sectionKey(e?.section)),
      question: clip(e?.question, 20),
      type: ERROR_TYPES.includes(e?.type) ? e.type : 'Grammar',
      wrote: clip(e?.wrote, 300),
      problem: clip(e?.problem, 200),
      correction: clip(e?.correction, 300),
    }))
    .filter((e) => e.wrote && keys.has(sectionKey(e.section)));
  return {
    from: ['scans', 'reading', 'transcripts'].includes(raw.from) ? raw.from : 'transcripts',
    model: String(raw.model ?? ''),
    checked_at: raw.checked_at ?? null,
    sections,
    errors,
  };
}

// One section's Written Expression, as results and reports show it: the
// score out of 10 and its level, the four scores, a sentence and the errors.
// Null when the sitting has not been checked.
export function sectionWriting(writing, key) {
  if (!writing) return null;
  if (writing.problem) return { checked: false, problem: writing.problem };
  const s = writing.sections?.find((x) => sectionKey(x.section) === key);
  const errors = (writing.errors ?? []).filter((e) => sectionKey(e.section) === key);
  if (!s) return { checked: true, judged: false, score: null, level: null, summary: '', criteria: [], errors };
  return {
    checked: true,
    judged: s.judged,
    score: s.score,
    level: s.judged ? levelFor(s.score) : null,
    summary: s.summary,
    criteria: s.judged ? WRITING_CRITERIA.map((c) => ({ label: c.label, score: s[c.key] })) : [],
    errors,
  };
}

/* ------------------------------------------------------ across a school */

const oneDecimal = (n) => Math.round(n * 10) / 10;
const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

// A teacher's Written Expression over the sections judged: the average score
// out of 10 and its level. Null when no section was judged.
export function teacherWriting(sections) {
  const judged = sections.filter((s) => s.writing?.judged);
  if (!judged.length) return null;
  const score = oneDecimal(average(judged.map((s) => s.writing.score)));
  return { score, level: levelFor(score) };
}

// The school's Written Expression, from each assessed teacher's sections:
// the average score, how many teachers are at each level, the average of
// each of the four scores, and the kinds of error, most common first, with
// how many teachers made them. Null when no teacher's writing was judged.
export function schoolWriting(teachers) {
  const judged = teachers
    .map((t) => ({ t, sections: t.sections.filter((s) => s.writing?.judged), overall: teacherWriting(t.sections) }))
    .filter((x) => x.overall);
  if (!judged.length) return null;
  const sections = judged.flatMap((x) => x.sections);
  const types = ERROR_TYPES.map((type) => {
    const per = judged.map((x) => x.sections.reduce((n, s) => n + s.writing.errors.filter((e) => e.type === type).length, 0));
    return { type, errors: per.reduce((a, b) => a + b, 0), teachers: per.filter(Boolean).length };
  })
    .filter((t) => t.errors)
    .sort((a, b) => b.teachers - a.teachers || b.errors - a.errors);
  return {
    teachers: judged.length,
    average: oneDecimal(average(judged.map((x) => x.overall.score))),
    level: levelFor(average(judged.map((x) => x.overall.score))),
    levels: WRITING_LEVELS.map((band) => ({ label: band.label, teachers: judged.filter((x) => x.overall.level === band.label).length })),
    criteria: WRITING_CRITERIA.map((c) => ({
      label: c.label,
      average: oneDecimal(average(sections.map((s) => s.writing.criteria.find((x) => x.label === c.label)?.score).filter(Number.isFinite))),
    })),
    types,
  };
}

// A few of each teacher's errors, as the school report's writer sees them,
// so it can name the usual mistakes.
export function writingExamples(teachers, most = 40) {
  const lines = [];
  for (const t of teachers) {
    for (const e of t.sections.flatMap((s) => (s.writing?.judged ? s.writing.errors : [])).slice(0, 4)) {
      lines.push(`${e.type}: ${e.problem} ("${clip(e.wrote, 60)}" → "${clip(e.correction, 60)}")`);
    }
  }
  return lines.slice(0, most);
}

/* ------------------------------------------- sittings marked before the check */

const selectAssessment = db.prepare('SELECT * FROM assessments WHERE id = ?');
// Only the marking it was worked out for is updated.
const saveWriting = db.prepare(
  `UPDATE assessments SET ai_result = ? WHERE id = ? AND ai_evaluated_at IS ? AND ai_status IS NOT 'running'`
);

export const lacksWriting = (result) => Boolean(result?.questions?.length) && (!result.writing || Boolean(result.writing.problem));

// Checks the writing of one marked sitting that has no check yet, from what
// the marking wrote down. Returns why it could not, or null.
async function fillWriting(assessmentId) {
  const assessment = selectAssessment.get(assessmentId);
  if (!assessment?.ai_result || assessment.ai_status === 'running') return null;
  const result = JSON.parse(assessment.ai_result);
  if (!lacksWriting(result)) return null;
  const writing = await checkWriting(result.questions);
  if (!writing) return null;

  const fresh = selectAssessment.get(assessment.id);
  if (!fresh?.ai_result || fresh.ai_evaluated_at !== assessment.ai_evaluated_at) return null;
  const current = JSON.parse(fresh.ai_result);
  current.writing = writing;
  saveWriting.run(JSON.stringify(current), assessment.id, assessment.ai_evaluated_at);
  return null;
}

// Checks the writing on every sitting behind a teacher's sections that has
// not been checked, one at a time. A sitting that cannot be checked is left
// as it is, so the report is still written; the reasons come back.
export async function addMissingWriting(sections) {
  const problems = [];
  const idsOf = (s) => s.assessment_ids ?? [s.assessment_id];
  const sittings = [...new Set(sections.filter((s) => !s.writing?.checked).flatMap(idsOf).filter(Boolean))];
  for (const id of sittings) {
    const names = sections.filter((s) => idsOf(s).includes(id)).map((s) => s.name).join(' and ');
    try {
      const problem = await fillWriting(id);
      if (problem) problems.push(`${names}: ${problem}.`);
    } catch (error) {
      console.error(`Checking the writing for assessment ${id} failed:`, error);
      problems.push(`${names}: ${error.userMessage ?? error.message}`);
    }
  }
  return problems;
}

// Checks one sitting's writing now, for the button on the evaluation page.
// Returns an error message, or null once it is saved.
export async function checkSittingWriting(assessmentId) {
  if (!openaiConfigured()) return 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.';
  try {
    await fillWriting(assessmentId);
  } catch (error) {
    console.error(`Checking the writing for assessment ${assessmentId} failed:`, error);
    return error.userMessage ?? `The writing could not be checked: ${error.message}`;
  }
  return null;
}
