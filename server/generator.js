// Writes teacher assessment papers with Gemini in the programme's layout (see
// paper-formats.js): builds the prompts, and holds what comes back to that layout.

import db from './db.js';
import { generateJson } from './gemini.js';
import { findLanguage } from './languages.js';
import {
  LEVELS,
  SECTION_KEYS,
  TEACHER_TYPES,
  firstQuestionNumber,
  partLabel,
  questionMarks,
  sectionFormats,
  sectionMarks,
} from './paper-formats.js';

// The words printed beside the marks and the time. Each section prints as its
// own one-hour paper, as the programme's papers do.
const ENGLISH_LABELS = { total_marks: 'Total Marks', time: 'Time', marks: 'Marks', one_hour: '1 Hour' };

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

// A label is words only. Gemini has filled these with the marks themselves
// ("35" for "Total Marks", which printed as "35: 100"), so a label with a
// number in it falls back to English.
function labelWords(text, english) {
  const words = clean(text, 60).replace(/[:：]$/u, '').trim();
  return words && !/\p{Nd}/u.test(words) ? words : english;
}

// Drops marks copied into a heading or title ("(35 Marks)", "[Total Marks: 10]"),
// since the page prints them beside it.
function dropMarks(text) {
  return text.replace(/\s*[([][^()[\]]*\p{Nd}[^()[\]]*[)\]]$/u, '').trim();
}

// The examination line at the top of a section's paper. Only Section B names
// the subject, as in the sample papers; A and C are for every teacher.
function sectionTitle(request, format) {
  const level = LEVELS[request.level];
  const subject = format.key === 'B' && request.subject ? `${request.subject} ` : '';
  return `${[request.board, level.name].filter(Boolean).join(' ')} - ${subject}Teacher Assessment Examination`;
}

// Turns whatever the form sent into a request the generator can trust.
export function readRequest(body = {}) {
  const requested = Array.isArray(body.sections) ? body.sections.map(String) : SECTION_KEYS;
  const school = body.school_id ? db.prepare('SELECT id, name, logo_path FROM schools WHERE id = ?').get(body.school_id) : null;
  const request = {
    school_id: school?.id ?? null,
    school_name: school?.name ?? '',
    school_logo: school?.logo_path ?? null,
    board: clean(body.board, 80),
    level: Object.hasOwn(LEVELS, body.level) ? body.level : '',
    grade: clean(body.grade, 80),
    subject: clean(body.subject, 120),
    teacher_type: Object.hasOwn(TEACHER_TYPES, body.teacher_type) ? body.teacher_type : 'subject',
    topics: clean(body.topics, 2000),
    language: clean(body.language, 60) || 'English',
    instructions: clean(body.instructions, 2000),
    sections: SECTION_KEYS.filter((key) => requested.includes(key)),
  };

  const problems = [];
  if (!request.level) problems.push('a school level');
  if (request.sections.includes('B') && !request.subject) problems.push('a subject for Section B');
  if (!request.sections.length) problems.push('at least one section');
  return { request, problems };
}

function describeSection(format, start, group) {
  const lines = [`${format.heading} (${sectionMarks(format)} marks). It tests ${format.focus}.`];
  format.questions.forEach((question, index) => {
    lines.push(
      `  Q${start + index}${question.title ? ` "${question.title}"` : ''} [${questionMarks(question)} marks]. Scenario: ${question.purpose}`
    );
    const ideas = question.ideas?.[group];
    if (ideas?.length) lines.push(`    Situations that suit this level, as ideas only: ${ideas.join('; ')}.`);
    question.parts.forEach((part, partIndex) => {
      lines.push(`    ${partLabel(question, partIndex)}. (${part.marks} marks) ${part.purpose}`);
    });
  });
  return lines.join('\n');
}

// One prompt per section, so the sections are written in parallel and a long
// paper never runs into the model's output limit.
function buildPrompt(request, formats, index) {
  const format = formats[index];
  const level = LEVELS[request.level];
  const english = /^english$/i.test(request.language);
  const language = findLanguage(request.language);
  const script = language && language.script !== 'Latin' ? ` in the ${language.script} script` : '';
  const subjectSection = format.key === 'B';

  const context = [
    request.board && `Board: ${request.board}`,
    `School level: ${level.name} (${level.classes}). ${level.guidance}`,
    request.grade && `Classes the teacher teaches: ${request.grade}`,
    request.subject && `Subject: ${request.subject}`,
    `Teacher type: ${TEACHER_TYPES[request.teacher_type]}`,
    subjectSection && request.teacher_type === 'subject'
      ? request.topics
        ? `Topics to draw the subject questions from:\n${request.topics}`
        : 'Topics: choose important, commonly misunderstood topics from this board\'s syllabus for these classes.'
      : null,
  ].filter(Boolean);

  return [
    'You write written assessment papers for a teacher training programme in Indian schools.',
    'The people answering are practising teachers, not students. Each question is a realistic case study from an Indian school, followed by parts that ask the teacher to explain, analyse, design, propose or outline what they would do.',
    '',
    ...context,
    '',
    'Write this section of the paper with exactly this layout. Keep every question, part and mark exactly as given:',
    describeSection(format, firstQuestionNumber(formats, index, request.teacher_type), level.group),
    '',
    'How to write it:',
    subjectSection
      ? '- Each "scenario" is one paragraph of 3 to 6 sentences with concrete detail for this subject and these classes: the grade, the activity or topic, what learners say or do.'
      : '- This section tests every teacher at this level, whatever their subject, so do not test subject knowledge. Each "scenario" is one paragraph of 3 to 6 sentences set in an ordinary school situation for this level, with concrete detail: the class, what learners, parents or colleagues say or do.',
    '- Write to the teacher sitting the paper as "you" (e.g. "You are teaching Class 7 ..." and "How would you ..."), as the programme\'s papers do. Never give that teacher a gender: no "she" or "he", and no Ms., Mrs. or Mr. Model answers and marking points speak of "you" or "the teacher" in the same way.',
    '- Other adults in a scenario, such as colleagues, the coordinator, the Principal or parents, may be women or men. Vary them, and where it makes no difference, name only the role ("a colleague", "a parent").',
    '- Where a learner is named, use Indian first names that suit the paper\'s language and region, a mix of girls and boys, with different names in each question. Avoid stereotypes: girls and boys, and learners of every background, appear as both strong and struggling learners.',
    '- Where a scenario lists several observations or situations, you may set them out as short bullet lines inside the scenario text, one per line starting with "- ".',
    format.questions.some((question) => question.ideas?.[level.group]?.length)
      ? '- The situations listed as ideas show the kind of situation that suits this level. Do not copy them: write a fresh situation of your own, with different details.'
      : null,
    '- Each part is one or two sentences starting with a command word (Explain, Analyse, Describe, Design, Propose, Outline, State, How would you...). Where it helps, add examples in brackets, such as "(e.g. exit cards or think-pair-share)".',
    '- Parts must fit the scenario they belong to, and no two questions may test the same idea.',
    '- Hold every question to the standard of a demanding professional examination: specific, realistic situations with names, numbers, quoted learner errors or observed behaviour, and parts that need analysis and planning rather than recall. A generic question that could fit any level is not good enough.',
    format.questions.some((question) => question.components)
      ? '- For the formal document question, the scenario ends by asking for the document (a report, proposal or reflective report) to the Principal; each part is one heading of that document with a one-line description of what it must contain.'
      : null,
    '- For every part, write a model answer a strong teacher would give and the marking points an evaluator should look for, one point per item, adding up to the part\'s marks.',
    '- Do not start any text with its question number or part letter, and do not write marks in it: the paper prints them.',
    english
      ? '- Write everything in clear, simple English.'
      : `- Write the whole section in ${request.language}${script}, including the title, section heading, question titles, scenarios, parts, model answers, marking points and the labels. Use natural ${request.language} as a teacher of that language would write it, not a word-for-word translation. Keep the question numbers as Q1, Q2 and the part letters as A, B, C, D.`,
    english
      ? null
      : `- If ${request.language} marks gender in verbs or adjectives, phrase what "you" do so that no gender is assumed, for example by building the sentence around the class, the lesson or the task. Where the grammar forces a choice, use the general form that formal examination papers in ${request.language} use for every candidate.`,
    '- The section\'s "heading" is its heading as written above (without the marks), and "key" is its letter.',
    `- "title" is the examination title line, e.g. "${sectionTitle(request, format)}".`,
    '- "labels" holds the words for "Total Marks", "Time" and "Marks" in the paper\'s language, with no numbers (the paper adds the marks after them), and "one_hour" is "1 Hour" in that language.',
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

const SECTION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    labels: {
      type: 'object',
      description: "Words printed on the paper, in the paper's language.",
      properties: {
        total_marks_label: { type: 'string', description: 'The words "Total Marks", translated. No number.' },
        time_label: { type: 'string', description: 'The word "Time", translated. No number.' },
        marks_label: { type: 'string', description: 'The word "Marks", translated. No number.' },
        one_hour: { type: 'string', description: 'The phrase "1 Hour", translated.' },
      },
      required: ['total_marks_label', 'time_label', 'marks_label', 'one_hour'],
    },
    section: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: SECTION_KEYS },
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
  required: ['title', 'labels', 'section'],
};

// Holds Gemini's sections to the layout that was asked for: our question
// numbers, part labels and marks, whatever Gemini wrote for them. Anything
// missing is listed in `shortfall` so the page can say so. `raws` holds one
// Gemini reply per section, in paper order.
export function normalizePaper(raws, request, formats) {
  const english = /^english$/i.test(request.language);
  const shortfall = [];

  const sections = formats.map((format, sectionIndex) => {
    const raw = raws[sectionIndex];
    const rawQuestions = Array.isArray(raw?.section?.questions) ? raw.section.questions : [];
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
        title: question.title ? (!english && dropMarks(clean(rawQuestion.title, 200))) || question.title : '',
        marks: questionMarks(question),
        components: Boolean(question.components),
        scenario: clean(rawQuestion.scenario, 6000),
        parts,
      };
    });

    return {
      key: format.key,
      title: (!english && clean(raw?.title, 300)) || sectionTitle(request, format),
      heading: (!english && dropMarks(clean(raw?.section?.heading, 300))) || format.heading,
      marks: sectionMarks(format),
      questions,
    };
  });

  const labels = raws.find((raw) => raw?.labels)?.labels ?? {};
  const level = LEVELS[request.level];
  return {
    // What the list of papers calls it: the Section B title when there is one.
    title: (sections.find((section) => section.key === 'B') ?? sections[0]).title,
    school_name: request.school_name,
    school_logo: request.school_logo,
    level: level.name,
    language: request.language,
    lang: findLanguage(request.language)?.code ?? null,
    rtl: Boolean(findLanguage(request.language)?.rtl),
    labels: english
      ? { ...ENGLISH_LABELS }
      : {
          total_marks: labelWords(labels.total_marks_label, ENGLISH_LABELS.total_marks),
          time: labelWords(labels.time_label, ENGLISH_LABELS.time),
          marks: labelWords(labels.marks_label, ENGLISH_LABELS.marks),
          one_hour: clean(labels.one_hour, 60) || ENGLISH_LABELS.one_hour,
        },
    total_marks: sections.reduce((sum, section) => sum + section.marks, 0),
    sections,
    shortfall,
  };
}

// Readies a saved paper for the page. Papers saved before each section became
// its own one-hour paper have no section titles or "1 Hour" label, and their
// labels may hold numbers.
export function presentPaper(paper) {
  const labels = paper.labels ?? {};
  return {
    ...paper,
    labels: {
      total_marks: labelWords(labels.total_marks, ENGLISH_LABELS.total_marks),
      time: labelWords(labels.time, ENGLISH_LABELS.time),
      marks: labelWords(labels.marks, ENGLISH_LABELS.marks),
      one_hour: labels.one_hour || (paper.sections.length === 1 && clean(labels.duration, 60)) || ENGLISH_LABELS.one_hour,
    },
    sections: paper.sections.map((section) => ({ ...section, title: section.title || paper.title })),
  };
}

export async function generatePaper(request) {
  const formats = sectionFormats(request.teacher_type, request.sections);
  const raws = await Promise.all(
    formats.map((_format, index) => generateJson({ prompt: buildPrompt(request, formats, index), schema: SECTION_SCHEMA }))
  );
  return normalizePaper(raws, request, formats);
}
