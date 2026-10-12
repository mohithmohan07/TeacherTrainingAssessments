// A sitting's papers as OpenAI input, for the marking (evaluate.js) and for
// working out what should have been answered (answers.js). Papers confirmed
// from the library go as the PDFs themselves, each introduced with what it
// is; scanned pages go as images, each labelled with its group and number.
import fs from 'node:fs/promises';
import path from 'node:path';
import { UPLOADS_DIR } from './db.js';

// Types the OpenAI API accepts as image input. The scanner helper saves JPEG.
export const OPENAI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// The question paper: the library's PDFs, then any scanned pages.
export async function questionPaperInputs({ paper, library }) {
  return [
    ...(await libraryInputs(library)),
    ...(paper.length
      ? [
          { type: 'input_text', text: `QUESTION PAPER (${paper.length} scanned page${paper.length === 1 ? '' : 's'}):` },
          ...(await pageInputs('QUESTION PAPER', paper)),
        ]
      : []),
  ];
}

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
export async function pageInputs(group, files) {
  const pages = await Promise.all(files.map(imageInput));
  return pages.flatMap((page, i) => [{ type: 'input_text', text: `${group}, page ${i + 1} of ${files.length}:` }, page]);
}

// The teacher's answers as read (reading.js), page by page: what was read of
// each page, or the scanned page itself where it could not be read (its text
// is null).
export async function readingInputs(texts, files = [], details = []) {
  const inputs = await Promise.all(
    Array.from({ length: Math.max(texts.length, files.length) }, async (_, i) => {
      const text = typeof texts[i] === 'string' ? texts[i].trim() : '';
      const label = `TEACHER'S RESPONSE, page ${i + 1} of ${Math.max(texts.length, files.length)}`;
      const uncertain = details[i]?.needs_image || /\[\s*(?:illegible|unreadable|unclear)[^\]]*\]/iu.test(text);
      if (text && !uncertain) return [{ type: 'input_text', text: `${label}, extracted reading:\n${text}` }];
      const reading = text ? `Partial reading (verify against the image):\n${text}\n` : '';
      const reason = details[i]?.status === 'blank_unverified'
        ? 'Extraction reported a blank page, which has not been verified.'
        : 'Extraction is missing, empty or uncertain; this is not evidence that the teacher left the page unanswered.';
      if (!files[i]) return [{ type: 'input_text', text: `${label}:\n${reading}${reason} Source image unavailable. Flag for review; do not infer an unanswered page or deduct marks for extraction failure.` }];
      return [{ type: 'input_text', text: `${label}, source scan:\n${reading}${reason} Read the image, and flag unreadable handwriting for review rather than inventing text or treating it as blank.` }, await imageInput(files[i])];
    })
  );
  return inputs.flat();
}

async function imageInput(file) {
  const data = await fs.readFile(path.join(UPLOADS_DIR, file.stored_name));
  return { type: 'input_image', image_url: `data:${file.mime_type};base64,${data.toString('base64')}`, detail: 'high' };
}
