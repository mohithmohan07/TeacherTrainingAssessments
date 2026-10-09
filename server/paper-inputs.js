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
export async function readingInputs(texts, files = []) {
  const inputs = await Promise.all(
    texts.map(async (text, i) => {
      const label = `TEACHER'S RESPONSE, page ${i + 1} of ${texts.length}`;
      if (text !== null && text !== undefined) return [{ type: 'input_text', text: `${label}:\n${text || '(nothing written on this page)'}` }];
      if (!files[i]) return [{ type: 'input_text', text: `${label}:\n(this page could not be read)` }];
      return [{ type: 'input_text', text: `${label}, the scanned page, as it could not be read:` }, await imageInput(files[i])];
    })
  );
  return inputs.flat();
}

async function imageInput(file) {
  const data = await fs.readFile(path.join(UPLOADS_DIR, file.stored_name));
  return { type: 'input_image', image_url: `data:${file.mime_type};base64,${data.toString('base64')}`, detail: 'high' };
}
