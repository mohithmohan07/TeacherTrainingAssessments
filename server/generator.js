// Writes teacher assessment papers with Gemini in the programme's layout (see
// paper-formats.js): builds the prompt, and holds what comes back to that layout.

import { generateJson } from './gemini.js';
import {
  SECTION_MINUTES,
  TEACHER_TYPES,
  firstQuestionNumber,
  partLabel,
  questionMarks,
  sectionFormats,
  sectionMarks,
} from './paper-formats.js';

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

// Turns whatever the form sent into a request the generator can trust.
export function readRequest(body = {}) {
  const requested = Array.isArray(body.sections) ? body.sections.map(String) : ['A', 'B'];
  const request = {
    school_name: clean(body.school_name, 200),
    board: clean(body.board, 80),
    level: clean(body.level, 80),
    grade: clean(body.grade, 80),
    subject: clean(body.subject, 120),
    teacher_type: Object.hasOwn(TEACHER_TYPES, body.teacher_type) ? body.teacher_type : 'subject',
    topics: clean(body.topics, 2000),
    language: clean(body.language, 60) || 'English',
    instructions: clean(body.instructions, 2000),
    sections: ['A', 'B'].filter((key) => requested.includes(key)),
  };

  const problems = [];
  if (!request.subject) problems.push('a subject');
  if (!request.sections.length) problems.push('at least one section');
  return { request, problems };
}

function describeSection(format, start) {
  const lines = [`${format.heading} (${sectionMarks(format)} marks). It tests ${format.focus}.`];
  format.questions.forEach((question, index) => {
    const number = start + index;
    lines.push(
      `  Q${number}${question.title ? ` "${question.title}"` : ''} [${questionMarks(question)} marks]. Scenario: ${question.purpose}`
    );
    question.parts.forEach((part, partIndex) => {
      lines.push(`    ${partLabel(question, partIndex)}. (${part.marks} marks) ${part.purpose}`);
    });
  });
  return lines.join('\n');
}

function buildPrompt(request, formats) {
  const context = [
    request.board && `Board: ${request.board}`,
    request.level && `School level: ${request.level}`,
    request.grade && `Classes the teacher teaches: ${request.grade}`,
    `Subject: ${request.subject}`,
    `Teacher type: ${TEACHER_TYPES[request.teacher_type]}`,
    request.topics
      ? `Topics to draw the subject questions from:\n${request.topics}`
      : 'Topics: choose important, commonly misunderstood topics from this board\'s syllabus for these classes.',
  ].filter(Boolean);

  const sections = formats.map((format, index) => describeSection(format, firstQuestionNumber(formats, index, request.teacher_type)));
  const english = /^english$/i.test(request.language);

  return [
    'You write written assessment papers for a teacher training programme in Indian schools.',
    'The people answering are practising teachers, not students. Each question is a realistic case study from an Indian school, followed by parts that ask the teacher to explain, analyse, design, propose or outline what they would do.',
    '',
    ...context,
    '',
    'Write the paper with exactly this layout. Keep every question, part and mark exactly as given:',
    ...sections,
    '',
    'How to write it:',
    '- Each "scenario" is one paragraph of 3 to 6 sentences with concrete detail for this subject and these classes: the grade, the activity or topic, what learners say or do. Give learners Indian first names where a learner is named.',
    '- Each part is one or two sentences starting with a command word (Explain, Analyse, Describe, Design, Propose, Outline, State, How would you...). Where it helps, add examples in brackets, such as "(e.g. exit cards or think-pair-share)".',
    '- Parts must fit the scenario they belong to, and no two questions may test the same idea.',
    '- For the formal report question, the scenario describes the trend and ends by asking for a formal, structured report to the Principal; each part is one heading of that report with a one-line description of what it must contain.',
    '- For every part, write a model answer a strong teacher would give and the marking points an evaluator should look for, one point per item, adding up to the part\'s marks.',
    english
      ? '- Write everything in clear, simple English.'
      : `- Write the whole paper in ${request.language}, including the title, section headings, question titles, scenarios, parts, model answers, marking points and the labels. Use natural ${request.language} as a teacher of that language would write it, not a word-for-word translation. Keep the question numbers as Q1, Q2 and the part letters as A, B, C, D.`,
    '- Each section\'s "heading" is its heading as written above (without the marks), and "key" is its letter.',
    '- "title" is the examination title line, e.g. "<Board> <Level> Division - <Subject> Teacher Assessment Examination".',
    `- "labels" gives the words for "Total Marks", "Time" and "Marks", and "duration" says "${formats.length === 1 ? '1 Hour' : `${formats.length} Hours`}", all in the paper's language.`,
    request.instructions ? `\nExtra instructions from the trainer:\n${request.instructions}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const PART_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    model_answer: { type: 'string' },
    marking_points: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'model_answer', 'marking_points'],
};

const PAPER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        total_marks: { type: 'string' },
        time: { type: 'string' },
        marks: { type: 'string' },
        duration: { type: 'string' },
      },
      required: ['total_marks', 'time', 'marks', 'duration'],
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['A', 'B'] },
          heading: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                scenario: { type: 'string' },
                parts: { type: 'array', items: PART_SCHEMA },
              },
              required: ['scenario', 'parts'],
            },
          },
        },
        required: ['key', 'heading', 'questions'],
      },
    },
  },
  required: ['title', 'labels', 'sections'],
};

// Holds Gemini's paper to the layout that was asked for: our question numbers,
// part labels and marks, whatever Gemini wrote for them. Anything missing is
// listed in `shortfall` so the page can say so.
export function normalizePaper(raw, request, formats) {
  const rawSections = Array.isArray(raw?.sections) ? raw.sections : [];
  const english = /^english$/i.test(request.language);
  const shortfall = [];

  const sections = formats.map((format, sectionIndex) => {
    const match = rawSections.find((candidate) => clean(candidate?.key, 4).toUpperCase() === format.key) ?? rawSections[sectionIndex];
    const rawQuestions = Array.isArray(match?.questions) ? match.questions : [];
    const start = firstQuestionNumber(formats, sectionIndex, request.teacher_type);

    const questions = format.questions.map((question, index) => {
      const rawQuestion = rawQuestions[index] ?? {};
      const rawParts = Array.isArray(rawQuestion.parts) ? rawQuestion.parts : [];
      const parts = question.parts.map((part, partIndex) => {
        const rawPart = rawParts[partIndex] ?? {};
        return {
          label: partLabel(question, partIndex),
          marks: part.marks,
          text: clean(rawPart.text, 2000),
          model_answer: clean(rawPart.model_answer, 6000),
          marking_points: (Array.isArray(rawPart.marking_points) ? rawPart.marking_points : [])
            .map((point) => clean(point, 1000))
            .filter(Boolean)
            .slice(0, 12),
        };
      });

      const number = start + index;
      const missing = !clean(rawQuestion.scenario) ? ['scenario'] : [];
      for (const part of parts) if (!part.text) missing.push(`part ${part.label}`);
      if (missing.length) shortfall.push(`Q${number} is missing its ${missing.join(', ')}`);

      return {
        number,
        title: question.title ? clean(rawQuestion.title, 200) || question.title : '',
        marks: questionMarks(question),
        components: Boolean(question.components),
        scenario: clean(rawQuestion.scenario, 6000),
        parts,
      };
    });

    return {
      key: format.key,
      heading: (!english && clean(match?.heading, 300)) || format.heading,
      marks: sectionMarks(format),
      questions,
    };
  });

  const labels = raw?.labels ?? {};
  return {
    title: clean(raw?.title, 300) || `${request.subject} Teacher Assessment Examination`,
    school_name: request.school_name,
    language: request.language,
    labels: {
      total_marks: (!english && clean(labels.total_marks, 60)) || 'Total Marks',
      time: (!english && clean(labels.time, 60)) || 'Time',
      marks: (!english && clean(labels.marks, 60)) || 'Marks',
      duration: (!english && clean(labels.duration, 60)) || (formats.length > 1 ? `${formats.length} Hours` : '1 Hour'),
    },
    minutes: SECTION_MINUTES * formats.length,
    total_marks: sections.reduce((sum, section) => sum + section.marks, 0),
    sections,
    shortfall,
  };
}

export async function generatePaper(request) {
  const formats = sectionFormats(request.teacher_type, request.sections);
  const raw = await generateJson({ prompt: buildPrompt(request, formats), schema: PAPER_SCHEMA });
  return normalizePaper(raw, request, formats);
}
