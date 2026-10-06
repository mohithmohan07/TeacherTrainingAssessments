// Reading the teacher's answers before they are marked (evaluate.js). OpenAI
// first looks at the answer pages and says what language the answers are in.
// Answers all in English are then read and marked by OpenAI from the scans.
// Answers in another language, or in English mixed with another, are read by
// Gemini, which writes down each page in the teacher's own language and
// script, and OpenAI marks that reading the same way it marks the scans.
import fs from 'node:fs/promises';
import path from 'node:path';
import { UPLOADS_DIR } from './db.js';
import { friendly, requestJson } from './openai.js';
import { GeminiError, geminiConfigured, generateJson } from './gemini.js';
import { pageInputs } from './paper-inputs.js';

const LANGUAGE_INSTRUCTIONS = `You are checking a teacher's answers to a teacher training assessment before they are marked. You are given the TEACHER'S RESPONSE: scanned pages of the answers the teacher wrote, usually by hand.

Say what language the answers are written in:
- "english" when every answer is in English.
- "not_english" when the answers are in another language, such as Hindi, Kannada, Tamil, Sanskrit or Urdu, and none of them is in English.
- "mixed" when some of the answers are in English and some in another language, even if only a word or a line is.

Judge the language, not the script: Hindi written in English letters counts as Hindi. Only what the teacher wrote counts, not printed headings or instructions, numbers, question labels such as "1A", or names of people and places. When you are unsure, say "mixed".

In languages, name every language the answers are written in, in English, for example ["Hindi", "English"].`;

// Sent only when the question paper was scanned too, so the two could have
// been filed the wrong way round.
const SWAP_RULE = `

The QUESTION PAPER's scanned pages come before the response. Pages are sometimes filed under the wrong group: if every page labelled QUESTION PAPER is plainly the teacher's own handwritten answers, and the pages labelled TEACHER'S RESPONSE are plainly the printed question paper, the two groups were swapped. Then set pages_swapped to true and judge the language of the answers on the QUESTION PAPER pages. In every other case, including when you are unsure or the teacher wrote on the question paper itself, set pages_swapped to false.`;

const LANGUAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'languages', 'pages_swapped'],
  properties: {
    language: { type: 'string', enum: ['english', 'not_english', 'mixed'] },
    languages: { type: 'array', items: { type: 'string' } },
    pages_swapped: { type: 'boolean', description: 'True only when the question paper and the response were plainly filed the wrong way round.' },
  },
};

const READING_PROMPT = `These are scanned pages of a teacher's answers to a teacher training assessment, usually handwritten. Write down what each page says, so that an examiner who cannot see the pages can mark the answers.

- Write everything in the language and script it is written in, for example Hindi, Kannada, Tamil, Sanskrit, Urdu or English; one page may mix several. Never translate.
- Copy the teacher's words as they are, mistakes included. Do not correct spelling, grammar or facts, and do not add anything that is not on the page.
- Keep question numbers and labels such as "1A" or "Q2 (b)" where they are written, and start a new line where the teacher did.
- Write [illegible] for a word you cannot read. Leave out words the teacher crossed out.
- For a drawing, diagram, table or chart, describe it briefly in English in square brackets and copy its labels as written, for example [diagram: the water cycle, labelled Evaporation, Condensation, Rain].
- Give every page in order, with its number as page. A page with no writing has an empty text.`;

const READING_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['page', 'text'],
      },
    },
  },
  required: ['pages'],
};

// Types Gemini accepts as image input. Of the types OpenAI reads, GIF is the
// one it does not.
const GEMINI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// Gemini takes at most 20 MB in one request, so the pages go a few at a time.
const BATCH_BYTES = 12 * 1024 * 1024;
const BATCH_PAGES = 8;

const pagesOf = (count) => `${count} page${count === 1 ? '' : 's'}`;

// "Hindi", "Hindi and English" or "Hindi, Sanskrit and English".
export function listed(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// What language a sitting's answers are in: 'english', 'not_english' or
// 'mixed', with the languages named. `paper` is the scanned question paper
// when it could have been filed the wrong way round with the response, and
// empty otherwise.
export async function answerLanguage({ paper, response }) {
  const raw = await requestJson({
    instructions: LANGUAGE_INSTRUCTIONS + (paper.length ? SWAP_RULE : ''),
    content: [
      ...(paper.length
        ? [{ type: 'input_text', text: `QUESTION PAPER (${pagesOf(paper.length)}):` }, ...(await pageInputs('QUESTION PAPER', paper))]
        : []),
      { type: 'input_text', text: `TEACHER'S RESPONSE (${pagesOf(response.length)}):` },
      ...(await pageInputs("TEACHER'S RESPONSE", response)),
    ],
    name: 'answer_language',
    schema: LANGUAGE_SCHEMA,
    task: 'check what language the answers are in',
    retry: 'Press Evaluate to try again.',
  });
  const languages = [...new Set((raw.languages ?? []).map((name) => String(name).trim()).filter(Boolean))];
  const english = languages.filter((name) => /^english$/i.test(name)).length;
  // Languages that disagree with the verdict mean the answers are mixed.
  let language = ['english', 'not_english', 'mixed'].includes(raw.language) ? raw.language : 'mixed';
  if (language === 'english' && languages.length > english) language = 'mixed';
  if (language === 'not_english' && english) language = 'mixed';
  return { language, languages, pages_swapped: paper.length > 0 && raw.pages_swapped === true };
}

// Gemini's reading of the answer pages: the text of each page, in order.
export async function readAnswers(files, languages) {
  const why = languages.length ? `The answers are in ${listed(languages)}, so` : 'The answers are not all in English, so';
  if (!geminiConfigured()) {
    throw friendly(`${why} Gemini reads them before OpenAI marks them, but the GEMINI_API_KEY secret is missing on the server. Add it on Fly, then press Evaluate again.`);
  }
  const unreadable = files.filter((file) => !GEMINI_IMAGE_TYPES.has(file.mime_type));
  if (unreadable.length) {
    throw friendly(`${why} Gemini reads them, and Gemini cannot read GIF pages. Re-upload these as JPG or PNG, then press Evaluate again: ${unreadable
      .map((file) => file.original_name)
      .join(', ')}.`);
  }

  const pages = await Promise.all(
    files.map(async (file, i) => {
      const where = path.join(UPLOADS_DIR, file.stored_name);
      return { number: i + 1, file, where, bytes: (await fs.stat(where)).size };
    })
  );
  const tooBig = pages.find((page) => page.bytes > BATCH_BYTES);
  if (tooBig) {
    throw friendly(`Page ${tooBig.number} of the answer paper (${tooBig.file.original_name}) is too large for Gemini to read. Scan it again at a lower resolution, or upload a smaller copy, then press Evaluate again.`);
  }
  const batches = [];
  for (const page of pages) {
    const batch = batches.at(-1);
    const bytes = batch?.reduce((total, p) => total + p.bytes, 0) ?? 0;
    if (batch && batch.length < BATCH_PAGES && bytes + page.bytes <= BATCH_BYTES) batch.push(page);
    else batches.push([page]);
  }

  const texts = [];
  for (const batch of batches) {
    const first = batch[0].number;
    const last = batch.at(-1).number;
    let raw;
    try {
      raw = await generateJson({
        prompt: `${READING_PROMPT}\n\n${first === last ? `This is page ${first}` : `These are pages ${first} to ${last}`} of ${pagesOf(pages.length)}.`,
        parts: await pageParts(batch),
        schema: READING_SCHEMA,
        timeoutMs: 5 * 60 * 1000,
        nothing: (reason) => `Gemini did not read the answer pages (${reason}). Press Evaluate to try again.`,
        garbled: 'Gemini sent back a reading of the answers that was cut off or garbled. Press Evaluate to try again.',
      });
    } catch (error) {
      if (error instanceof GeminiError) throw friendly(`Reading the answers with Gemini failed: ${error.message}`);
      throw error;
    }
    // Pages are matched by number, or in order if Gemini numbered them some
    // other way.
    const read = Array.isArray(raw?.pages) ? raw.pages : [];
    const byNumber = new Map(read.map((page) => [Number(page?.page), page]));
    const numbered = batch.some((page) => byNumber.has(page.number));
    batch.forEach((page, i) => {
      texts[page.number - 1] = String((numbered ? byNumber.get(page.number) : read[i])?.text ?? '').trim();
    });
  }
  if (!texts.some(Boolean)) {
    throw friendly('Gemini found no writing on the answer pages. Check they are the teacher’s answers and the right way up, then press Evaluate again.');
  }
  return texts;
}

// Each page in a batch, read from disk only when its batch is sent: its
// number, then the image.
async function pageParts(batch) {
  const parts = await Promise.all(
    batch.map(async (page) => [
      { text: `Page ${page.number}:` },
      { inlineData: { mimeType: page.file.mime_type, data: (await fs.readFile(page.where)).toString('base64') } },
    ])
  );
  return parts.flat();
}
