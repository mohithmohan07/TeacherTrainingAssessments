// Answer papers uploaded all at once, as PDFs, one teacher's answers in each.
// The PDFs say nothing about whose answers they are, which sections they
// cover or which question paper was sat, so each one is sorted before it is
// filed:
//   1. Its teacher comes from the file name, or else from the name written on
//      the sheets, which OpenAI reads while it checks the language of every
//      page.
//   2. Pages in a language other than English are read by Gemini first, in
//      their own script, as Evaluate does.
//   3. OpenAI compares the answers with the library papers that fit the
//      teacher, page by page, and says which section each page answers and
//      which paper each section was sat on. A section with no pages was not
//      sat.
// Nothing is filed until the review screen is confirmed, and filing never
// marks anything: only Evaluate does.
import fs from 'node:fs/promises';
import path from 'node:path';
import db, { UPLOADS_DIR } from './db.js';
import { friendly, openaiConfigured, requestJson } from './openai.js';
import { geminiConfigured } from './gemini.js';
import { readAnswers } from './reading.js';
import { OPENAI_IMAGE_TYPES, pageInputs } from './paper-inputs.js';
import { PAPER_SECTIONS, allPapers, presentPaper, rankPapers, setSittingPapers, teacherProfile } from './papers.js';
import { attachStoredPages, removeStoredFile } from './scans.js';
import { currentAssessmentFor } from './sittings.js';
import { MARKINGS, testFor } from './results.js';
import { startEvaluation } from './evaluate.js';

/* ------------------------------------------------------------- the rows */

const selectItem = db.prepare('SELECT * FROM bulk_items WHERE id = ?');
const selectItems = db.prepare('SELECT * FROM bulk_items WHERE school_id = ? AND test_id = ? ORDER BY id');
const selectPages = db.prepare('SELECT * FROM bulk_pages WHERE item_id = ? ORDER BY position, id');
const selectTeacher = db.prepare('SELECT * FROM teachers WHERE id = ?');
const selectSchool = db.prepare('SELECT * FROM schools WHERE id = ?');
const selectSchoolTeachers = db.prepare('SELECT * FROM teachers WHERE school_id = ? ORDER BY name COLLATE NOCASE');
const selectPaper = db.prepare('SELECT * FROM papers WHERE id = ?');

const insertItem = db.prepare(
  `INSERT INTO bulk_items (school_id, test_id, file_name, teacher_id, matched_by, sort_status)
   VALUES (@school_id, @test_id, @file_name, @teacher_id, @matched_by, 'waiting')`
);
const insertPage = db.prepare(
  `INSERT INTO bulk_pages (item_id, stored_name, mime_type, size_bytes, position)
   VALUES (@item_id, @stored_name, @mime_type, @size_bytes, @position)`
);
const setStatus = db.prepare('UPDATE bulk_items SET sort_status = ?, sort_error = ? WHERE id = ?');
const setTeacher = db.prepare('UPDATE bulk_items SET teacher_id = ?, matched_by = ? WHERE id = ?');
const setPapers = db.prepare('UPDATE bulk_items SET papers = ? WHERE id = ?');
const setResult = db.prepare('UPDATE bulk_items SET result = ? WHERE id = ?');
const setPageSort = db.prepare('UPDATE bulk_pages SET section = @section, questions = @questions WHERE id = @id');
const setPageLanguage = db.prepare('UPDATE bulk_pages SET language = ? WHERE id = ?');
const setPageSection = db.prepare('UPDATE bulk_pages SET section = ? WHERE id = ? AND item_id = ?');
const deleteItemRow = db.prepare('DELETE FROM bulk_items WHERE id = ?');

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/* ---------------------------------------------------- teacher from name */

// Words of a name or a file name, lower case: "Archana_B.M - answers.pdf" →
// archana, b, m, answers.
const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// Titles people put before a name, which say nothing about who it is.
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'sri', 'shri', 'kum', 'prof']);

function nearly(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // One letter added, left out or changed.
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

// How well a name matches some text: 2 when every word of the name longer
// than an initial is there, with its initials too; 1 when those words are
// there but not the initials; 0 otherwise.
export function nameMatch(name, text) {
  const have = words(text);
  const joined = have.join('');
  const parts = words(name).filter((w) => !TITLES.has(w));
  const full = parts.filter((w) => w.length > 2);
  const initials = parts.filter((w) => w.length <= 2);
  if (!full.length) return 0;
  if (!full.every((w) => have.some((h) => nearly(h, w)))) return 0;
  const initialsThere = initials.length && (initials.every((i) => have.includes(i)) || joined.includes(initials.join('')));
  return initialsThere ? 2 : 1;
}

// The one teacher a file name names, or null when it names none or several.
export function teacherFromFileName(fileName, teachers) {
  const scored = teachers.map((teacher) => ({ teacher, score: nameMatch(teacher.name, fileName) })).filter((m) => m.score);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((m) => m.score));
  const top = scored.filter((m) => m.score === best);
  return top.length === 1 ? top[0].teacher : null;
}

/* ------------------------------------------------------------- adding */

// Adds one PDF's pages, already made into pictures by the browser, and
// queues it for sorting.
export const addItem = (school, test, fileName, files) => {
  const teacher = teacherFromFileName(fileName, selectSchoolTeachers.all(school.id));
  const id = db.transaction(() => {
    const info = insertItem.run({
      school_id: school.id,
      test_id: test.id,
      file_name: fileName,
      teacher_id: teacher?.id ?? null,
      matched_by: teacher ? 'file' : null,
    });
    files.forEach((file, index) =>
      insertPage.run({ item_id: info.lastInsertRowid, stored_name: file.filename, mime_type: file.mimetype, size_bytes: file.size, position: index + 1 })
    );
    return info.lastInsertRowid;
  })();
  queueSort(id);
  return id;
};

export function removeItem(id) {
  const pages = selectPages.all(id);
  deleteItemRow.run(id);
  for (const page of pages) removeStoredFile(page.stored_name);
}

/* ------------------------------------------------------------ choosing */

// The teacher chosen on the review screen. A PDF that could not be sorted
// without knowing its teacher is sorted again once it has one.
export function chooseTeacher(item, teacherId) {
  const teacher = teacherId ? selectTeacher.get(teacherId) : null;
  if (teacherId && (!teacher || teacher.school_id !== item.school_id)) return 'Pick a teacher from this school.';
  setTeacher.run(teacher?.id ?? null, teacher ? 'you' : null, item.id);
  if (teacher && item.sort_status === 'needs_teacher') queueSort(item.id);
  return null;
}

export function choosePapers(item, papers) {
  const chosen = parse(item.papers, {});
  for (const key of PAPER_SECTIONS) {
    if (!(key in (papers ?? {}))) continue;
    const id = Number(papers[key]) || null;
    if (id) {
      const paper = selectPaper.get(id);
      if (!paper || !String(paper.sections).split(',').includes(key)) return `That paper has no Section ${key}. Choose a Section ${key} paper.`;
    }
    chosen[key] = id;
  }
  setPapers.run(JSON.stringify(chosen), item.id);
  return null;
}

// Moves pages between sections, or out of use (section null).
export function choosePageSections(item, pages) {
  for (const { id, section } of pages ?? []) {
    setPageSection.run(PAPER_SECTIONS.includes(section) ? section : null, Number(id), item.id);
  }
}

/* -------------------------------------------------------------- sorting */

// PDFs are sorted two at a time, in the order they were uploaded, so a big
// upload does not send every PDF to OpenAI at once.
const RUNNING_AT_ONCE = 2;
const waiting = [];
let running = 0;

export function queueSort(id) {
  setStatus.run('waiting', null, id);
  if (!waiting.includes(id)) waiting.push(id);
  pump();
}

function pump() {
  while (running < RUNNING_AT_ONCE && waiting.length) {
    const id = waiting.shift();
    running += 1;
    sortItem(id)
      .catch((error) => {
        console.error(`Sorting bulk PDF ${id} failed:`, error);
        if (selectItem.get(id)) setStatus.run('failed', error.userMessage ?? `Sorting failed: ${error.message}`, id);
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

// PDFs that were being sorted when the server stopped start again.
db.prepare("UPDATE bulk_items SET sort_status = 'waiting' WHERE sort_status = 'running'").run();
for (const { id } of db.prepare("SELECT id FROM bulk_items WHERE sort_status = 'waiting' ORDER BY id").all()) {
  waiting.push(id);
}
setImmediate(pump);

const LOOK_INSTRUCTIONS = `You are helping file a teacher's answers to a teacher training assessment. You are given every page of one PDF of answer sheets, scanned, usually handwritten, and the list of teachers at the school.

1. Teachers usually write their name at the top of the first sheet, sometimes on every sheet. In name_written, copy the teacher's name as written, or "" if no name is written. In teacher_id, give the id of the teacher in the list it names, allowing for initials, short forms, spelling slips and other scripts. Give 0 if no name is written or you are not sure which teacher it is.

2. For each page, say what language the teacher's writing on it is in: "english" when it is all in English, "other" when none of it is English (for example Kannada, Hindi or Sanskrit), "mixed" when it has both, even a word or a line. Judge the language, not the script: Hindi written in English letters is Hindi. Printed text, numbers and question labels such as "Q5 A" do not count. A page with no writing is "english". Name the languages in English in languages.`;

const LOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name_written', 'teacher_id', 'pages'],
  properties: {
    name_written: { type: 'string' },
    teacher_id: { type: 'integer' },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'language', 'languages'],
        properties: {
          page: { type: 'integer' },
          language: { type: 'string', enum: ['english', 'other', 'mixed'] },
          languages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const SORT_INSTRUCTIONS = `You are helping file a teacher's answers to a teacher training assessment. The assessment has up to three sections, each on its own question paper or sometimes two on one paper:
- Section A: communication skills.
- Section B: knowledge of the teacher's subject, child psychology and classroom management. Its papers differ by subject, school level, board and language (a Kannada or Hindi teacher's Section B paper is written in Kannada or Hindi).
- Section C: computer knowledge and digital teaching skills.
A teacher may have sat one, two or all three sections. Questions are usually numbered across the sections (often Section A Q1 to Q4, Section B Q5 to Q8, Section C Q9 to Q11), but some papers start again at Q1, so the numbers alone are not enough.

You are given candidate QUESTION PAPERS from the school's paper library, each with its id, then a CATALOGUE of every other paper in the library, then every page of ONE TEACHER'S ANSWER SHEETS from one PDF, in order. The answer sheets do not say which section or which question paper they answer. Pages a teacher wrote in a language other than English come with a reading of the handwriting in that language; the reading may have mistakes, so check it against the picture.

Work out, by matching the answers against the questions:
- For every page, the section it answers ("A", "B" or "C"), and the question labels answered on it, as printed on the paper ("5A", "5B", "9"). Use "none" only for a page with no answers at all, such as a blank page or a cover sheet.
- For every section, whether the teacher sat it, and the id of the question paper they answered. A section with no pages was not sat: give paper_id 0.

How to match:
- Compare what each answer talks about with what each question asks: the situation in a case study, the names of children, subjects, tools and terms. An answer about a phishing email answers the Section C question about it; an answer about calming an anxious child in a maths class answers that Section B question.
- Handwriting can be hard to read. When a word cannot be read, use the words and lines around it, and the question the previous answer was for, to work out which question comes next. Answers usually follow the order of the questions, and a page that carries on the previous page's answer is in the same section.
- A teacher may write one section in English and another in Kannada, Hindi or another language. Match each section on its own, and choose the paper in the language its answers are in.
- Prefer a candidate paper. Choose another paper from the catalogue only when no candidate fits and the catalogue clearly names the right one.
- Set confidence to "high" when the answers plainly match the paper's questions, "medium" when most do, and "low" when you are guessing. In reason, say briefly in plain English what matched, for example "Answers mention the phishing email and file folders in Q9 and Q10."`;

const SORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages', 'sections'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'section', 'questions'],
        properties: {
          page: { type: 'integer' },
          section: { type: 'string', enum: ['A', 'B', 'C', 'none'] },
          questions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'sat', 'paper_id', 'confidence', 'reason'],
        properties: {
          section: { type: 'string', enum: ['A', 'B', 'C'] },
          sat: { type: 'boolean' },
          paper_id: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

// The candidate papers for each section: the few that fit the teacher best,
// with every paper in the teacher's other languages' versions in reach
// through the catalogue.
const CANDIDATES_PER_SECTION = 4;

export function candidatePapers(teacher, school, papers) {
  const profile = teacherProfile(teacher, school);
  const chosen = new Map();
  for (const key of PAPER_SECTIONS) {
    const { ranked } = rankPapers(papers, profile, key);
    const fitting = ranked.filter((r) => r.score > 0);
    for (const { paper } of (fitting.length ? fitting : ranked).slice(0, CANDIDATES_PER_SECTION)) chosen.set(paper.id, paper);
  }
  return [...chosen.values()];
}

const pagesOf = (count) => `${count} page${count === 1 ? '' : 's'}`;

const describe = (paper) =>
  [
    `id ${paper.id}`,
    `"${paper.title}"`,
    `Section${paper.sections.includes(',') ? 's' : ''} ${paper.sections.split(',').join(' and ')}`,
    paper.subject,
    paper.levels,
    paper.board,
    paper.language,
  ].filter(Boolean).join(', ');

async function sortItem(id) {
  let item = selectItem.get(id);
  if (!item) return;
  setStatus.run('running', null, id);
  const pages = selectPages.all(id);

  if (!openaiConfigured()) {
    throw friendly('OpenAI is not set up on the server (the OPENAI_API_KEY secret is missing), so these pages cannot be sorted automatically. Choose the teacher, sections and papers yourself.');
  }
  const unreadable = pages.filter((page) => !OPENAI_IMAGE_TYPES.has(page.mime_type));
  if (unreadable.length) throw friendly('Some pages are in a picture format OpenAI cannot read. Remove this PDF and upload it again.');

  const school = selectSchool.get(item.school_id);
  const teachers = selectSchoolTeachers.all(item.school_id);
  const files = pages.map((page) => ({ ...page, original_name: `${item.file_name} page ${page.position}` }));

  // 1. Whose answers, and the language of each page.
  const look = await requestJson({
    instructions: LOOK_INSTRUCTIONS,
    content: [
      {
        type: 'input_text',
        text: `TEACHERS AT THE SCHOOL:\n${teachers.map((t) => `id ${t.id}: ${t.name}${t.grade ? ` (${t.grade}${t.subjects ? `, ${t.subjects}` : ''})` : ''}`).join('\n')}`,
      },
      { type: 'input_text', text: `ANSWER SHEETS (${pagesOf(pages.length)}), from the file "${item.file_name}":` },
      ...(await pageInputs('ANSWER SHEETS', files)),
    ],
    name: 'answer_sheets_first_look',
    schema: LOOK_SCHEMA,
    task: 'read the name and languages on these answer sheets',
    retry: 'Press Sort again to try again.',
  });

  const written = String(look.name_written ?? '').trim();
  const fromSheet = teachers.find((t) => t.id === Number(look.teacher_id)) ?? null;
  item = selectItem.get(id);
  if (!item) return;
  if (!item.teacher_id && fromSheet) {
    setTeacher.run(fromSheet.id, 'sheet', id);
    item = selectItem.get(id);
  }
  const byNumber = new Map((look.pages ?? []).map((p) => [Number(p.page), p]));
  const languages = new Set();
  pages.forEach((page, i) => {
    const seen = byNumber.get(i + 1);
    const language = ['english', 'other', 'mixed'].includes(seen?.language) ? seen.language : 'english';
    for (const name of seen?.languages ?? []) if (String(name).trim()) languages.add(String(name).trim());
    files[i].language = language;
    setPageLanguage.run(language, page.id);
  });
  const result = {
    name_written: written,
    sheet_teacher_id: fromSheet?.id ?? null,
    languages: [...languages],
    read_by_gemini: 0,
    notes: [],
    sections: {},
  };
  setResult.run(JSON.stringify(result), id);

  const teacher = item.teacher_id ? selectTeacher.get(item.teacher_id) : null;
  if (!teacher) {
    setStatus.run(
      'needs_teacher',
      written
        ? `The name written on the sheets, “${written}”, matches no teacher at this school. Choose the teacher, and the pages are sorted then.`
        : 'No name is written on the sheets and the file name matches no teacher. Choose the teacher, and the pages are sorted then.',
      id
    );
    return;
  }

  // 2. Pages not all in English are read by Gemini first, as Evaluate does.
  const notEnglish = files.filter((page) => page.language !== 'english');
  const readings = new Map();
  if (notEnglish.length) {
    const names = [...languages].filter((name) => !/^english$/i.test(name));
    if (!geminiConfigured()) {
      result.notes.push('Some pages are not in English, and Gemini is not set up to read them, so OpenAI matched them from the pictures alone.');
    } else {
      try {
        const texts = await readAnswers(notEnglish, names);
        notEnglish.forEach((page, i) => readings.set(page.id, texts[i]));
        result.read_by_gemini = notEnglish.length;
      } catch (error) {
        result.notes.push(`Gemini could not read the pages that are not in English (${error.userMessage ?? error.message}), so OpenAI matched them from the pictures alone.`);
      }
    }
  }

  // 3. Which section each page answers, and which paper each section was sat on.
  const library = allPapers();
  const candidates = candidatePapers(teacher, school, library);
  if (!candidates.length) throw friendly('The paper library has no papers yet. Import the paper pack on the Paper library page, then press Sort again.');
  const candidateIds = new Set(candidates.map((p) => p.id));
  const catalogue = library.filter((p) => !candidateIds.has(p.id));

  const paperInputs = await Promise.all(
    candidates.map(async (paper) => {
      const data = await fs.readFile(path.join(UPLOADS_DIR, paper.stored_name));
      return [
        { type: 'input_text', text: `QUESTION PAPER ${describe(paper)}. It is a PDF:` },
        { type: 'input_file', filename: `paper-${paper.id}.pdf`, file_data: `data:application/pdf;base64,${data.toString('base64')}` },
      ];
    })
  );
  const pageContent = await Promise.all(
    files.map(async (page, i) => {
      const [, picture] = await pageInputs('ANSWER SHEETS', [page]);
      const reading = readings.get(page.id);
      return [
        { type: 'input_text', text: `ANSWER SHEETS, page ${i + 1} of ${files.length}:` },
        picture,
        reading !== undefined ? { type: 'input_text', text: `Reading of page ${i + 1} (in the teacher's own language):\n${reading || '(nothing written)'}` } : null,
      ].filter(Boolean);
    })
  );

  const sorted = await requestJson({
    instructions: SORT_INSTRUCTIONS,
    content: [
      { type: 'input_text', text: `THE TEACHER: ${teacher.name}${teacher.grade ? `, teaches ${teacher.grade}` : ''}${teacher.subjects ? `, subjects ${teacher.subjects}` : ''}. School: ${school.name}.` },
      { type: 'input_text', text: `CANDIDATE QUESTION PAPERS (${candidates.length}):` },
      ...paperInputs.flat(),
      { type: 'input_text', text: `CATALOGUE of the other papers in the library:\n${catalogue.map(describe).join('\n') || '(none)'}` },
      { type: 'input_text', text: `ONE TEACHER'S ANSWER SHEETS (${pagesOf(files.length)}):` },
      ...pageContent.flat(),
    ],
    name: 'answer_sheets_sorted',
    schema: SORT_SCHEMA,
    task: 'match these answer sheets to the question papers',
    retry: 'Press Sort again to try again.',
  });

  if (!selectItem.get(id)) return; // removed while it was being sorted
  saveSort(id, teacher, school, library, pages, sorted, result);
}

// What the sorting found, checked: page sections as given, and for every
// section with pages a paper that holds that section, falling back to the
// library's best fit for the teacher when the one named does not.
const saveSort = db.transaction((id, teacher, school, library, pages, sorted, result) => {
  const byNumber = new Map((sorted.pages ?? []).map((p) => [Number(p.page), p]));
  const used = new Set();
  pages.forEach((page, i) => {
    const found = byNumber.get(i + 1);
    const section = PAPER_SECTIONS.includes(found?.section) ? found.section : null;
    if (section) used.add(section);
    setPageSort.run({
      id: page.id,
      section,
      questions: (found?.questions ?? []).map((q) => String(q).trim()).filter(Boolean).join(', '),
    });
  });

  const profile = teacherProfile(teacher, school);
  const papers = {};
  for (const key of PAPER_SECTIONS) {
    const said = (sorted.sections ?? []).find((s) => s.section === key);
    if (!used.has(key)) {
      papers[key] = null;
      continue;
    }
    const named = said?.paper_id ? library.find((p) => p.id === Number(said.paper_id)) : null;
    const fits = named && String(named.sections).split(',').includes(key);
    const fallback = fits ? null : rankPapers(library, profile, key).suggested;
    papers[key] = fits ? named.id : fallback?.id ?? null;
    result.sections[key] = {
      confidence: fits ? (['high', 'medium', 'low'].includes(said.confidence) ? said.confidence : 'low') : 'low',
      reason: fits
        ? String(said.reason ?? '').trim()
        : fallback
          ? 'The answers did not clearly match a paper, so this is the library’s best fit for the teacher. Check it.'
          : 'The answers did not clearly match a paper. Choose it.',
    };
  }
  setPapers.run(JSON.stringify(papers), id);
  setResult.run(JSON.stringify(result), id);
  setStatus.run('done', null, id);
});

/* ------------------------------------------------------------ presenting */

const selectSitting = db.prepare(
  `SELECT a.*, (SELECT COUNT(*) FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'response') AS response_count
     FROM assessments a WHERE a.teacher_id = ? AND a.test_id = ? AND a.section IS ? ORDER BY a.id DESC LIMIT 1`
);

// One PDF as the review screen shows it: its teacher, its pages, the paper
// for each section, and what stops it being filed or is worth knowing first.
export function presentItem(item, others = []) {
  const pages = selectPages.all(item.id);
  const result = parse(item.result, null);
  const chosen = parse(item.papers, {});
  const teacher = item.teacher_id ? selectTeacher.get(item.teacher_id) : null;
  const sections = PAPER_SECTIONS.map((key) => {
    const count = pages.filter((p) => p.section === key).length;
    const paper = chosen[key] ? selectPaper.get(chosen[key]) : null;
    const sitting = teacher && count ? selectSitting.get(teacher.id, item.test_id, key) : null;
    return {
      key,
      pages: count,
      paper: paper ? presentPaper(paper) : null,
      confidence: result?.sections?.[key]?.confidence ?? null,
      reason: result?.sections?.[key]?.reason ?? '',
      // What filing does to the teacher's sitting for this section.
      existing: sitting
        ? sitting.status === 'evaluated'
          ? 'marked'
          : sitting.ai_status === 'running'
            ? 'marking'
            : sitting.response_count
              ? 'has_pages'
              : null
        : null,
      existing_pages: sitting?.response_count ?? 0,
    };
  });

  const problems = [];
  const sorting = ['waiting', 'running'].includes(item.sort_status);
  if (sorting) problems.push('Still being sorted.');
  if (!teacher) problems.push('Choose the teacher.');
  if (!pages.some((p) => p.section)) problems.push(sorting ? '' : 'Put at least one page in Section A, B or C.');
  for (const s of sections) {
    if (s.pages && !s.paper) problems.push(`Choose the Section ${s.key} question paper.`);
    if (s.existing === 'marking') problems.push(`${teacher.name}’s Section ${s.key} is being marked. Wait for it to finish.`);
  }

  const notes = [];
  if (result?.name_written && item.matched_by === 'file' && result.sheet_teacher_id && result.sheet_teacher_id !== item.teacher_id) {
    notes.push(`The file name says ${teacher?.name}, but the sheets say “${result.name_written}”. Check the teacher.`);
  }
  if (teacher && others.some((o) => o.id !== item.id && o.teacher_id === teacher.id)) {
    notes.push(`Another PDF here is also for ${teacher.name}. Both are filed under them if you keep both.`);
  }
  for (const s of sections) {
    if (s.existing === 'has_pages') notes.push(`${teacher.name} already has ${pagesOf(s.existing_pages)} of Section ${s.key} answers. These go after them.`);
    if (s.existing === 'marked') notes.push(`${teacher.name}’s Section ${s.key} is already marked. These pages start a new Section ${s.key} sitting in this test.`);
  }
  notes.push(...(result?.notes ?? []));

  return {
    id: item.id,
    file_name: item.file_name,
    teacher: teacher ? { id: teacher.id, name: teacher.name, grade: teacher.grade, subjects: teacher.subjects } : null,
    matched_by: item.matched_by,
    name_written: result?.name_written ?? '',
    languages: result?.languages ?? [],
    read_by_gemini: result?.read_by_gemini ?? 0,
    sort_status: item.sort_status,
    sort_error: item.sort_error,
    pages: pages.map((p) => ({ id: p.id, src: `/uploads/${p.stored_name}`, position: p.position, section: p.section, questions: p.questions, language: p.language })),
    sections,
    problems: problems.filter(Boolean),
    notes,
    ready: !problems.filter(Boolean).length,
  };
}

export function presentItems(schoolId, testId) {
  const items = selectItems.all(schoolId, testId);
  return items.map((item) => presentItem(item, items));
}

export function itemFor(id) {
  return selectItem.get(Number(id)) ?? null;
}

/* --------------------------------------------------------------- filing */

// Files every ready PDF of the test: each section's pages become the answer
// paper of the teacher's current sitting for that section, with the chosen
// question paper. Pages left out of every section are deleted. Nothing is
// marked. Returns what was filed and what was left for later.
export function fileReady(schoolId, testId, onlyIds = null) {
  const test = testFor(schoolId, testId);
  const all = presentItems(schoolId, test.id);
  const filed = [];
  const left = [];
  for (const shown of all) {
    if (onlyIds && !onlyIds.includes(shown.id)) continue;
    if (!shown.ready) {
      left.push({ id: shown.id, file_name: shown.file_name, problems: shown.problems });
      continue;
    }
    filed.push(...fileItem(selectItem.get(shown.id), test));
  }
  return { filed, left };
}

const fileItem = (item, test) => {
  const teacher = selectTeacher.get(item.teacher_id);
  const pages = selectPages.all(item.id);
  const chosen = parse(item.papers, {});
  const unused = pages.filter((p) => !p.section);
  const sittings = db.transaction(() => {
    const done = [];
    for (const key of PAPER_SECTIONS) {
      const mine = pages.filter((p) => p.section === key);
      if (!mine.length) continue;
      const sitting = currentAssessmentFor(teacher, test, key);
      attachStoredPages(
        sitting.id,
        'response',
        mine.map((page, i) => ({
          stored_name: page.stored_name,
          original_name: `${teacher.name} - answer paper - Section ${key} - p${i + 1}.jpg`,
          mime_type: page.mime_type,
          size_bytes: page.size_bytes,
        }))
      );
      setSittingPapers(sitting.id, [chosen[key]]);
      done.push({ teacher: { id: teacher.id, name: teacher.name }, section: key, pages: mine.length, assessment_id: sitting.id });
    }
    // The pages now belong to the sittings, so only the rows go.
    deleteItemRow.run(item.id);
    return done;
  })();
  for (const page of unused) removeStoredFile(page.stored_name);
  return sittings;
};

/* ----------------------------------------------------------- evaluating */

// Evaluate pressed once for every sitting just filed. It is still Evaluate:
// nothing is marked without it. The sittings are marked two at a time, each
// as if its own Evaluate had been pressed, so a school's worth of papers does
// not go to OpenAI at once.
const MARKING_AT_ONCE = 2;
const toMark = [];
let marking = 0;
const selectMarkState = db.prepare('SELECT ai_status FROM assessments WHERE id = ?');

export function evaluateSittings(ids, markingChoice) {
  if (!MARKINGS.some((m) => m.key === markingChoice)) return 'Choose Standard or Lenient marking.';
  if (!openaiConfigured()) return 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.';
  for (const id of ids) if (!toMark.some((job) => job.id === id)) toMark.push({ id, marking: markingChoice });
  markNext();
  return null;
}

function markNext() {
  while (marking < MARKING_AT_ONCE && toMark.length) {
    const job = toMark.shift();
    marking += 1;
    markOne(job).finally(() => {
      marking -= 1;
      markNext();
    });
  }
}

async function markOne({ id, marking: choice }) {
  const problem = startEvaluation(id, choice);
  if (problem) {
    db.prepare(`UPDATE assessments SET ai_status = 'failed', ai_error = ?, updated_at = datetime('now') WHERE id = ?`).run(problem, id);
    return;
  }
  // Waits for the marking to finish before the next one starts.
  while (selectMarkState.get(id)?.ai_status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export function markingState(ids) {
  return ids.map((id) => {
    const row = db.prepare('SELECT id, ai_status, ai_error, status FROM assessments WHERE id = ?').get(id);
    const queued = toMark.some((job) => job.id === id);
    return row ? { id, state: queued ? 'queued' : row.ai_status, error: row.ai_error } : { id, state: 'gone' };
  });
}
