// The question paper library. Papers are kept once, as PDFs, with labels: the
// sections they hold, the subject (Section B only), the school levels and the
// board they were written for, and the language. From those labels the board
// suggests the paper a teacher most likely sat, and asks for it to be
// confirmed before it is used. Nothing here is marked or sent anywhere.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import db, { UPLOADS_DIR } from './db.js';
import { LEVELS } from './paper-formats.js';
import { removeStoredFile } from './scans.js';

export const PAPER_SECTIONS = ['A', 'B', 'C'];
export const LEVEL_KEYS = Object.keys(LEVELS);

const list = (text) => String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean);

// A paper as the pages see it: its labels as arrays, and where its file is.
export function presentPaper(row) {
  if (!row) return row;
  return {
    ...row,
    sections: list(row.sections),
    levels: list(row.levels),
    level_names: list(row.levels).map((key) => LEVELS[key]?.name ?? key),
  };
}

export function paperLabelsFrom(body) {
  const sections = [...new Set(arrayOf(body.sections).map((s) => String(s).trim().toUpperCase()))].filter((s) => PAPER_SECTIONS.includes(s)).sort();
  const levels = [...new Set(arrayOf(body.levels).map((l) => String(l).trim()))].filter((l) => LEVEL_KEYS.includes(l));
  const marks = String(body.total_marks ?? '').trim();
  return {
    title: String(body.title ?? '').trim(),
    sections: sections.join(','),
    subject: String(body.subject ?? '').trim(),
    levels: LEVEL_KEYS.filter((key) => levels.includes(key)).join(','),
    board: String(body.board ?? '').trim(),
    language: String(body.language ?? '').trim(),
    total_marks: marks !== '' && Number.isFinite(Number(marks)) ? Number(marks) : null,
    notes: String(body.notes ?? '').trim(),
    priority: Number.isInteger(Number(body.priority)) ? Number(body.priority) : 0,
  };
}

// Form posts send one value as a string and several as an array; JSON sends
// arrays; a comma-separated string works too.
function arrayOf(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',');
}

/* -------------------------------------------------------------- matching */

// Subjects under the names schools write them. The first name is the one the
// library uses; any of them on a teacher's record counts.
const SUBJECTS = [
  ['mathematics', 'maths', 'math', 'mathematics', 'arithmetic'],
  ['science', 'science', 'general science'],
  ['physics', 'physics'],
  ['chemistry', 'chemistry'],
  ['biology', 'biology', 'life science', 'botany', 'zoology'],
  ['english', 'english'],
  ['hindi', 'hindi'],
  ['kannada', 'kannada'],
  ['sanskrit', 'sanskrit'],
  ['social science', 'social science', 'social sciences', 'social studies', 'social', 'sst', 'history', 'geography', 'civics', 'political science'],
  ['computer science', 'computer science', 'computer', 'computers', 'computer applications', 'computer application', 'cs', 'ict', 'it', 'information technology'],
  ['evs', 'evs', 'environmental studies', 'environmental science', 'environment'],
  ['economics', 'economics'],
  ['accountancy', 'accountancy', 'accounts', 'accounting'],
  ['business studies', 'business studies', 'business', 'commerce'],
  ['statistics', 'statistics', 'stats'],
  ['electronics', 'electronics'],
  ['arts & craft', 'arts & craft', 'arts and craft', 'art & craft', 'art and craft', 'art', 'arts', 'craft', 'drawing', 'painting', 'fine arts'],
  ['music', 'music', 'vocal music', 'instrumental music'],
  ['dance', 'dance', 'classical dance', 'bharatanatyam'],
  ['physical education', 'physical education', 'pe', 'p e', 'pt', 'sports', 'games'],
];
const SUBJECT_BY_NAME = new Map(SUBJECTS.flatMap(([key, ...names]) => names.map((name) => [name, key])));
const SCIENCES = new Set(['physics', 'chemistry', 'biology']);

const plain = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9&+ ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Names longest first, so "computer science" is read before "science".
const SUBJECT_NAMES = [...SUBJECT_BY_NAME.keys()].sort((a, b) => b.length - a.length);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');

// "Maths, Science" → {mathematics, science}. "Physics/Chemistry" and
// "Computer Science (ICSE)" work too.
export function subjectKeys(text) {
  const keys = new Set();
  for (const part of String(text ?? '').split(/[,;/|]/)) {
    let name = plain(part);
    if (!name) continue;
    if (SUBJECT_BY_NAME.has(name)) {
      keys.add(SUBJECT_BY_NAME.get(name));
      continue;
    }
    // Look for known names inside, longest first, taking each out once found.
    // Two-letter ones ("cs", "pe", "it") only count on their own, above.
    for (const known of SUBJECT_NAMES) {
      if (known.length <= 2) continue;
      const pattern = new RegExp(`(^| )${escape(known)}( |$)`);
      if (pattern.test(name)) {
        keys.add(SUBJECT_BY_NAME.get(known));
        name = name.replace(pattern, ' ').trim();
      }
    }
  }
  return keys;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

function levelForClass(n) {
  if (n >= 1 && n <= 5) return 'primary';
  if (n >= 6 && n <= 8) return 'middle-school';
  if (n === 9 || n === 10) return 'secondary';
  if (n === 11 || n === 12) return 'senior-secondary';
  return null;
}

// The school levels a teacher teaches, read from what was typed as their
// grade: "Grade 5", "Classes 9-10", "VI to VIII", "II PUC", "Pre-primary".
export function levelsFromText(text) {
  // Lower case, words and numbers only, with ranges kept as " - ".
  let t = ` ${String(text ?? '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()} `
    .replace(/ pre(?: - | )?primary /g, ' preprimary ')
    .replace(/ pre(?: - | )?university /g, ' preuniversity ');
  const levels = new Set();
  if (/ (preprimary|nursery|lkg|ukg|kg|kindergarten|montessori|playgroup|play group) /.test(t)) levels.add('pre-primary');
  if (/ (pu|puc|preuniversity|junior college|isc|senior secondary|higher secondary) /.test(t)) levels.add('senior-secondary');
  if (/ primary /.test(t)) levels.add('primary');
  if (/ middle /.test(t)) levels.add('middle-school');
  if (/ (high|highschool) /.test(t) || / secondary /.test(t.replace(/ (senior|higher) secondary /g, ' '))) levels.add('secondary');

  // "I PUC", "2nd year PU": the year of PU, not a class; "KG 2" likewise.
  t = t.replace(/ (i|ii|1|2|1st|2nd|first|second) (year )?(pu|puc) /g, ' pu ').replace(/ (kg|lkg|ukg|nursery) (1|2|i|ii) /g, ' $1 ');

  // Class numbers and ranges: "5", "9 - 10", "6 to 8". Roman numerals only
  // after "class", "grade" or "std", or in a range, since "I" and "V" are
  // also words and initials.
  const numbers = [];
  for (const match of t.matchAll(/ (\d{1,2})(?:st|nd|rd|th)?(?= )/g)) numbers.push(Number(match[1]));
  const classWord = / (class|classes|grade|grades|std|standard|stds)\b/.test(t) || /^( (i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|and|-|to))+ $/.test(t);
  for (const match of t.matchAll(/ (i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)(?= )/g)) {
    const around = `${t.slice(Math.max(0, match.index - 4), match.index)}|${t.slice(match.index + match[0].length, match.index + match[0].length + 4)}`;
    if (classWord || / (-|to)\|/.test(around) || /\| (-|to) /.test(around)) numbers.push(ROMAN[match[1]]);
  }
  for (const range of t.matchAll(/ (\d{1,2}|[ivx]+) (?:-|to) (\d{1,2}|[ivx]+)(?= )/g)) {
    const a = Number(range[1]) || ROMAN[range[1]];
    const b = Number(range[2]) || ROMAN[range[2]];
    if (a && b && a < b && b <= 12) for (let n = a; n <= b; n += 1) numbers.push(n);
  }
  for (const n of numbers) {
    const level = levelForClass(n);
    if (level) levels.add(level);
  }
  return levels;
}

export function boardFromText(text) {
  const t = ` ${plain(text)} `;
  if (/\bcbse\b/.test(t)) return 'CBSE';
  if (/\b(icse|isc)\b/.test(t)) return 'ICSE';
  if (/\b(pu|puc|pre ?university)\b/.test(t)) return 'Karnataka Pre-University';
  if (/\b(state|karnataka|kseeb|sslc)\b/.test(t)) return 'Karnataka State';
  return '';
}

// What the board knows about a teacher, for matching papers to them.
export function teacherProfile(teacher, school) {
  const text = `${teacher.grade ?? ''} ${teacher.subjects ?? ''}`;
  let levels = levelsFromText(teacher.grade);
  if (!levels.size) levels = levelsFromText(text);
  return {
    levels,
    subjects: subjectKeys(teacher.subjects),
    board: boardFromText(text) || boardFromText(school?.name ?? ''),
  };
}

// How well a paper fits a teacher for one section. Higher is better; below
// zero means it plainly does not fit. The parts are kept so the page can say
// why a paper was suggested.
export function scorePaper(paper, profile, section) {
  const levels = list(paper.levels);
  const subject = paper.subject ? subjectKeys(paper.subject) : new Set();
  let score = 0;
  const reasons = [];

  if (!levels.length) {
    score += 1;
  } else if (profile.levels.size) {
    if (levels.some((level) => profile.levels.has(level))) {
      score += 4;
      reasons.push('level');
    } else {
      score -= 4;
    }
  }

  if (section === 'B') {
    if (!subject.size) {
      score += 1;
    } else if (profile.subjects.size) {
      if ([...subject].some((key) => profile.subjects.has(key))) {
        score += 6;
        reasons.push('subject');
      } else if (subject.has('science') && [...profile.subjects].some((key) => SCIENCES.has(key))) {
        score += 3;
        reasons.push('subject');
      } else {
        score -= 6;
      }
    }
  }

  if (profile.board && paper.board) {
    if (paper.board === profile.board) {
      score += 2;
      reasons.push('board');
    } else {
      score -= 1;
    }
  }

  score += (Number(paper.priority) || 0) * 0.25;
  return { score, reasons };
}

const selectPapers = db.prepare('SELECT * FROM papers ORDER BY title COLLATE NOCASE, id');

export function allPapers() {
  return selectPapers.all();
}

// The library's papers for one section, best fit first, each with its score.
// `suggested` is the best one when it fits at all.
export function rankPapers(papers, profile, section) {
  const ranked = papers
    .filter((paper) => list(paper.sections).includes(section))
    .map((paper) => ({ paper, ...scorePaper(paper, profile, section) }))
    .sort((a, b) => b.score - a.score || a.paper.title.localeCompare(b.paper.title));
  return { ranked, suggested: ranked[0] && ranked[0].score > 0 ? ranked[0].paper : null };
}

// The best set of papers for a full paper: one for each section, where a paper
// holding two sections (such as A and C together) covers both. Each section's
// few best fits are tried in every combination, and the set that fits best in
// total wins, so a two-section paper is not suggested beside another paper for
// one of its sections. Returns a Map of section to paper, or to null where
// nothing fits.
export function fullPaperPlan(papers, profile) {
  const candidates = new Map(
    PAPER_SECTIONS.map((key) => [key, rankPapers(papers, profile, key).ranked.filter((r) => r.score > 0).slice(0, 5)])
  );
  const scoreFor = (paper, key) => candidates.get(key).find((r) => r.paper.id === paper.id)?.score ?? 0;

  let best = { total: 0, count: 0, plan: new Map(PAPER_SECTIONS.map((key) => [key, null])) };
  const walk = (index, plan) => {
    if (index === PAPER_SECTIONS.length) {
      const used = new Set([...plan.values()].filter(Boolean));
      const total = [...plan].reduce((sum, [key, paper]) => sum + (paper ? scoreFor(paper, key) : 0), 0);
      if (total > best.total || (total === best.total && used.size < best.count)) best = { total, count: used.size, plan: new Map(plan) };
      return;
    }
    const key = PAPER_SECTIONS[index];
    if (plan.has(key)) return walk(index + 1, plan); // covered by an earlier paper
    walk(index + 1, new Map([...plan, [key, null]]));
    for (const { paper } of candidates.get(key)) {
      const holds = list(paper.sections);
      // A paper can only take sections still open.
      if (holds.some((s) => s !== key && plan.has(s))) continue;
      const next = new Map(plan);
      for (const s of holds) if (PAPER_SECTIONS.includes(s)) next.set(s, paper);
      walk(index + 1, next);
    }
  };
  walk(0, new Map());
  return best.plan;
}

// Suggestions for a teacher's row: one paper for a section on its own, or the
// best set for the full paper.
export function suggestPapers(papers, profile, section) {
  if (section) {
    const { suggested } = rankPapers(papers, profile, section);
    return suggested ? [suggested] : [];
  }
  return [...new Set([...fullPaperPlan(papers, profile).values()].filter(Boolean))];
}

/* ---------------------------------------------------- papers on a sitting */

const selectSittingPapers = db.prepare(
  `SELECT p.* FROM assessment_papers ap JOIN papers p ON p.id = ap.paper_id
    WHERE ap.assessment_id = ? ORDER BY ap.position, p.id`
);

export function sittingPapers(assessmentId) {
  return selectSittingPapers.all(assessmentId);
}

const deleteSittingPapers = db.prepare('DELETE FROM assessment_papers WHERE assessment_id = ?');
const insertSittingPaper = db.prepare('INSERT INTO assessment_papers (assessment_id, paper_id, position) VALUES (?, ?, ?)');

export const setSittingPapers = db.transaction((assessmentId, paperIds) => {
  deleteSittingPapers.run(assessmentId);
  [...new Set(paperIds)].forEach((paperId, index) => insertSittingPaper.run(assessmentId, paperId, index));
});

/* ---------------------------------------------------------------- storing */

function randomName(ext) {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

export function checksumOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const insertPaper = db.prepare(
  `INSERT INTO papers (title, sections, subject, levels, board, language, total_marks, notes, priority,
                       stored_name, original_name, size_bytes, preview_name, checksum)
   VALUES (@title, @sections, @subject, @levels, @board, @language, @total_marks, @notes, @priority,
           @stored_name, @original_name, @size_bytes, @preview_name, @checksum)`
);
const selectByChecksum = db.prepare('SELECT * FROM papers WHERE checksum = ?');

// Adds one paper, unless the same file is already in the library. Returns the
// new row, or null with the existing one when it was already there.
export function addPaper(labels, { pdf, originalName, preview }) {
  const checksum = checksumOf(pdf);
  const existing = selectByChecksum.get(checksum);
  if (existing) return { paper: existing, added: false };

  const storedName = randomName('.pdf');
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), pdf);
  let previewName = null;
  if (preview) {
    previewName = randomName(preview.ext);
    fs.writeFileSync(path.join(UPLOADS_DIR, previewName), preview.data);
  }
  try {
    const info = insertPaper.run({
      ...labels,
      stored_name: storedName,
      original_name: originalName,
      size_bytes: pdf.length,
      preview_name: previewName,
      checksum,
    });
    return { paper: db.prepare('SELECT * FROM papers WHERE id = ?').get(info.lastInsertRowid), added: true };
  } catch (error) {
    removeStoredFile(storedName);
    removeStoredFile(previewName);
    throw error;
  }
}

export function isPdf(buffer) {
  return buffer.length > 4 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

const PREVIEW_TYPES = { '.png': [0x89, 0x50, 0x4e, 0x47], '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff], '.webp': [0x52, 0x49, 0x46, 0x46] };

function previewFrom(name, data) {
  const ext = path.extname(name).toLowerCase();
  const magic = PREVIEW_TYPES[ext];
  if (!magic || !magic.every((byte, i) => data[i] === byte)) return null;
  return { ext: ext === '.jpeg' ? '.jpg' : ext, data };
}

// A paper pack is a zip with manifest.json listing each paper's file, its
// labels and an optional first-page preview image. Importing it twice adds
// nothing the second time.
export async function importPack(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw Object.assign(new Error('That file is not a zip. Choose the paper pack .zip file.'), { status: 400 });
  }
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw Object.assign(new Error('This zip has no manifest.json, so it is not a paper pack.'), { status: 400 });

  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.async('string'));
  } catch {
    throw Object.assign(new Error('The pack’s manifest.json could not be read.'), { status: 400 });
  }
  const entries = Array.isArray(manifest?.papers) ? manifest.papers : [];
  if (!entries.length) throw Object.assign(new Error('The pack lists no papers.'), { status: 400 });

  const result = { added: 0, already: 0, problems: [] };
  for (const [index, entry] of entries.entries()) {
    const name = String(entry?.file ?? '');
    const file = name && zip.file(name);
    if (!file) {
      result.problems.push(`Paper ${index + 1} (${entry?.title ?? name}): its file is missing from the pack.`);
      continue;
    }
    const pdf = await file.async('nodebuffer');
    if (!isPdf(pdf)) {
      result.problems.push(`${entry.title ?? name}: not a PDF.`);
      continue;
    }
    const labels = paperLabelsFrom(entry);
    if (!labels.title || !labels.sections) {
      result.problems.push(`${name}: it needs a title and at least one section.`);
      continue;
    }
    const previewFile = entry.preview ? zip.file(String(entry.preview)) : null;
    const preview = previewFile ? previewFrom(entry.preview, await previewFile.async('nodebuffer')) : null;
    const { added } = addPaper(labels, { pdf, originalName: path.basename(String(entry.original_name || name)), preview });
    if (added) result.added += 1;
    else result.already += 1;
  }
  return result;
}
