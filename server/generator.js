// Builds teacher training assessment papers with Gemini: the default layout of
// Sections A, B and C, the prompt, and the checks on what comes back.

import { generateJson } from './gemini.js';

export const QUESTION_TYPES = {
  mcq: 'Multiple choice (four options, one correct)',
  short: 'Short answer (a few sentences)',
  long: 'Long answer (a detailed, structured response)',
};

// A starting layout, to be replaced once it has been matched to real papers.
export const DEFAULT_SECTIONS = [
  { name: 'A', title: 'Multiple choice questions', type: 'mcq', count: 10, marks: 1 },
  { name: 'B', title: 'Short answer questions', type: 'short', count: 5, marks: 3 },
  { name: 'C', title: 'Long answer questions', type: 'long', count: 3, marks: 5 },
];

export const FOCUS_OPTIONS = {
  subject: 'subject knowledge the teacher needs to teach the topics well',
  pedagogy: 'teaching practice: lesson planning, classroom strategies, assessment and common student misconceptions',
  both: 'a balance of subject knowledge and teaching practice',
};

const MAX_QUESTIONS_PER_SECTION = 30;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function toInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function toMarks(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(100, Math.round(number * 2) / 2);
}

// Turns whatever the form sent into a request the generator can trust.
export function readRequest(body = {}) {
  const request = {
    subject: clean(body.subject, 120),
    grade: clean(body.grade, 60),
    topics: clean(body.topics, 2000),
    focus: Object.hasOwn(FOCUS_OPTIONS, body.focus) ? body.focus : 'both',
    instructions: clean(body.instructions, 2000),
    title: clean(body.title, 200),
  };

  const given = Array.isArray(body.sections) && body.sections.length ? body.sections : DEFAULT_SECTIONS;
  request.sections = given.slice(0, 6).map((section, index) => {
    const fallback = DEFAULT_SECTIONS[index] ?? DEFAULT_SECTIONS.at(-1);
    return {
      name: clean(section.name, 4) || String.fromCharCode(65 + index),
      title: clean(section.title, 120) || fallback.title,
      type: Object.hasOwn(QUESTION_TYPES, section.type) ? section.type : fallback.type,
      count: toInt(section.count, fallback.count, 0, MAX_QUESTIONS_PER_SECTION),
      marks: toMarks(section.marks, fallback.marks),
    };
  }).filter((section) => section.count > 0);

  const problems = [];
  if (!request.subject) problems.push('a subject');
  if (!request.topics) problems.push('at least one topic');
  if (!request.sections.length) problems.push('at least one question in one section');
  return { request, problems };
}

export function totalMarks(sections) {
  return sections.reduce((sum, section) => sum + section.count * section.marks, 0);
}

function buildPrompt(request) {
  const layout = request.sections
    .map(
      (section) =>
        `- Section ${section.name} ("${section.title}"): exactly ${section.count} question(s), ` +
        `${QUESTION_TYPES[section.type]}, ${section.marks} mark(s) each.`
    )
    .join('\n');

  return [
    'You write written assessments for a teacher training programme in Indian schools.',
    'The people answering are practising teachers, not students. The paper tests whether a teacher is ready to teach the topics below.',
    '',
    `Subject: ${request.subject}`,
    request.grade ? `Grade the teacher teaches: ${request.grade}` : null,
    `Topics:\n${request.topics}`,
    `Focus: ${FOCUS_OPTIONS[request.focus]}.`,
    request.instructions ? `Extra instructions from the trainer:\n${request.instructions}` : null,
    '',
    'Paper layout (follow it exactly, in this order):',
    layout,
    `Total marks: ${totalMarks(request.sections)}.`,
    '',
    'Rules:',
    '- Write clear, unambiguous questions in simple English. Do not repeat a question or test the same idea twice.',
    '- Multiple choice questions have exactly four options, with one clearly correct answer and plausible distractors. Put the options in "options" without letters, and the correct option text in "answer".',
    '- Short and long answer questions leave "options" empty. Put a model answer in "answer" and the points an evaluator should look for in "marking_points", one point per item, so the marks can be awarded fairly.',
    '- Give each section one line of instructions for the teacher answering it.',
    '- Number questions continuously across the whole paper, starting at 1.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const PAPER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    instructions: { type: 'STRING' },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          instructions: { type: 'STRING' },
          questions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                text: { type: 'STRING' },
                options: { type: 'ARRAY', items: { type: 'STRING' } },
                answer: { type: 'STRING' },
                marking_points: { type: 'ARRAY', items: { type: 'STRING' } },
              },
              required: ['text', 'answer'],
            },
          },
        },
        required: ['name', 'questions'],
      },
    },
  },
  required: ['sections'],
};

// Holds Gemini's paper to the layout that was asked for: our section names,
// titles and marks, the requested question counts, and continuous numbering.
export function normalizePaper(raw, request) {
  const rawSections = Array.isArray(raw?.sections) ? raw.sections : [];
  let number = 0;

  const sections = request.sections.map((section, index) => {
    const match =
      rawSections.find((candidate) => clean(candidate?.name, 20).replace(/^section\s*/i, '').toUpperCase() === section.name.toUpperCase()) ??
      rawSections[index];

    const questions = (Array.isArray(match?.questions) ? match.questions : [])
      .filter((question) => clean(question?.text, 4000))
      .slice(0, section.count)
      .map((question) => {
        number += 1;
        const options = section.type === 'mcq' ? (question.options ?? []).map((option) => clean(option, 1000)).filter(Boolean).slice(0, 6) : [];
        return {
          number,
          text: clean(question.text, 4000),
          options,
          answer: clean(question.answer, 4000),
          marking_points: (question.marking_points ?? []).map((point) => clean(point, 1000)).filter(Boolean).slice(0, 12),
          marks: section.marks,
        };
      });

    return {
      name: section.name,
      title: section.title,
      type: section.type,
      marks_each: section.marks,
      instructions: clean(match?.instructions, 600),
      questions,
    };
  });

  const missing = request.sections
    .map((section, index) => ({ section, got: sections[index].questions.length }))
    .filter(({ section, got }) => got < section.count);

  return {
    title: request.title || clean(raw?.title, 200) || `${request.subject} assessment`,
    instructions: clean(raw?.instructions, 1200),
    total_marks: sections.reduce((sum, section) => sum + section.questions.length * section.marks_each, 0),
    sections,
    shortfall: missing.map(({ section, got }) => `Section ${section.name} has ${got} of ${section.count} questions`),
  };
}

export async function generatePaper(request) {
  const raw = await generateJson({ prompt: buildPrompt(request), schema: PAPER_SCHEMA });
  return normalizePaper(raw, request);
}
