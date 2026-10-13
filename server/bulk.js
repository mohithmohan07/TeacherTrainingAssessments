// Answer papers uploaded all at once, as PDFs, one teacher's answers in each.
// The PDFs may omit or contradict identity and paper labels, so every page
// is checked before any part of the PDF is filed. Uploading matches nothing: once every PDF is up, "Find the question
// papers" queues them with bounded concurrency. Matching a PDF:
//   1. Full teacher names, class/subject context and language are checked on
//      every page. Mixed identities and filename conflicts block filing.
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
import { OPENAI_MODEL, friendly, openaiConfigured, requestJson } from './openai.js';
import { GEMINI_MODEL, geminiConfigured } from './gemini.js';
import { READING_VERSION, readAnswers } from './reading.js';
import { OPENAI_IMAGE_TYPES, pageInputs } from './paper-inputs.js';
import { PAPER_SECTIONS, allPapers, presentPaper, rankPapers, setSittingPapers, subjectKeys, levelsFromText, teacherProfile, paperCompatibilityProblem } from './papers.js';
import { definiteNameConflict, nameRelationship } from './identity.js';
export { paperCompatibilityProblem } from './papers.js';
import { attachStoredPages, removeStoredFile } from './scans.js';
import { sittingForPaper } from './sittings.js';
import { MARKINGS, testFor, teacherResults } from './results.js';
import { startEvaluation, finalizeUnavailable } from './evaluate.js';
import { digest, fileBasis } from './provenance.js';
import { queueTeacherReports, findReport, isOutOfDate } from './reports.js';
import { jobsAtOnce } from './capacity.js';
import { keepAwake } from './idle.js';
import { compareQuestionBank } from './bank-matching.js';
import { createMatchingBudget, estimateMatchingCalls } from './matching-budget.js';
import { readIdentityPages, rereadIdentityPages } from './identity-reading.js';

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
   VALUES (@school_id, @test_id, @file_name, @teacher_id, @matched_by, 'new')`
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

// What pages are sorted into: a section, except that Section B can come
// more than once, since a teacher sits a Section B paper for each subject
// they teach. 'B2' and 'B3' are a second and third Section B paper.
export const GROUPS = ['A', 'B', 'B2', 'B3', 'C'];
const sectionOf = (group) => (group ? group[0] : null);
const groupLabel = (group) => (group.length > 1 ? `Section B (paper ${group.slice(1)})` : `Section ${group}`);

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

// A full name (including initials) is required for automatic identity. Weak
// spelling/initial matches can be shown for review, but never select a teacher.
export function nameMatch(name, text) {
  const have = words(text).filter((w) => !TITLES.has(w));
  const parts = words(name).filter((w) => !TITLES.has(w));
  if (!parts.some((w) => w.length > 2)) return 0;
  if (have.some((_, i) => parts.every((part, j) => part === have[i + j]))) return 2;
  const full = parts.filter((w) => w.length > 2);
  return full.every((w) => have.some((h) => nearly(h, w))) ? 1 : 0;
}

const identityName = (name) => words(name).filter((w) => !TITLES.has(w)).join(' ');
const overlaps = (a, b) => [...a].some((value) => b.has(value));

// Use actual classes where supplied; a shared school level alone does not
// disambiguate two namesakes teaching, for example, Classes 4 and 5.
function classNumbers(text) {
  const roman = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
  const value = String(text ?? '').toLowerCase().replace(/\b[ivx]+\b/g, (n) => roman[n] ?? n);
  const numbers = new Set([...value.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= 12));
  for (const match of value.matchAll(/\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\b/g)) {
    for (let n = Number(match[1]); n <= Math.min(12, Number(match[2])); n += 1) numbers.add(n);
  }
  return numbers;
}

function contextFits(teacher, grade, subjects) {
  const classes = classNumbers(grade), taught = classNumbers(teacher.grade);
  if (classes.size && taught.size && !overlaps(classes, taught)) return false;
  const levels = levelsFromText(grade), teacherLevels = levelsFromText(teacher.grade);
  if (levels.size && teacherLevels.size && !overlaps(levels, teacherLevels)) return false;
  const namedSubjects = subjectKeys(subjects), taughtSubjects = subjectKeys(teacher.subjects);
  return !namedSubjects.size || !taughtSubjects.size || overlaps(namedSubjects, taughtSubjects);
}

function filenameCandidates(fileName, teachers) {
  const grade = String(fileName).match(/(?:class(?:es)?|grades?|std)\s*[-_ ]*([\divx]+(?:\s*(?:-|to)\s*[\divx]+)?)/i)?.[0] ?? '';
  return teachers.filter((t) => nameMatch(t.name, fileName) === 2 && contextFits(t, grade, fileName));
}

export function teacherFromFileName(fileName, teachers) {
  const matches = filenameCandidates(fileName, teachers);
  return matches.length === 1 ? matches[0] : null;
}

function namedTeacher(name, grade, subjects, teachers) {
  const exact = teachers.filter((t) => identityName(t.name) === identityName(name));
  const matches = exact.filter((t) => contextFits(t, grade, subjects));
  return matches.length === 1 ? matches[0] : null;
}

function completePages(observations, count) {
  return Array.isArray(observations) && observations.length === count &&
    new Set(observations.map((p) => Number(p.page))).size === count &&
    observations.every((p) => Number.isInteger(Number(p.page)) && Number(p.page) >= 1 && Number(p.page) <= count);
}

// Keep page-level observations verbatim enough for an audit; model-selected
// IDs are evidence only, never an authority over a contradictory written name.
export function inspectIdentity(item, pages, look, teachers) {
  const byNumber = new Map((look.pages ?? []).map((p) => [Number(p.page), p]));
  return {
    complete: completePages(look.pages, pages.length) && look.pages.every((p) =>
      ['name_written', 'grade_written', 'subjects_written', 'paper_title_written'].every((key) => typeof p[key] === 'string') &&
      ['certain', 'uncertain', 'none'].includes(p.name_confidence) && Number.isInteger(p.teacher_id)),
    pages: pages.map((page, index) => {
      const seen = byNumber.get(index + 1) ?? {};
      const field = (key) => {
        const origin = seen.field_evidence?.[key]?.origin;
        return origin === 'answer_content' || origin === 'absent' ? '' : String(seen[key] ?? '').trim();
      };
      const name = field('name_written');
      const grade = field('grade_written');
      const subjects = field('subjects_written');
      const resolved = name && seen.name_confidence === 'certain' ? namedTeacher(name, grade, subjects, teachers) : null;
      return {
        page_id: page.id, source_file: item.file_name, source_page: page.position,
        name_written: name, grade_written: grade, subjects_written: subjects,
        name_confidence: seen.name_confidence ?? 'uncertain',
        reported_teacher_id: Number(seen.teacher_id) || null,
        teacher_id: resolved?.id ?? null,
        paper_title_written: field('paper_title_written'),
        field_evidence: seen.field_evidence ?? null,
        field_observations: Object.fromEntries(['name_written', 'grade_written', 'subjects_written', 'paper_title_written'].map((key) => [key, String(seen[key] ?? '').trim()])),
        field_review_required: Boolean(seen.reread_name_conflict || seen.reread_header_conflict) || Object.values(seen.field_evidence ?? {}).some((e) => e.origin === 'uncertain'),
      };
    }),
  };
}

export function identityProblems(item, pages, result, teachers) {
  if (!result?.identity?.complete || !pages.every((p) => result.identity.pages.some((e) => e.page_id === p.id))) {
    return ['Match this PDF again to verify the teacher on every source page before filing.'];
  }
  const active = pages.some((p) => p.section) ? pages.filter((p) => p.section) : pages;
  const evidence = active.map((p) => result.identity.pages.find((e) => e.page_id === p.id));
  const problems = [];
  const ids = new Set(evidence.map((e) => e.teacher_id).filter(Boolean));
  if (ids.size > 1) problems.push('This PDF contains pages from different teachers. Split it into one teacher per PDF, or exclude the other teacher’s pages.');
  const other = evidence.filter((e) => e.teacher_id && e.teacher_id !== item.teacher_id);
  if (item.teacher_id && other.length) problems.push(`Source page${other.length === 1 ? '' : 's'} ${other.map((e) => e.source_page).join(', ')} name a different teacher. Do not file them under the selected teacher.`);
  const selected = teachers.find((t) => t.id === item.teacher_id);
  for (const source of evidence) {
    if (!selected) continue;
    if (source.name_confidence === 'certain' && definiteNameConflict(selected.name, source.name_written)) {
      problems.push(`Source page ${source.source_page} clearly names “${source.name_written}”, not ${selected.name}. Correct the teacher or exclude that page; manual selection cannot override a conflicting name.`);
    }
    const explicitUnknownSubject = source.subjects_written && !subjectKeys(source.subjects_written).size && selected.subjects &&
      !String(selected.subjects).split(/[,;/|]/).some((subject) => identityName(subject) === identityName(source.subjects_written));
    if (!contextFits(selected, source.grade_written, source.subjects_written) || explicitUnknownSubject) {
      problems.push(`Source page ${source.source_page} has a class or subject that conflicts with ${selected.name}’s profile. Correct the profile/teacher or exclude that page before filing.`);
    }
  }
  if (evidence.some((e) => e.field_review_required)) problems.push('A source identity/header field could not be distinguished from answer content. Re-read the flagged source page before filing.');
  const named = evidence.filter((e) => e.name_written);
  const conflictingNames = named.some((a, i) => named.slice(i + 1).some((b) =>
    a.name_confidence === 'certain' && b.name_confidence === 'certain' && definiteNameConflict(a.name_written, b.name_written)));
  if (conflictingNames) {
    problems.push('Different teacher names appear on these pages. Split or exclude the conflicting pages before filing.');
  } else if (item.matched_by !== 'you' && named.some((a, i) => named.slice(i + 1).some((b) => nameRelationship(a.name_written, b.name_written) !== 'same'))) {
    problems.push('Names vary across these pages. Verify the full name, class and subject and choose the teacher explicitly.');
  }
  const fileMatches = filenameCandidates(item.file_name, teachers);
  if (item.matched_by !== 'you') {
    if (fileMatches.length > 1) problems.push('The file name matches more than one teacher. Choose the full name, class and subject explicitly.');
    if (fileMatches.length === 1 && item.teacher_id && fileMatches[0].id !== item.teacher_id) problems.push('The file name and sheets identify different teachers. Choose the correct teacher explicitly.');
    if (evidence.some((e) => e.name_written && (!e.teacher_id || e.name_confidence !== 'certain'))) problems.push('A page name is uncertain or ambiguous. Verify the full name, class and subject and choose the teacher explicitly.');
    if (!evidence.some((e) => e.teacher_id) && fileMatches.length !== 1) problems.push('No unambiguous full teacher name was found. Verify the pages and choose the teacher explicitly.');
  }
  return [...new Set(problems)];
}

const paperName = (value) => words(value).join(' ');
export function namedMaster(title, papers) {
  if (!String(title ?? '').trim()) return { paper: null, ambiguous: false, matches: [] };
  const name = paperName(title);
  const matches = papers.filter((p) => [p.title, p.original_name].some((value) => value && paperName(value) === name));
  return { paper: matches.length === 1 ? matches[0] : null, ambiguous: matches.length !== 1, matches };
}

// Header text is evidence, not a database primary key. Generic section
// headings and translated titles need semantic reconciliation against the
// actual questions. Exact named masters still cannot be silently replaced.
export function headerMatchProblem(title, paperId, papers, evidence) {
  if (evidence && ['conflict', 'unresolved'].includes(evidence.status)) return 'The source header contains conflicting or unresolved master evidence. Reconcile it with the supplied questions.';
  if (!String(title ?? '').trim()) return null;
  const master = namedMaster(title, papers);
  if (master.paper) return master.paper.id === paperId ? null : 'The match disagrees with the paper title written on this source page. Choose that exact master.';
  if (master.matches.length && !master.matches.some((p) => p.id === paperId)) return 'The selected paper is not one of the masters bearing the source-written title.';
  if (!evidence || !['descriptive', 'compatible'].includes(evidence.status) || !String(evidence.reason ?? '').trim()) return 'The source heading needs comparison with the administered paper’s questions.';
  return null;
}

// A reread can improve a generic heading, but cannot erase an exact master
// already observed on the same retained source page. Keep all such anchors.
function retainMasterObservations(previous, fresh, library) {
  for (const page of fresh.pages ?? []) {
    const old = previous?.pages?.find((p) => p.page_id === page.page_id);
    if (!old) continue;
    page.previous_master_titles = [...new Set([old.paper_title_written, old.previous_paper_title_written,
      ...(old.previous_master_titles ?? [])].filter((title) => title && title !== page.paper_title_written && namedMaster(title, library).paper))];
  }
  return fresh;
}

// Normalize question LABEL formatting only, never answer text or meaning.
export function normalizeQuestionLabel(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[०-९೦-೯]/g, (d) => String(d.charCodeAt(0) - (d >= '೦' ? 0x0ce6 : 0x0966)))
    .replace(/^(?:question|ques|q)\s*[.:#-]?\s*(?=\d)/, '')
    .replace(/\((\d+)\)/g, '[$1]')
    .replace(/\s+/g, ' ')
    .replace(/[ ().:\-]/g, (mark, index, label) => /\d/.test(label[index - 1] ?? '') && /\d/.test(label[index + 1] ?? '') ? mark : '');
}

/* ------------------------------------------------------------- adding */

// Adds one PDF's pages, already made into pictures by the browser. It waits
// to be matched until "Find the question papers" is pressed.
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
  return id;
};

export function removeItem(id) {
  if (isFinalizationLocked(selectItem.get(id))) return 'This submission is retained with its final outcome and source pages.';
  const pages = selectPages.all(id);
  deleteItemRow.run(id);
  for (const page of pages) removeStoredFile(page.stored_name);
}

/* ------------------------------------------------------------ choosing */

// The teacher chosen on the review screen. A PDF that could not be sorted
// without knowing its teacher is sorted again once it has one.
export function chooseTeacher(item, teacherId) {
  if (isFinalizationLocked(item)) return 'This submission is being finalized or already has a final outcome.';
  if (['waiting', 'running'].includes(item.sort_status)) return 'Wait for matching to finish before changing the teacher.';
  const teacher = teacherId ? selectTeacher.get(teacherId) : null;
  if (teacherId && (!teacher || teacher.school_id !== item.school_id)) return 'Pick a teacher from this school.';
  setTeacher.run(teacher?.id ?? null, teacher ? 'you' : null, item.id);
  if (teacher && item.sort_status === 'needs_teacher') {
    const current = selectItem.get(item.id);
    const result = parse(current.result, {});
    const pages = selectPages.all(item.id);
    if (!result.identity?.complete || !identityProblems(current, pages, result, selectSchoolTeachers.all(item.school_id)).length) queueSort(item.id);
  }
  return null;
}

export function choosePapers(item, papers) {
  if (isFinalizationLocked(item)) return 'This submission is being finalized or already has a final outcome.';
  if (['waiting', 'running'].includes(item.sort_status)) return 'Wait for matching to finish before choosing papers.';
  const chosen = parse(item.papers, {});
  const result = parse(item.result, {});
  const teacher = item.teacher_id ? selectTeacher.get(item.teacher_id) : null;
  const school = selectSchool.get(item.school_id);
  const confirmations = { ...(result.paper_confirmations ?? {}) };
  const reviewRequired = { ...(result.paper_review_required ?? {}) };
  for (const key of GROUPS) {
    if (!(key in (papers ?? {}))) continue;
    const id = Number(papers[key]) || null;
    if (id) {
      const paper = selectPaper.get(id);
      const problem = teacher ? paperCompatibilityProblem(paper, teacher, school, sectionOf(key)) : 'Choose the teacher before the administered paper.';
      if (problem) return problem;
    }
    chosen[key] = id;
    confirmations[key] = id;
    delete reviewRequired[key];
  }
  setPapers.run(JSON.stringify(chosen), item.id);
  setResult.run(JSON.stringify({ ...result, paper_confirmations: confirmations, paper_review_required: reviewRequired }), item.id);
  return null;
}

// Moves pages between sections (or Section B papers), or out of use (null).
export function choosePageSections(item, pages) {
  if (isFinalizationLocked(item)) return 'This submission is being finalized or already has a final outcome.';
  const result = parse(selectItem.get(item.id)?.result, {});
  result.page_confirmations ??= {};
  for (const { id, section } of pages ?? []) {
    const value = GROUPS.includes(section) ? section : null;
    const changed = setPageSection.run(value, Number(id), item.id);
    if (changed.changes) result.page_confirmations[Number(id)] = value;
  }
  setResult.run(JSON.stringify(result), item.id);
}

/* -------------------------------------------------------------- sorting */

// Matching is bounded by both memory and an explicit provider concurrency
// limit. Large school batches stay queued rather than flooding model APIs.
export function boundedConcurrency(configured, memoryLimit) {
  const value = Number(configured);
  return Math.max(1, Math.min(memoryLimit, Number.isInteger(value) && value > 0 ? value : 3));
}
export const MATCHING_AT_ONCE = boundedConcurrency(process.env.BULK_MATCHING_CONCURRENCY, jobsAtOnce(150));
export const MATCHING_LIMITS = Object.freeze({ packetTimeoutMs: 15 * 60 * 1000, requestTimeoutMs: 90 * 1000, maxProviderAttempts: 40 });
const waiting = [];
let running = 0;

// Read-only planning: metadata and source counts only, no model calls or writes.
// Estimates are logical calls, not prices; provider retries and OCR are separate.
export function matchingPlan(schoolId, testId, ids = null) {
  const school = selectSchool.get(schoolId);
  const library = allPapers();
  const requested = ids ? new Set(ids.map(Number)) : null;
  const items = selectItems.all(schoolId, testId).filter((item) => (!requested || requested.has(item.id)) &&
    (['new', 'failed'].includes(item.sort_status) || (item.sort_status === 'done' && !presentItem(item).ready)));
  const packets = items.map((item) => {
    const teacher = item.teacher_id ? selectTeacher.get(item.teacher_id) : null;
    const pages = selectPages.all(item.id);
    const candidates = teacher ? candidatePapers(teacher, school, library) : library;
    const estimate = estimateMatchingCalls(candidates.length, { sourcePages: Math.max(1, pages.length) });
    return { item_id: item.id, file_name: item.file_name, source_pages: pages.length,
      compatible_candidates: candidates.length, candidate_ids: candidates.map((p) => p.id),
      profile_resolved: Boolean(teacher), calls: estimate,
      non_english_pages_last_observed: pages.filter((p) => p.language && p.language !== 'english').length };
  });
  return { id: digest({ items: items.map((item) => ({ ...item, pages: selectPages.all(item.id) })), library, school, teachers: items.map(item => item.teacher_id ? selectTeacher.get(item.teacher_id) : null), packets, limits: MATCHING_LIMITS }),
    packets, packet_count: packets.length, source_pages: packets.reduce((n, p) => n + p.source_pages, 0),
    nominal_model_calls: packets.reduce((n, p) => n + p.calls.totalCalls, 0),
    maximum_provider_attempts: packets.length * MATCHING_LIMITS.maxProviderAttempts,
    concurrency: MATCHING_AT_ONCE, limits: MATCHING_LIMITS,
    estimate_note: 'Logical matching calls only; OCR, retries and actual token usage determine charges. No dollar price is estimated.' };
}

function itemMatchingPolicy(id, initialSnapshot = null) {
  return createMatchingBudget({ ...MATCHING_LIMITS, ...(initialSnapshot ? { initialSnapshot } : {}),
    onChange: (snapshot) => {
      const current = selectItem.get(id);
      if (!current) throw friendly('This submission was removed while matching. No further model requests will be made.');
      const result = parse(current.result, {});
      result.matching_metrics = snapshot;
      setResult.run(JSON.stringify(result), id);
    },
  });
}

// "Find the question papers": every PDF of the test not matched yet, or whose
// matching failed or still needs evidence, is matched now. Completed/filed
// assessments and retained final outcomes are never regraded by this action.
export function matchAll(schoolId, testId, { queue = queueSort } = {}) {
  const items = selectItems.all(schoolId, testId).filter((item) => ['new', 'failed'].includes(item.sort_status) ||
    (item.sort_status === 'done' && !presentItem(item).ready));
  for (const item of items) queue(item.id);
  return items.length;
}

export function queueSort(id) {
  if (isFinalizationLocked(selectItem.get(id))) return;
  const current = selectItem.get(id);
  const result = parse(current?.result, {});
  if (result.matching_metrics) {
    result.matching_history = [...(result.matching_history ?? []), result.matching_metrics].slice(-5);
    delete result.matching_metrics;
    setResult.run(JSON.stringify(result), id);
  }
  setStatus.run('waiting', null, id);
  if (!waiting.includes(id)) waiting.push(id);
  pump();
}

function pump() {
  while (running < MATCHING_AT_ONCE && waiting.length) {
    const id = waiting.shift();
    running += 1;
    keepAwake(
      sortItem(id)
        .catch((error) => {
          console.error(`Sorting bulk PDF ${id} failed:`, error);
          if (selectItem.get(id)) setStatus.run('failed', error.userMessage ?? `Matching failed: ${error.message}`, id);
        })
        .finally(() => {
          running -= 1;
          pump();
        })
    );
  }
}

// PDFs that were being matched when the server stopped start again.
db.prepare("UPDATE bulk_items SET sort_status = 'waiting' WHERE sort_status = 'running'").run();
for (const { id } of db.prepare("SELECT id FROM bulk_items WHERE sort_status = 'waiting' ORDER BY id").all()) {
  waiting.push(id);
}
setImmediate(pump);

const LOOK_INSTRUCTIONS = `You are helping file a teacher's answers to a teacher training assessment. You are given every page of one PDF of answer sheets, scanned, usually handwritten, and the list of teachers at the school.

1. Inspect EVERY page independently for teacher identity. One PDF may mistakenly contain two teachers. Never carry a teacher name onto an unnamed page. For each page, copy name_written, grade_written, subjects_written and paper_title_written exactly from explicit identity/header fields, or "" if absent. Do not use names in questions or answers as teacher names. paper_title_written is only an explicitly printed/written administered question-paper title, section heading or filename, never your inferred subject. Copy values only from actual identity/document header fields. Equations or answer notes near a blank Class/Subject box are answer content, not class/subject metadata. A report title, classroom example or assessment heading written within an answer is answer content, not this administered paper’s title. For every copied field, provide field_evidence with its visual origin and a short reason. Use identity_header for Name/Class/Subject fields, document_heading for the administered paper heading, answer_content for text belonging to an answer, absent when truly absent, and uncertain when its role cannot be established. Copy a generic heading faithfully; the later question comparison decides whether it names a unique master. A descriptive heading is not itself a version identifier. Give teacher_id only when the full name, initials and any written class/subject identify exactly one listed teacher; otherwise 0. Use name_confidence "certain", "uncertain" or "none". Never resolve namesakes by guessing. The top-level name_written/teacher_id summarize only when the named pages agree; otherwise use "" and 0. A filename is a clue, not authority over page evidence.

Return exactly one entry for each supplied image, using the local page numbers in the supplied batch map. Do not return observations for images outside this batch.

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
        required: ['page', 'language', 'languages', 'name_written', 'teacher_id', 'grade_written', 'subjects_written', 'name_confidence', 'paper_title_written', 'field_evidence'],
        properties: {
          page: { type: 'integer' },
          name_written: { type: 'string' },
          teacher_id: { type: 'integer' },
          grade_written: { type: 'string' },
          subjects_written: { type: 'string' },
          name_confidence: { type: 'string', enum: ['certain', 'uncertain', 'none'] },
          paper_title_written: { type: 'string' },
          field_evidence: { type: 'object', additionalProperties: false, required: ['name_written', 'grade_written', 'subjects_written', 'paper_title_written'],
            properties: Object.fromEntries(['name_written', 'grade_written', 'subjects_written', 'paper_title_written'].map((key) => [key, {
              type: 'object', additionalProperties: false, required: ['origin', 'reason'], properties: {
                origin: { type: 'string', enum: ['identity_header', 'document_heading', 'answer_content', 'absent', 'uncertain'] }, reason: { type: 'string' },
              },
            }])) },
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
A teacher may have sat one, two or all three sections. A teacher who teaches more than one subject may also have sat more than one Section B paper, one for each subject (for example Mathematics and Science, or Kannada and Hindi), and their answers to each are on separate pages. Questions are usually numbered across the sections (often Section A Q1 to Q4, Section B Q5 to Q8, Section C Q9 to Q11), but some papers start again at Q1, so the numbers alone are not enough.

You are given candidate QUESTION PAPERS from the school's paper library, each with its id, then every page of ONE TEACHER'S ANSWER SHEETS from one PDF, in order. The answer sheets may show generic headings, an exact master title, or no heading. Headings often differ from the library display title. Pages a teacher wrote in a language other than English come with a reading of the handwriting in that language; the reading may have mistakes, so check it against the picture.

Work out, by matching the answers against the questions:
- For every page, the section it answers ("A", "B" or "C"), the id of the question paper it answers, and the question labels answered on it, as printed on the paper ("5A", "5B", "9"). Use section "none" and paper_id 0 for unresolved pages or pages without answers. Distinguish these with has_answers: unreadable writing is not a blank.
- In papers, every question paper the teacher answered: its section, its id, how sure you are and why. Give one entry for Section A and one for Section C if they were sat, and one for each Section B paper: two entries when the teacher answered two subjects' Section B papers. A section with no pages was not sat, so it has no entry.

How to match:
- Compare what each answer talks about with what each question asks: the situation in a case study, the names of children, subjects, tools and terms. An answer about a phishing email answers the Section C question about it; an answer about calming an anxious child in a maths class answers that Section B question.
- Handwriting can be hard to read. When a word cannot be read, use the words and lines around it, and the question the previous answer was for, to work out which question comes next. Answers usually follow the order of the questions, and a page that carries on the previous page's answer is in the same section.
- A teacher may write one section in English and another in Kannada, Hindi or another language. Match each section on its own, and choose the paper in the language its answers are in.
- Before deciding that a teacher sat two Section B papers, check the answers really belong to two different papers: they answer different subjects' questions (the situations, topics and terms differ), and the question numbers repeat (two answers to Q5, for example). Answers that continue one paper's questions are one paper, even when they run over many pages.
- Only match question papers supplied in full. An exact uniquely identified master or explicitly confirmed paper is authoritative; never substitute another level, section, subject, or version because it ranks better. When evidence conflicts, return an unresolved/low-confidence match and explain it. Do not force a match to the nearest-looking paper. Return exactly one entry per input page. has_answers is false only for a blank page or cover sheet; use true even for unreadable answers. Unresolved answer pages may use section none and paper_id 0, but are not blank.
- For every page return header_evidence {status, reason}. Use not_present when no source heading exists. For a generic descriptive heading (for example “Knowledge, pedagogy, classroom management & child psychology” or “Computer knowledge; Digital skills; Interpersonal & instructional communication skills”), use descriptive only after checking that it describes the matched questions; it does not need to equal the catalogue filename/title. Use compatible for a translated/shortened heading only when distinctive question content and any explicit subject, level, board, code or version agree. Use conflict for contrary explicit identifiers; unresolved when those identifiers cannot be reconciled. Give the concrete comparison in reason. Never reclassify a contradictory explicit master as merely descriptive to obtain a match. Inspect section membership from the supplied master itself; combined A/C headings do not override its actual question sections.
- Match answer meaning across languages; answer language alone does not establish which language/version of the master was administered. A translation must retain the distinctive question content.
- In matched_question_labels list the concrete question labels supported by answer-to-prompt matches. In alternatives list other equally plausible paper IDs, or [] only when there is no ambiguity. A vague subject resemblance is low confidence.
- Set confidence to "high" when the answers plainly match the paper's questions, "medium" when most do, and "low" when you are guessing. In reason, say briefly in plain English what matched, for example "Answers mention the phishing email and file folders in Q9 and Q10."`;

const SORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages', 'papers'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'section', 'paper_id', 'questions', 'has_answers', 'header_evidence'],
        properties: {
          page: { type: 'integer' },
          section: { type: 'string', enum: ['A', 'B', 'C', 'none'] },
          has_answers: { type: 'boolean' },
          header_evidence: { type: 'object', additionalProperties: false, required: ['status', 'reason'], properties: {
            status: { type: 'string', enum: ['not_present', 'descriptive', 'compatible', 'conflict', 'unresolved'] },
            reason: { type: 'string' },
          } },
          paper_id: { type: 'integer' },
          questions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    papers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'paper_id', 'confidence', 'reason', 'matched_question_labels', 'alternatives'],
        properties: {
          section: { type: 'string', enum: ['A', 'B', 'C'] },
          paper_id: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
          matched_question_labels: { type: 'array', items: { type: 'string' } },
          alternatives: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
};

// Catalogue ranking orders comparisons but must never exclude a compatible
// version or language before its full questions have been inspected.
export function candidatePapers(teacher, school, papers, authoritativeIds = []) {
  const profile = teacherProfile(teacher, school);
  const chosen = new Map();
  for (const key of PAPER_SECTIONS) {
    const eligible = papers.filter((p) => !paperCompatibilityProblem(p, teacher, school, key));
    const { ranked } = rankPapers(eligible, profile, key);
    for (const { paper } of ranked) chosen.set(paper.id, paper);
  }
  const explicit = new Set(authoritativeIds.map(Number));
  return [...chosen.values()].sort((a, b) => Number(explicit.has(b.id)) - Number(explicit.has(a.id)));
}

const pagesOf = (count) => `${count} page${count === 1 ? '' : 's'}`;


export async function sortItem(id, { request = requestJson, configured = openaiConfigured, read = readAnswers } = {}) {
  let item = selectItem.get(id);
  if (!item) return;
  setStatus.run('running', null, id);
  const requestPolicy = itemMatchingPolicy(id, parse(item.result, {}).matching_metrics ?? null);
  const pages = selectPages.all(id);

  if (!configured()) {
    throw friendly('OpenAI is not set up on the server (the OPENAI_API_KEY secret is missing), so these pages cannot be matched automatically. Choose the teacher, sections and papers yourself.');
  }
  const unreadable = pages.filter((page) => !OPENAI_IMAGE_TYPES.has(page.mime_type));
  if (unreadable.length) throw friendly('Some pages are in a picture format OpenAI cannot read. Remove this PDF and upload it again.');

  const school = selectSchool.get(item.school_id);
  const teachers = selectSchoolTeachers.all(item.school_id);
  const files = pages.map((page) => ({ ...page, original_name: `${item.file_name} page ${page.position}` }));

  // 1. Whose answers, and the language of each page.
  const library = allPapers();
  const identityContent = [
    { type: 'input_text', text: `TEACHERS AT THE SCHOOL:\n${teachers.map((t) => `id ${t.id}: ${t.name}${t.grade ? ` (${t.grade}${t.subjects ? `, ${t.subjects}` : ''})` : ''}`).join('\n')}` },
    { type: 'input_text', text: `SOURCE FILE: ${item.file_name}. A filename is a clue, not authority over a contradictory written name.` },
  ];
  let look = await readIdentityPages({ files, request, requestPolicy,
    timeoutMs: MATCHING_LIMITS.requestTimeoutMs, maxRetries: 1,
    instructions: LOOK_INSTRUCTIONS, schema: LOOK_SCHEMA, content: identityContent,
    name: 'answer_sheets_first_look', task: 'read the identity and language on these answer pages', retry: 'Match again to retry the retained source pages.',
  });
  const firstIdentity = inspectIdentity(item, pages, look, teachers);
  const selected = item.teacher_id ? teachers.find((t) => t.id === item.teacher_id) : null;
  const focus = firstIdentity.pages.flatMap((source, index) => {
    const uncertainName = source.name_written && (!source.teacher_id || source.name_confidence !== 'certain');
    const profileConflict = selected && (!contextFits(selected, source.grade_written, source.subjects_written) ||
      (source.subjects_written && !subjectKeys(source.subjects_written).size && selected.subjects &&
        !String(selected.subjects).split(/[,;/|]/).some((subject) => identityName(subject) === identityName(source.subjects_written))));
    const differentTeacher = selected && source.teacher_id && source.teacher_id !== selected.id;
    return source.field_review_required || uncertainName || profileConflict || differentTeacher || source.paper_title_written ? [index + 1] : [];
  });
  if (focus.length) {
    look = await rereadIdentityPages({ previous: look, files, pageNumbers: focus, request, requestPolicy,
      timeoutMs: MATCHING_LIMITS.requestTimeoutMs, maxRetries: 1, instructions: LOOK_INSTRUCTIONS, schema: LOOK_SCHEMA, content: identityContent,
      name: 'answer_sheets_identity_reread', task: 'verify flagged identity fields against their source pages', retry: 'The original pages remain available for review.',
      mergeObservation: (old, fresh) => {
        // A focused read may distinguish answer content from a header; it may
        // not erase a clearly different named teacher seen on that page.
        const first = inspectIdentity(item, [{ id: 1, position: 1 }], { pages: [{ ...old, page: 1 }] }, teachers).pages[0];
        const next = inspectIdentity(item, [{ id: 1, position: 1 }], { pages: [{ ...fresh, page: 1 }] }, teachers).pages[0];
        for (const key of ['grade_written', 'subjects_written']) {
          if (old.field_evidence?.[key]?.origin === 'identity_header' && String(old[key]).trim() &&
              identityName(first[key]) !== identityName(next[key]) && fresh.field_evidence?.[key]?.origin !== 'answer_content') {
            fresh = { ...fresh, [key]: old[key], field_evidence: { ...fresh.field_evidence, [key]: old.field_evidence[key] }, reread_name_conflict: true };
          }
        }
        const firstMaster = namedMaster(first.paper_title_written, library).paper;
        if (firstMaster && fresh.field_evidence?.paper_title_written?.origin !== 'answer_content' &&
            namedMaster(next.paper_title_written, library).paper?.id !== firstMaster.id) {
          fresh = { ...fresh, paper_title_written: old.paper_title_written,
            field_evidence: { ...fresh.field_evidence, paper_title_written: old.field_evidence?.paper_title_written },
            reread_header_conflict: true };
        }
        if (first.teacher_id && next.teacher_id !== first.teacher_id && first.name_confidence === 'certain') {
          return { ...fresh, name_written: old.name_written, teacher_id: old.teacher_id, name_confidence: old.name_confidence,
            grade_written: old.grade_written, subjects_written: old.subjects_written,
            field_evidence: { ...fresh.field_evidence, name_written: old.field_evidence?.name_written,
              grade_written: old.field_evidence?.grade_written, subjects_written: old.field_evidence?.subjects_written },
            reread_name_conflict: true };
        }
        if (first.name_confidence === 'certain' && first.name_written &&
            (!next.name_written || next.name_confidence !== 'certain' || identityName(first.name_written) !== identityName(next.name_written))) {
          return { ...fresh, name_written: old.name_written, teacher_id: old.teacher_id, name_confidence: old.name_confidence,
            field_evidence: { ...fresh.field_evidence, name_written: old.field_evidence?.name_written },
            reread_name_conflict: true };
        }
        return fresh;
      },
    });
  }

  const written = String(look.name_written ?? '').trim();
  item = selectItem.get(id);
  if (!item) return;
  const previous = parse(item.result, {});
  const identity = retainMasterObservations(previous.identity, inspectIdentity(item, pages, look, teachers), library);
  const identities = [...new Set(identity.pages.map((p) => p.teacher_id).filter(Boolean))];
  const fromSheet = identities.length === 1 ? teachers.find((t) => t.id === identities[0]) : null;
  if (!item.teacher_id && fromSheet) {
    setTeacher.run(fromSheet.id, 'sheet', id);
    item = selectItem.get(id);
  }
  const byNumber = new Map((look.pages ?? []).map((p) => [Number(p.page), p]));
  const languages = new Set();
  pages.forEach((page, i) => {
    const seen = byNumber.get(i + 1);
    const language = ['english', 'other', 'mixed'].includes(seen?.language) ? seen.language : 'mixed';
    for (const name of seen?.languages ?? []) if (String(name).trim()) languages.add(String(name).trim());
    files[i].language = language;
    setPageLanguage.run(language, page.id);
  });
  const result = {
    name_written: written,
    sheet_teacher_id: fromSheet?.id ?? null,
    identity,
    identity_reading: look.audit ?? null,
    paper_confirmations: previous.paper_confirmations ?? {},
    page_confirmations: previous.page_confirmations ?? {},
    source_pages: previous.source_pages ?? [],
    matching_metrics: requestPolicy.snapshot(),
    matching_history: previous.matching_history ?? [],
    languages: [...languages],
    read_by_gemini: 0,
    notes: [],
    sections: {},
  };
  setResult.run(JSON.stringify(result), id);

  const teacher = item.teacher_id ? selectTeacher.get(item.teacher_id) : null;
  const identityIssues = identityProblems(item, pages.map((p) => ({ ...p, section: null })), result, teachers);
  if (!teacher || identityIssues.length) {
    setStatus.run('needs_teacher', identityIssues.join(' ') || 'Choose the teacher by full name, class and subject.', id);
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
        const texts = await read(notEnglish, names, { requestPolicy });
        notEnglish.forEach((page, i) => texts[i] !== null && readings.set(page.id, texts[i]));
        result.read_by_gemini = texts.filter((text) => text !== null).length;
        const unread = notEnglish.length - result.read_by_gemini;
        if (unread) {
          const which = unread === notEnglish.length ? `the page${unread === 1 ? '' : 's'}` : unread === 1 ? 'one of the pages' : `${unread} of the pages`;
          result.notes.push(`Gemini would not read ${which} not in English, so OpenAI matched ${unread === 1 ? 'it' : 'them'} from the pictures alone.`);
        }
      } catch (error) {
        if (['MATCHING_BUDGET_EXHAUSTED', 'MATCHING_BUDGET_PERSISTENCE_FAILED'].includes(error.code)) throw error;
        result.notes.push(`Gemini could not read the pages that are not in English (${error.userMessage ?? error.message}), so OpenAI matched them from the pictures alone.`);
      }
    }
  }

  // 3. Which section each page answers, and which paper each section was sat on.
  const authoritativeIds = [...Object.values(result.paper_confirmations), ...identity.pages.map((p) => namedMaster(p.paper_title_written, library).paper?.id)].filter(Boolean);
  const candidates = candidatePapers(teacher, school, library, authoritativeIds);
  if (!candidates.length) throw friendly(library.length ? 'No library paper is compatible with this teacher’s class, subject and board. Confirm the profile and import the administered master; no paper was substituted.' : 'The paper library has no papers yet. Import the paper pack on the Paper library page, then press Match again.');
  result.candidate_paper_ids = candidates.map((p) => p.id);
  result.matching_metrics = requestPolicy.snapshot();
  setResult.run(JSON.stringify(result), id);

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

  const sorted = await compareQuestionBank({
    candidates, request, answerPageCount: pages.length,
    requestPolicy, maxRetries: 1, timeoutMs: MATCHING_LIMITS.requestTimeoutMs,
    instructions: SORT_INSTRUCTIONS,
    content: [
      { type: 'input_text', text: `THE TEACHER: ${teacher.name}${teacher.grade ? `, teaches ${teacher.grade}` : ''}${teacher.subjects ? `, subjects ${teacher.subjects}` : ''}. School: ${school.name}.` },
      { type: 'input_text', text: `CANDIDATE QUESTION PAPERS (${candidates.length}):` },
      { type: 'input_text', text: `CONFIRMED PAPERS (group to paper ID): ${JSON.stringify(result.paper_confirmations)}. SOURCE-WRITTEN TITLES: ${JSON.stringify(identity.pages.filter((p) => p.paper_title_written || p.previous_master_titles?.length).map((p) => ({ page: p.source_page, title: p.paper_title_written, previous_master_titles: p.previous_master_titles ?? [] })))}` },
      { type: 'input_text', text: `ONE TEACHER'S ANSWER SHEETS (${pagesOf(files.length)}):` },
      ...pageContent.flat(),
    ],
    name: 'answer_sheets_sorted',
    schema: SORT_SCHEMA,
    task: 'match these answer sheets to the question papers',
    retry: 'Press Match again to try again.',
  });

  if (!selectItem.get(id)) return; // removed while it was being sorted
  result.matching_metrics = requestPolicy.snapshot();
  result.bank_comparison = sorted.bank_comparison ?? null;
  saveSort(id, teacher, school, library, pages, sorted, result);
}

// Validate before assigning. No guessed paper is inherited from a preceding
// page, profile rank, or catalogue entry whose questions were never inspected.
export function buildSortPlan(teacher, school, library, pages, sorted, result, { allowSuppliedBlank = false } = {}) {
  const complete = completePages(sorted.pages, pages.length);
  const byNumber = new Map((sorted.pages ?? []).map((p) => [Number(p.page), p]));
  const bGroups = new Map();
  const sourcePages = [];
  const assignments = [];
  const papers = {};
  const sections = {};
  for (const [index, page] of pages.entries()) {
    const found = byNumber.get(index + 1) ?? {};
    const section = PAPER_SECTIONS.includes(found.section) ? found.section : null;
    const paperId = Number(found.paper_id) || null;
    let group = section;
    const issues = [];
    if (!complete) issues.push('The model did not return each source page exactly once. Match again or review every page.');
    if (section === 'B') {
      const key = paperId ?? 'unresolved';
      if (!bGroups.has(key)) bGroups.set(key, bGroups.size < 3 ? (bGroups.size ? `B${bGroups.size + 1}` : 'B') : null);
      group = bGroups.get(key);
      if (!group) issues.push('More than three distinct Section B papers were reported. Split and review this PDF.');
    }
    const said = (sorted.papers ?? []).filter((p) => p.section === section && Number(p.paper_id) === paperId);
    const summary = said.length === 1 ? said[0] : null;
    const identity = result.identity?.pages.find((p) => p.page_id === page.id);
    const paper = library.find((p) => p.id === paperId);
    const named = identity?.paper_title_written ? namedMaster(identity.paper_title_written, library) : null;
    const suppliedBlank = allowSuppliedBlank && found.has_answers === false && section && (
      (named?.paper?.id === paperId && String(paper?.sections) === section) ||
      (result.paper_confirmations?.[group] === paperId && result.page_confirmations?.[page.id] === group));
    if (section) {
      if (found.has_answers !== true && !suppliedBlank) issues.push('A section was assigned without confirmed answer content. Review this page.');
      const problem = paperCompatibilityProblem(paper, teacher, school, section);
      if (problem) issues.push(problem);
      if (!(result.candidate_paper_ids ?? []).includes(paperId)) issues.push('The selected paper was not supplied in full for comparison.');
      const labels = (summary?.matched_question_labels ?? []).map(normalizeQuestionLabel).filter(Boolean);
      if (!summary || summary.confidence !== 'high' || !String(summary.reason ?? '').trim() || (!suppliedBlank && !labels.length) ||
          !Array.isArray(summary.alternatives) || summary.alternatives.length ||
          (!suppliedBlank && !(found.questions ?? []).some((q) => labels.includes(normalizeQuestionLabel(q))))) {
        issues.push('The paper match is weak or ambiguous. Choose the administered master explicitly.');
      }
      const confirmed = result.paper_confirmations?.[group];
      if (confirmed && confirmed !== paperId) issues.push('The match disagrees with the confirmed administered master. The confirmed paper has been retained for review.');
    } else if (found.has_answers !== false || paperId || (found.questions ?? []).length) {
      issues.push('This source page is unresolved, not a verified blank. Assign its section or explicitly exclude it.');
    }
    if (section) {
      const problem = headerMatchProblem(identity?.paper_title_written, paperId, library, found.header_evidence);
      if (problem) issues.push(problem);
    }
    for (const title of [identity?.previous_paper_title_written, ...(identity?.previous_master_titles ?? [])]) {
      const previousMaster = namedMaster(title, library).paper;
      if (section && previousMaster && previousMaster.id !== paperId) issues.push('An earlier source observation names a different exact master. Reconcile that evidence before filing.');
    }
    const questions = (found.questions ?? []).map((q) => String(q).trim()).filter(Boolean);
    sourcePages.push({ page_id: page.id, source_page: page.position, section, group, paper_id: paperId,
      has_answers: found.has_answers !== false, supplied_blank: Boolean(suppliedBlank), questions, confidence: summary?.confidence ?? null,
      reason: String(summary?.reason ?? ''), header_evidence: found.header_evidence ?? null,
      source_heading: identity?.paper_title_written ?? '', issues });
    assignments.push({ id: page.id, section: group, questions: questions.join(', ') });
  }
  for (const group of GROUPS) {
    const mine = sourcePages.filter((p) => p.group === group);
    if (!mine.length) continue;
    const ids = new Set(mine.map((p) => p.paper_id));
    const confirmed = result.paper_confirmations?.[group];
    const unanimous = ids.size === 1 && !mine.some((p) => p.issues.length);
    papers[group] = confirmed || (unanimous ? mine[0].paper_id : null);
    sections[group] = {
      confidence: unanimous ? 'high' : 'low',
      reason: unanimous ? mine[0].reason : [...new Set(mine.flatMap((p) => p.issues)), ...(ids.size > 1 ? ['Pages in this section name different papers. Confirm the administered master.'] : [])].join(' '),
    };
  }
  return { papers, sections, assignments, sourcePages, complete };
}

export function retainAnswerPresence(sorted, pages, priorSources = []) {
  return { ...sorted, pages: (sorted.pages ?? []).map((found) => {
    const page = pages[Number(found.page) - 1];
    const prior = priorSources.find((source) => source.page_id === page?.id);
    if (found.has_answers !== false || prior?.has_answers !== true) return found;
    return { ...found, section: 'none', paper_id: 0, questions: [], has_answers: true,
      header_evidence: { status: 'unresolved', reason: 'Earlier source inspection found writing; a later blank claim cannot discard that evidence.' } };
  }) };
}

export const saveSort = db.transaction((id, teacher, school, library, pages, sorted, result) => {
  const previous = parse(selectItem.get(id)?.result, {});
  const plan = buildSortPlan(teacher, school, library, pages, retainAnswerPresence(sorted, pages, previous.source_pages), result);
  for (const row of plan.assignments) setPageSort.run(row);
  result.source_pages = plan.sourcePages;
  result.paper_sort_complete = plan.complete;
  result.sections = plan.sections;
  result.paper_review_required = {};
  for (const [group, confirmed] of Object.entries(result.paper_confirmations ?? {})) {
    if (confirmed && plan.sourcePages.some((p) => p.group === group && p.paper_id !== confirmed)) result.paper_review_required[group] = true;
  }
  setPapers.run(JSON.stringify(plan.papers), id);
  setResult.run(JSON.stringify(result), id);
  setStatus.run('done', null, id);
});

function paperReviewProblems(item, pages, result, teacher, school, library) {
  const chosen = parse(item.papers, {});
  const problems = [];
  if (item.sort_status === 'needs_teacher') return ['Matching stopped during identity verification. The question-paper comparison has not run yet.'];
  for (const page of pages) {
    const source = result?.source_pages?.find((p) => p.page_id === page.id);
    const manualPage = Object.hasOwn(result?.page_confirmations ?? {}, page.id);
    if (result?.paper_sort_complete !== true && !manualPage) problems.push(`Source page ${page.position}: matching returned an incomplete page map. Review this page’s section explicitly.`);
    if (!page.section) {
      if ((!source || source.has_answers || source.issues.length) && !manualPage) problems.push(`Source page ${page.position} is unresolved. Assign a section or explicitly exclude it.`);
      continue;
    }
    const paper = library.find((p) => p.id === Number(chosen[page.section]));
    const compatibility = teacher ? paperCompatibilityProblem(paper, teacher, school, sectionOf(page.section)) : null;
    if (compatibility) problems.push(`Source page ${page.position}: ${compatibility}`);
    const manualPaper = paper && result?.paper_confirmations?.[page.section] === paper.id;
    if (result?.paper_review_required?.[page.section]) problems.push(`Source page ${page.position}: rematching disagreed with the confirmed master. Review these pages and confirm the retained master again.`);
    if ((!source || source.issues.length || result.paper_sort_complete !== true) && !manualPaper) problems.push(`Source page ${page.position}: confirm the administered master before filing.`);
    if (source && source.group !== page.section && !manualPage) problems.push(`Source page ${page.position} changed sections without review.`);
    const identity = result?.identity?.pages.find((p) => p.page_id === page.id);
    const title = identity?.paper_title_written;
    for (const prior of [identity?.previous_paper_title_written, ...(identity?.previous_master_titles ?? [])]) {
      const master = namedMaster(prior, library).paper;
      if (master && master.id !== paper?.id) problems.push(`Source page ${page.position}: an earlier source observation names a different exact master. Reconcile that evidence before filing.`);
    }
    if (title || (source?.paper_id === paper?.id && ['conflict', 'unresolved'].includes(source?.header_evidence?.status))) {
      // Semantic evidence is tied to this source heading and selected paper.
      const evidence = source?.paper_id === paper?.id && source?.source_heading === title ? source.header_evidence : null;
      const problem = headerMatchProblem(title, paper?.id, library, evidence);
      if (problem) problems.push(`Source page ${page.position}${title ? ` names “${title}”` : ""}. ${problem}`);
    }
  }
  return [...new Set(problems)];
}

/* ------------------------------------------------------------ presenting */

const countResponse = db.prepare("SELECT COUNT(*) AS n FROM assessment_files WHERE assessment_id = ? AND kind = 'response'");
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');

// One PDF as the review screen shows it: its teacher, its pages, the paper
// for each section, and what stops it being filed or is worth knowing first.
export function presentItem(item, others = []) {
  const pages = selectPages.all(item.id);
  const result = parse(item.result, null);
  const chosen = parse(item.papers, {});
  const teacher = item.teacher_id ? selectTeacher.get(item.teacher_id) : null;
  const test = selectTest.get(item.test_id);
  // A second or third Section B paper shows only once pages are put in it.
  const groups = GROUPS.filter((key) => key.length === 1 || pages.some((p) => p.section === key));
  const sections = groups.map((key) => {
    const count = pages.filter((p) => p.section === key).length;
    const paper = chosen[key] ? selectPaper.get(chosen[key]) : null;
    const found = teacher && count ? sittingForPaper(teacher, test, sectionOf(key), paper?.id ?? null, { create: false }) : null;
    const sitting = found ? { ...found, response_count: countResponse.get(found.id).n } : null;
    return {
      key,
      section: sectionOf(key),
      // With two Section B papers, each is named by its subject.
      label: key[0] === 'B' && groups.filter((g) => g[0] === 'B').length > 1 && paper?.subject ? `Section B (${paper.subject})` : groupLabel(key),
      pages: count,
      paper: paper ? presentPaper(paper) : null,
      confidence: result?.sections?.[key]?.confidence ?? null,
      requires_confirmation: Boolean(result?.paper_review_required?.[key]),
      reason: result?.sections?.[key]?.reason ?? '',
      // What filing does to the teacher's sitting for this section.
      existing: sitting
        ? ['evaluated', 'finalized'].includes(sitting.status)
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
  if (isFinalizationLocked(item)) problems.push('This submission is retained with its final outcome.');
  const sorting = ['waiting', 'running'].includes(item.sort_status);
  const unmatched = item.sort_status === 'new';
  if (sorting) problems.push('Still being matched.');
  if (unmatched) problems.push('Not matched yet.');
  if (!teacher) problems.push('Choose the teacher.');
  if (!sorting && !unmatched) {
    problems.push(...identityProblems(item, pages, result, selectSchoolTeachers.all(item.school_id)));
    problems.push(...paperReviewProblems(item, pages, result, teacher, selectSchool.get(item.school_id), allPapers()));
  }
  if (!pages.some((p) => p.section)) problems.push(sorting || unmatched || item.sort_status === 'needs_teacher' ? '' : 'Put at least one page in Section A, B or C.');
  for (const s of sections) {
    if (item.sort_status !== 'needs_teacher' && s.pages && !s.paper) problems.push(`Choose the ${s.label} question paper.`);
    if (s.existing === 'marking') problems.push(`${teacher.name}’s ${s.label} is being marked. Wait for it to finish.`);
  }
  const bPapers = sections.filter((s) => s.section === 'B' && s.pages && s.paper).map((s) => s.paper.id);
  if (new Set(bPapers).size < bPapers.length) problems.push('Two Section B groups have the same question paper. Move their pages into one, or choose the other subject’s paper.');

  const notes = [];
  if (result?.name_written && item.matched_by === 'file' && result.sheet_teacher_id && result.sheet_teacher_id !== item.teacher_id) {
    problems.push(`The file name says ${teacher?.name}, but the sheets say “${result.name_written}”. Resolve the identity conflict before filing.`);
  }
  if (teacher && others.some((o) => o.id !== item.id && o.teacher_id === teacher.id)) {
    notes.push(`Another PDF here is also for ${teacher.name}. Both are filed under them if you keep both.`);
  }
  for (const s of sections) {
    if (s.existing === 'has_pages') notes.push(`${teacher.name} already has ${pagesOf(s.existing_pages)} of ${s.label} answers${s.section === 'B' && s.paper ? ` for ${s.paper.title}` : ''}. These go after them.`);
    if (s.existing === 'marked') notes.push(`${teacher.name}’s ${s.label}${s.section === 'B' && s.paper ? ` (${s.paper.title})` : ''} is already marked. These pages start a new sitting for it in this test, and its newer marks replace the old.`);
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
    matching_metrics: result?.matching_metrics ?? null,
    compared_candidates: result?.candidate_paper_ids?.length ?? null,
    pages: pages.map((p) => ({ id: p.id, src: `/uploads/${p.stored_name}`, position: p.position, section: p.section, questions: p.questions, language: p.language, source_file: item.file_name, source_page: p.position, identity: result?.identity?.pages.find((e) => e.page_id === p.id) ?? null, match: result?.source_pages?.find((e) => e.page_id === p.id) ?? null })),
    sections,
    problems: problems.filter(Boolean),
    notes,
    ready: !problems.filter(Boolean).length,
  };
}

export function presentItems(schoolId, testId) {
  const items = selectItems.all(schoolId, testId).filter((item) => !isFinalizationLocked(item));
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
  const result = parse(item.result, {});
  const unused = pages.filter((p) => !p.section);
  const sittings = db.transaction(() => {
    const done = [];
    for (const key of GROUPS) {
      const mine = pages.filter((p) => p.section === key);
      if (!mine.length) continue;
      const section = sectionOf(key);
      const sitting = sittingForPaper(teacher, test, section, chosen[key]);
      attachStoredPages(
        sitting.id,
        'response',
        mine.map((page) => ({
          stored_name: page.stored_name,
          original_name: `${item.file_name} - source page ${page.position}${path.extname(page.stored_name) || '.jpg'}`,
          mime_type: page.mime_type,
          size_bytes: page.size_bytes,
        }))
      );
      for (const page of mine) {
        const source = {
          source_file: item.file_name, source_page: page.position, source_page_count: pages.length,
          teacher_id: teacher.id, teacher_name: teacher.name, teacher_grade: teacher.grade, teacher_subjects: teacher.subjects,
          identity: result.identity?.pages.find((p) => p.page_id === page.id) ?? null,
          original_match: result.source_pages?.find((p) => p.page_id === page.id) ?? null,
          filed_section: section, filed_group: key, administered_paper_id: chosen[key],
          identity_confirmed: item.matched_by === 'you',
          paper_confirmed: result.paper_confirmations?.[key] === chosen[key],
          page_confirmed: Object.hasOwn(result.page_confirmations ?? {}, page.id),
        };
        db.prepare("UPDATE assessment_files SET source_metadata = ? WHERE assessment_id = ? AND stored_name = ? AND kind = 'response'").run(JSON.stringify(source), sitting.id, page.stored_name);
      }
      setSittingPapers(sitting.id, [chosen[key]]);
      const subject = section === 'B' ? selectPaper.get(chosen[key])?.subject ?? '' : '';
      done.push({ teacher: { id: teacher.id, name: teacher.name }, section, subject, pages: mine.length, assessment_id: sitting.id });
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
// nothing is marked without it. Each sitting is marked as if its own Evaluate
// had been pressed, as many at once as the server's memory allows.
export const MARKING_AT_ONCE = boundedConcurrency(process.env.BULK_EVALUATION_CONCURRENCY, jobsAtOnce(100));

// The database owns queue intent. The in-memory queue limits throughput only.
// Injectable start/wait functions let restart, deduplication and 150-teacher
// batches be tested without contacting a model provider.
export function createEvaluationQueue({ database = db, start = startEvaluation, concurrency = MARKING_AT_ONCE,
  wait = () => new Promise((resolve) => setTimeout(resolve, 1000)), retain = keepAwake } = {}) {
  const select = database.prepare('SELECT id, ai_status, ai_error, evaluation_queue FROM assessments WHERE id = ?');
  const persist = database.prepare('UPDATE assessments SET evaluation_queue = ? WHERE id = ?');
  const fail = database.prepare("UPDATE assessments SET ai_status = 'failed', ai_error = ?, updated_at = datetime('now') WHERE id = ?");
  const pending = [];
  const active = new Set();
  const promises = new Set();
  const limit = boundedConcurrency(concurrency, Number.MAX_SAFE_INTEGER);
  const queued = () => pending.map((job) => job.id);
  const known = (id) => active.has(id) || pending.some((job) => job.id === id);
  const enqueue = (ids, marking) => {
    let added = 0;
    database.transaction(() => {
      for (const id of new Set(ids.map(Number))) {
        const row = select.get(id);
        if (!row || known(id) || row.ai_status === 'running' || row.evaluation_queue) continue;
        const job = { id, marking, state: 'queued', requested_at: new Date().toISOString() };
        persist.run(JSON.stringify(job), id);
        pending.push(job);
        added += 1;
      }
    })();
    return added;
  };
  const restore = () => {
    for (const row of database.prepare('SELECT id, ai_status, ai_error, evaluation_queue FROM assessments WHERE evaluation_queue IS NOT NULL ORDER BY id').all()) {
      if (known(row.id)) continue;
      const job = parse(row.evaluation_queue, null);
      if (!job || !['queued', 'running'].includes(job.state) || !MARKINGS.some((m) => m.key === job.marking)) {
        fail.run('The saved evaluation request is invalid. Choose Evaluate again.', row.id);
        persist.run(null, row.id);
        continue;
      }
      // Completion may have been committed immediately before shutdown. A
      // restart-interrupted job is distinct from an already terminal failure.
      if (job.state === 'running' && (row.ai_status === 'done' || (row.ai_status === 'failed' && !/server restarted/i.test(row.ai_error ?? '')))) {
        persist.run(null, row.id);
        continue;
      }
      const resumed = { ...job, id: row.id, state: 'queued' };
      persist.run(JSON.stringify(resumed), row.id);
      pending.push(resumed);
    }
    return pending.length;
  };
  const run = async (job) => {
    try {
      const row = select.get(job.id);
      if (!row) return;
      persist.run(JSON.stringify({ ...job, state: 'running' }), job.id);
      const problem = start(job.id, job.marking);
      if (problem) fail.run(problem, job.id);
      while (select.get(job.id)?.ai_status === 'running') await wait(job.id);
      const terminal = select.get(job.id);
      if (terminal && !['done', 'failed'].includes(terminal.ai_status)) {
        fail.run('Evaluation did not reach a completed result. Choose Evaluate to retry.', job.id);
      }
    } catch (error) {
      fail.run(error.userMessage ?? `Evaluation failed: ${error.message}`, job.id);
    } finally {
      // Clear only after success/failure is recorded (or the row was removed).
      const row = select.get(job.id);
      if (!row || ['done', 'failed'].includes(row.ai_status)) persist.run(null, job.id);
    }
  };
  const pump = () => {
    while (active.size < limit && pending.length) {
      const job = pending.shift();
      active.add(job.id);
      const promise = run(job).finally(() => {
        active.delete(job.id);
        promises.delete(promise);
        pump();
      });
      promises.add(promise);
      retain(promise);
    }
  };
  const idle = async () => { while (promises.size) await Promise.all([...promises]); };
  return { enqueue, restore, pump, queued, active: () => [...active], idle };
}

const markingQueue = createEvaluationQueue();
markingQueue.restore();
setImmediate(() => markingQueue.pump());

export function evaluateSittings(ids, markingChoice) {
  if (ids.some((id) => db.prepare("SELECT 1 FROM assessments WHERE id = ? AND status = 'assembling'").get(id))) return 'This submission batch is still being assembled.';
  if (!MARKINGS.some((m) => m.key === markingChoice)) return 'Choose Standard marking.';
  markingQueue.enqueue(ids, markingChoice);
  markingQueue.pump();
  return null;
}

// Queued work is not offered again as an unmarked sitting.
export const queuedForMarking = () => markingQueue.queued();

// The sittings of a test with no marks that are not being marked: those whose
// marking failed, with the reason, and those waiting for Evaluate (answer
// pages filed, Evaluate not pressed yet, or left waiting when the server
// restarted). The dashboard and the board offer to evaluate each group at once.
const selectUnmarked = db.prepare(`
  SELECT a.id, a.section, a.subject, a.ai_status, a.ai_error, t.id AS teacher_id, t.name AS teacher_name,
         EXISTS (SELECT 1 FROM assessment_files f WHERE f.assessment_id = a.id AND f.kind = 'response') AS has_answers
    FROM assessments a
    JOIN teachers t ON t.id = a.teacher_id
   WHERE a.school_id = ? AND a.test_id = ? AND (a.status NOT IN ('evaluated', 'finalized') OR a.ai_status = 'failed') AND a.ai_status != 'running' AND a.status != 'assembling'
   ORDER BY t.name COLLATE NOCASE, a.section, a.id
`);

export function unmarkedSittings(schoolId, testId) {
  const queued = new Set(queuedForMarking());
  const failed = [];
  const waiting = [];
  for (const row of selectUnmarked.all(schoolId, testId)) {
    if (queued.has(row.id)) continue;
    const sitting = {
      id: row.id,
      teacher: { id: row.teacher_id, name: row.teacher_name },
      paper: row.section ? `Section ${row.section}${row.section === 'B' && row.subject ? ` (${row.subject})` : ''}` : 'Full paper',
    };
    if (row.ai_status === 'failed') failed.push({ ...sitting, error: row.ai_error || 'The marking did not finish.' });
    else if (row.has_answers) waiting.push(sitting);
  }
  return { failed, waiting };
}

// Evaluate pressed once for every sitting of a test whose marking failed
// (`which` is 'failed') or that is waiting for Evaluate ('waiting'), with one
// Standard or Lenient choice. Returns how many were started, or the problem.
export function evaluateUnmarked(schoolId, testId, which, markingChoice) {
  const sittings = unmarkedSittings(schoolId, testId)[which];
  if (!Array.isArray(sittings)) return { error: 'Say which papers to evaluate.' };
  if (!sittings.length) return { started: 0 };
  const problem = evaluateSittings(sittings.map((sitting) => sitting.id), markingChoice);
  return problem ? { error: problem } : { started: sittings.length };
}

export function markingState(ids) {
  return ids.map((id) => {
    const row = db.prepare('SELECT id, ai_status, ai_error, status, evaluation_progress FROM assessments WHERE id = ?').get(id);
    const queued = markingQueue.queued().includes(id);
    return row ? { id, state: queued ? 'queued' : row.ai_status, error: row.ai_error, progress: parse(row.evaluation_progress, null) } : { id, state: 'gone' };
  });
}


/* ------------------------------------------ evidence-bounded finalization */

const FINALIZATION_VERSION = 'bulk-finalization-v1';
const isFinalizationLocked = (item) => Boolean(item && ['finalization_waiting', 'finalizing', 'finalization_failed', 'finalized'].includes(item.sort_status));
const finalizationWaiting = [];
const finalizationActive = new Set();

// All compatible masters are inspected in full, including low-ranked variants.
// Both manual matching and finalization inspect the complete compatible bank;
// catalogue ranking is never evidence of the administered version.
export function finalizationCandidates(teacher, school, library) {
  return library.filter((paper) => PAPER_SECTIONS.some((section) => !paperCompatibilityProblem(paper, teacher, school, section)));
}

function bulkSourceBasis(id) {
  const item = selectItem.get(id);
  if (!item) return null;
  const prior = parse(item.result, {});
  return {
    version: FINALIZATION_VERSION,
    config: { model: OPENAI_MODEL, reading_model: GEMINI_MODEL, reading_version: READING_VERSION, prompts: digest([LOOK_INSTRUCTIONS, LOOK_SCHEMA, SORT_INSTRUCTIONS, SORT_SCHEMA]) },
    item: { id: item.id, school_id: item.school_id, test_id: item.test_id, file_name: item.file_name,
      teacher_id: item.teacher_id, matched_by: item.matched_by, papers: item.papers },
    confirmations: { papers: prior.paper_confirmations ?? {}, pages: prior.page_confirmations ?? {} },
    school: selectSchool.get(item.school_id), teachers: selectSchoolTeachers.all(item.school_id),
    pages: selectPages.all(id).map(fileBasis), library: allPapers().map(fileBasis),
  };
}

function saveFinalization(id, state) {
  const row = selectItem.get(id);
  if (!row) throw friendly('This submission no longer exists.');
  setResult.run(JSON.stringify({ ...parse(row.result, {}), finalization: state }), id);
}

// Independently resolve each page. Mixed PDFs can be split, but a manual
// selection, filename or model-chosen ID cannot override a definite name.
export function finalizationOwners(item, pages, identity, teachers, conflicts = []) {
  const conflictSet = new Set(conflicts);
  const namedIds = new Set(identity.pages.filter((p) => p.teacher_id).map((p) => p.teacher_id));
  const fromFile = teacherFromFileName(item.file_name, teachers);
  return pages.map((page) => {
    const seen = identity.complete ? identity.pages.find((p) => p.page_id === page.id) : null;
    if (!seen || conflictSet.has(page.id)) return { page_id: page.id, teacher_id: null, reason_code: 'identity_unresolved' };
    let teacher = teachers.find((t) => t.id === seen.teacher_id);
    if (!teacher && item.matched_by === 'you') teacher = teachers.find((t) => t.id === item.teacher_id);
    if (!teacher && !seen.name_written && fromFile && (!namedIds.size || (namedIds.size === 1 && namedIds.has(fromFile.id)))) teacher = fromFile;
    if (!teacher || (seen.name_written && definiteNameConflict(teacher.name, seen.name_written)) ||
        !contextFits(teacher, seen.grade_written, seen.subjects_written)) return { page_id: page.id, teacher_id: null, reason_code: 'identity_unresolved' };
    const explicitUnknownSubject = seen.subjects_written && !subjectKeys(seen.subjects_written).size && teacher.subjects &&
      !String(teacher.subjects).split(/[,;/|]/).some((subject) => identityName(subject) === identityName(seen.subjects_written));
    if (explicitUnknownSubject) return { page_id: page.id, teacher_id: null, reason_code: 'identity_unresolved' };
    return { page_id: page.id, teacher_id: teacher.id, reason_code: null };
  });
}

function definiteObservationConflicts(first, next, library) {
  if (!first?.complete || !Array.isArray(next?.pages)) return [];
  return first.pages.filter((old) => {
    const fresh = next.pages.find((p) => p.page_id === old.page_id);
    return fresh && ((old.name_confidence === 'certain' && fresh.name_confidence === 'certain' && definiteNameConflict(old.name_written, fresh.name_written)) ||
      (namedMaster(old.paper_title_written, library).paper && namedMaster(fresh.paper_title_written, library).paper &&
        namedMaster(old.paper_title_written, library).paper.id !== namedMaster(fresh.paper_title_written, library).paper.id) ||
      !contextFits({ grade: old.grade_written, subjects: old.subjects_written }, fresh.grade_written, fresh.subjects_written));
  }).map((p) => p.page_id);
}

// One terminal record covers every original page exactly once. Originals stay
// owned by bulk_pages; assessments receive distinct copies so deleting an
// assessment attachment cannot destroy this submission's retained source.
export async function finalizeBulkItem(id, { request = requestJson, configured = openaiConfigured,
  evaluate = true, unavailable = finalizeUnavailable } = {}) {
  let item = selectItem.get(id);
  if (!item) return null;
  const original = parse(item.result, {});
  if (item.sort_status === 'finalized' && original.finalization?.outcome) return original.finalization.outcome;
  if (['waiting', 'running'].includes(item.sort_status)) throw friendly('This submission is already being matched.');
  setStatus.run('finalizing', null, id);
  const source = bulkSourceBasis(id), basis = digest(source);
  let work = original.finalization;
  work = work?.basis === basis && work.version === FINALIZATION_VERSION ? work : {
    version: FINALIZATION_VERSION, basis, batch_id: original.finalization?.batch_id ?? `submission-${id}`, state: 'running', identity_attempts: 0, identity: null, conflicts: [], matches: {},
  };
  work.batch_id ??= original.finalization?.batch_id ?? `submission-${id}`;
  work.state = 'running';
  saveFinalization(id, work);
  const unchanged = () => {
    if (digest(bulkSourceBasis(id)) !== basis) throw friendly('The submission sources changed during finalization.');
  };
  const { pages, teachers, school } = source;
  const availablePages = pages.filter((p) => p.sha256 !== 'missing' && OPENAI_IMAGE_TYPES.has(p.mime_type));
  const files = availablePages.map((p) => ({ ...p, original_name: `${item.file_name} - source page ${p.position}` }));
  let identity = work.identity;
  let owners = identity ? finalizationOwners(item, pages, identity, teachers, work.conflicts) : [];
  const readableSources = files.length > 0;
  if (configured() && readableSources) {
    while (work.identity_attempts < 2 && (!identity?.complete || owners.some((p) => !p.teacher_id && availablePages.some((s) => s.id === p.page_id)))) {
      const focus = owners.filter((p) => !p.teacher_id).map((p) => pages.find((s) => s.id === p.page_id)?.position);
      work.identity_attempts += 1;
      saveFinalization(id, work); // Reserve the attempt before the provider call.
      try {
        unchanged();
        const look = await request({ instructions: LOOK_INSTRUCTIONS + (work.identity_attempts > 1
          ? `\nFOCUSED REREAD: inspect ambiguous identity fields on source pages ${focus.join(', ') || 'all'}. Use the original images. Do not replace an earlier definite contradictory name merely to resolve uncertainty.` : ''),
          content: [{ type: 'input_text', text: `TEACHERS: ${JSON.stringify(teachers)}\nSOURCE FILE: ${item.file_name}` }, ...await pageInputs('ANSWER SHEETS', files)],
          name: 'answer_sheets_first_look', schema: LOOK_SCHEMA, maxRetries: 1, timeoutMs: 120000, task: 'read the source identities', retry: 'The submission will retain any unassessable evidence.' });
        unchanged();
        const observed = retainMasterObservations(identity, inspectIdentity(item, availablePages, look, teachers), source.library);
        if (observed.complete) work.languages = availablePages.map((p, i) => ({ page_id: p.id, language: look.pages.find((seen) => seen.page === i + 1)?.language ?? 'mixed', languages: look.pages.find((seen) => seen.page === i + 1)?.languages ?? [] }));
        work.conflicts = [...new Set([...work.conflicts, ...definiteObservationConflicts(identity, observed, source.library)])];
        // Keep certain earlier page observations when the focused reread is
        // less specific; it cannot erase a source-written master or identity.
        if (identity?.complete && observed.complete) for (const p of observed.pages) {
          const old = identity.pages.find((s) => s.page_id === p.page_id);
          if (old?.paper_title_written && !p.paper_title_written) p.paper_title_written = old.paper_title_written;
          if (old?.paper_title_written && p.paper_title_written !== old.paper_title_written) p.previous_paper_title_written = old.paper_title_written;
          if (old?.grade_written && !p.grade_written) p.grade_written = old.grade_written;
          if (old?.subjects_written && !p.subjects_written) p.subjects_written = old.subjects_written;
          if (old?.name_confidence === 'certain' && p.name_confidence !== 'certain') Object.assign(p, old);
        }
        if (!identity?.complete || observed.complete) identity = work.identity = observed;
        owners = finalizationOwners(item, pages, identity, teachers, work.conflicts);
        work.identity_error = null;
      } catch (error) {
        unchanged();
        work.identity_error = String(error.userMessage ?? error.message);
      }
      saveFinalization(id, work);
    }
  }
  unchanged();
  owners = identity ? finalizationOwners(item, pages, identity, teachers, work.conflicts) : pages.map((p) => ({ page_id: p.id, teacher_id: null, reason_code: 'identity_unresolved' }));
  // Use the established multilingual reading path when available; an OCR
  // outage never suppresses the original images used for content matching.
  if (configured() && readableSources && geminiConfigured() && !work.reading_attempted) {
    work.reading_attempted = true;
    saveFinalization(id, work);
    const nonEnglish = files.filter((p) => work.languages?.some((l) => l.page_id === p.id && l.language !== 'english'));
    if (nonEnglish.length) {
      try {
        const languages = [...new Set((work.languages ?? []).flatMap((p) => p.languages))];
        const readings = await readAnswers(nonEnglish, languages);
        work.readings = nonEnglish.map((p, i) => ({ page_id: p.id, text: readings[i] }));
      } catch (error) { work.reading_error = String(error.userMessage ?? error.message); }
      unchanged(); saveFinalization(id, work);
    }
  }
  const decisions = pages.map((p) => ({ page_id: p.id, source_page: p.position, source_available: p.sha256 !== 'missing', teacher_id: owners.find((o) => o.page_id === p.id)?.teacher_id ?? null,
    section: null, paper_id: null, state: 'unassigned', reason_code: availablePages.some((a) => a.id === p.id) ? 'identity_unresolved' : 'source_unavailable' }));
  const knownTeachers = [...new Set(owners.map((p) => p.teacher_id).filter(Boolean))];
  for (const teacherId of knownTeachers) {
    const teacher = teachers.find((t) => t.id === teacherId);
    const mine = pages.filter((p) => owners.some((o) => o.page_id === p.id && o.teacher_id === teacherId));
    const checkpoint = work.matches[teacherId] ??= { attempts: 0, plan: null, conflicts: [] };
    const candidates = finalizationCandidates(teacher, school, source.library).filter((p) => p.sha256 !== 'missing');
    const evidence = { identity, candidate_paper_ids: candidates.map((p) => p.id),
      paper_confirmations: teacher.id === item.teacher_id ? original.paper_confirmations ?? {} : {},
      page_confirmations: teacher.id === item.teacher_id ? original.page_confirmations ?? {} : {} };
    let plan = checkpoint.plan;
    if (configured() && candidates.length && readableSources) {
      while (checkpoint.attempts < 2 && (!plan?.complete || plan.sourcePages.some((p) => p.issues.length))) {
        checkpoint.attempts += 1;
        saveFinalization(id, work);
        try {
          unchanged();
          const sorted = await compareQuestionBank({ candidates, request, answerPageCount: mine.length, instructions: SORT_INSTRUCTIONS + '\nSUPPLIED BLANK ANSWER SHEETS: If an answer sheet explicitly names an exact compatible single-section administered master, retain that section and paper_id even when all answer spaces are blank; set has_answers false. This is a supplied section, not an absent section. Explain the exact printed title/section evidence with high confidence only when unambiguous. Cover sheets and loose blank pages without that evidence remain unassigned; never infer a blank answer sheet from failed reading.' + (checkpoint.attempts > 1
            ? `\nFOCUSED REMATCH: re-inspect unresolved source pages and their response content against ALL supplied compatible masters. Earlier observations: ${JSON.stringify(plan?.sourcePages ?? [])}. Keep genuine conflicts unresolved; never choose the nearest-looking paper.` : ''),
            content: [{ type: 'input_text', text: `TEACHER: ${JSON.stringify(teacher)}\nAUTHORITATIVE MASTER CONFIRMATIONS: ${JSON.stringify(evidence.paper_confirmations)}\nSOURCE IDENTITY/TITLES: ${JSON.stringify(identity.pages.filter((p) => mine.some((m) => m.id === p.page_id)))}` },
              ...await pageInputs('ANSWER SHEETS', mine.map((p) => ({ ...p, original_name: `${item.file_name} source page ${p.position}` }))),
              ...(work.readings ?? []).filter((r) => r.text && mine.some((p) => p.id === r.page_id)).map((r) => ({ type: 'input_text', text: `Supporting transcription for source page ${pages.find((p) => p.id === r.page_id).position}; verify against its image: ${r.text}` }))],
            name: 'answer_sheets_sorted', schema: SORT_SCHEMA, maxRetries: 1, timeoutMs: 120000, task: 'align the supplied responses with their administered papers', retry: 'Any unassessable evidence will be retained.' });
          unchanged();
          checkpoint.bank_comparison = sorted.bank_comparison ?? null;
          const reconciled = retainAnswerPresence(sorted, mine, [...(plan?.sourcePages ?? []), ...(original.source_pages ?? [])]);
          const next = buildSortPlan(teacher, school, source.library, mine, reconciled, evidence, { allowSuppliedBlank: true });
          if (plan?.complete && next.complete) for (const p of next.sourcePages) {
            const old = plan.sourcePages.find((s) => s.page_id === p.page_id);
            if (old && !old.issues.length && !p.issues.length && (old.paper_id !== p.paper_id || old.section !== p.section)) checkpoint.conflicts.push(p.page_id);
            // A focused retry cannot discard an independently safe first-pass
            // match merely because another page remained unassessable.
            if (old && !old.issues.length && p.issues.length) Object.assign(p, old);
          }
          // Malformed retry output cannot erase a validated first-pass map.
          if (!plan?.complete || next.complete) plan = checkpoint.plan = next;
          checkpoint.error = next.complete ? null : 'The focused response did not account for every source page.';
        } catch (error) {
          unchanged();
          checkpoint.error = String(error.userMessage ?? error.message);
        }
        saveFinalization(id, work);
      }
    }
    for (const page of mine) {
      const decision = decisions.find((d) => d.page_id === page.id);
      const matched = plan?.complete && plan.sourcePages.find((p) => p.page_id === page.id);
      const safe = matched && !matched.issues.length && !checkpoint.conflicts.includes(page.id);
      Object.assign(decision, { state: 'no_assessment', reason_code: configured() ? 'paper_unavailable' : 'assessment_unavailable' });
      if (safe && matched.section && matched.paper_id) Object.assign(decision, { section: matched.section, paper_id: matched.paper_id, state: 'filed', reason_code: null });
      else if (safe && matched.has_answers === false) Object.assign(decision, { state: 'retained', reason_code: 'no_answer_content' });
    }
  }
  unchanged();
  const copies = [];
  const attachable = decisions.filter((d) => ['filed', 'no_assessment'].includes(d.state));
  for (const decision of attachable) {
    const page = pages.find((p) => p.id === decision.page_id);
    const copied = `finalized-${item.id}-${page.id}-${page.sha256.slice(0, 16)}${path.extname(page.stored_name)}`;
    await fs.copyFile(path.join(UPLOADS_DIR, page.stored_name), path.join(UPLOADS_DIR, copied));
    copies.push({ ...page, stored_name: copied });
  }
  unchanged();
  const outcome = db.transaction(() => {
    unchanged();
    const current = parse(selectItem.get(id)?.result, {}).finalization;
    if (current?.outcome) return current.outcome;
    const groups = new Map();
    for (const d of attachable) {
      const key = `${d.teacher_id}|${d.state}|${d.section || ''}|${d.paper_id || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    const filed = [], unavailableIds = [];
    for (const group of groups.values()) {
      const first = group[0], teacher = teachers.find((t) => t.id === first.teacher_id);
      // All PDFs in this explicit batch share one fresh sitting for the
      // same teacher/section/master. Marking cannot start until every source
      // outcome in the batch commits, so no running assessment is modified.
      const existing = first.state === 'filed' ? db.prepare(`SELECT DISTINCT a.id FROM assessments a
        JOIN assessment_files f ON f.assessment_id = a.id
        JOIN assessment_papers ap ON ap.assessment_id = a.id
        WHERE a.school_id = ? AND a.test_id = ? AND a.teacher_id = ? AND a.section IS ?
          AND ap.paper_id = ? AND a.ai_status = 'none' AND a.status = 'assembling' AND a.evaluation_queue IS NULL
          AND json_valid(f.source_metadata) AND json_extract(f.source_metadata, '$.finalization_batch_id') = ?
        ORDER BY a.id LIMIT 1`).get(item.school_id, item.test_id, teacher.id, first.section, first.paper_id, work.batch_id) : null;
      const assessmentId = existing?.id ?? Number(db.prepare(`INSERT INTO assessments (school_id, teacher_id, test_id, section, title, assessment_date, subject, status)
        VALUES (?, ?, ?, ?, ?, date('now'), ?, 'draft')`).run(item.school_id, teacher.id, item.test_id, first.section,
        `${source.school.name} - ${teacher.name} - Submission ${id}${first.section ? ` - Section ${first.section}` : ''}`,
        first.paper_id ? source.library.find((p) => p.id === first.paper_id)?.subject ?? '' : '').lastInsertRowid);
      const groupPages = group.map((d) => copies.find((p) => p.id === d.page_id));
      attachStoredPages(assessmentId, 'response', groupPages.map((p) => ({ stored_name: p.stored_name,
        original_name: `${item.file_name} - source page ${p.position}${path.extname(p.stored_name)}`, mime_type: p.mime_type, size_bytes: p.size_bytes })), { allowAssembling: true });
      for (const d of group) {
        const copied = copies.find((p) => p.id === d.page_id);
        const metadata = { source_file: item.file_name, source_page: d.source_page, source_page_count: pages.length,
          bulk_item_id: id, bulk_page_id: d.page_id, finalization_batch_id: work.batch_id, teacher_id: teacher.id, teacher_name: teacher.name,
          identity: identity.pages.find((p) => p.page_id === d.page_id), identity_confirmed: item.matched_by === 'you' && item.teacher_id === teacher.id,
          administered_paper_id: d.paper_id, filed_section: d.section, finalization_basis: basis,
          unresolved_sibling_pages: decisions.filter((p) => p.state === 'unassigned' || (p.state === 'no_assessment' && p.teacher_id === teacher.id))
            .map((p) => ({ source_page: p.source_page, reason_code: p.reason_code })),
          original_match: work.matches[teacher.id]?.plan?.sourcePages.find((p) => p.page_id === d.page_id) ?? null };
        db.prepare('UPDATE assessment_files SET source_metadata = ? WHERE assessment_id = ? AND stored_name = ?').run(JSON.stringify(metadata), assessmentId, copied.stored_name);
        d.assessment_id = assessmentId;
      }
      if (first.paper_id) {
        setSittingPapers(assessmentId, [first.paper_id]);
        db.prepare("UPDATE assessments SET status = 'assembling' WHERE id = ?").run(assessmentId);
      }
      if (first.state === 'filed') filed.push({ assessment_id: assessmentId, teacher: { id: teacher.id, name: teacher.name }, section: first.section, paper_id: first.paper_id, pages: group.length });
      else unavailableIds.push({ assessment_id: assessmentId, reason_code: first.reason_code, teacher: { id: teacher.id, name: teacher.name } });
    }
    const result = { version: FINALIZATION_VERSION, batch_id: work.batch_id, item_id: id, file_name: item.file_name, basis, completed_at: new Date().toISOString(),
      pages: decisions, filed, unavailable: unavailableIds };
    work.state = 'finalized'; work.outcome = result;
    saveFinalization(id, work);
    setStatus.run('finalized', null, id);
    // Snapshot-only no-assessment creation has no provider dependency. Parent
    // helper runs synchronously after the attached source rows are visible.
    for (const row of unavailableIds) unavailable(row.assessment_id, row.reason_code, '', { queueReports: false });
    return result;
  })();
  if (evaluate) flushFinalizationBatch(work.batch_id);
  return outcome;
}

function finalizationBatchItems(batchId) {
  return db.prepare("SELECT * FROM bulk_items WHERE json_valid(result) AND json_extract(result, '$.finalization.batch_id') = ? ORDER BY id").all(batchId);
}

export function flushFinalizationBatch(batchId) {
  const items = finalizationBatchItems(batchId);
  if (!items.length || items.some((item) => item.sort_status !== 'finalized')) return false;
  const outcomes = items.map((item) => parse(item.result, {}).finalization.outcome);
  const filed = outcomes.flatMap((outcome) => outcome.filed);
  const dispatched = items.every((item) => parse(item.result, {}).finalization.dispatched === true);
  if (!dispatched) {
    const staleSources = items.some((item, i) => digest(bulkSourceBasis(item.id)) !== outcomes[i].basis);
    const changedAttachments = [...new Set(filed.map((row) => row.assessment_id))].some((id) => {
      const expected = outcomes.flatMap((outcome) => outcome.pages.filter((p) => p.state === 'filed' && p.assessment_id === id)
        .map((p) => ({ ...p, item_id: outcome.item_id })));
      const reference = filed.find((row) => row.assessment_id === id);
      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
      const papers = db.prepare('SELECT paper_id FROM assessment_papers WHERE assessment_id = ?').all(id);
      const files = db.prepare("SELECT * FROM assessment_files WHERE assessment_id = ? ORDER BY position, id").all(id);
      if (!assessment || assessment.status !== 'assembling' || assessment.ai_status !== 'none' || assessment.teacher_id !== reference.teacher.id || assessment.section !== reference.section ||
          papers.length !== 1 || papers[0].paper_id !== reference.paper_id || files.length !== expected.length || files.some((f) => f.kind !== 'response')) return true;
      const seen = new Set();
      return files.some((file) => {
        const metadata = parse(file.source_metadata, {});
        const match = expected.find((p) => p.item_id === metadata.bulk_item_id && p.page_id === metadata.bulk_page_id);
        const key = `${metadata.bulk_item_id}:${metadata.bulk_page_id}`;
        const source = match && selectPages.all(match.item_id).find((p) => p.id === match.page_id);
        if (!match || seen.has(key) || !source || fileBasis(file).sha256 !== fileBasis(source).sha256) return true;
        seen.add(key); return false;
      });
    });
    if (staleSources || changedAttachments) {
      db.transaction(() => {
        const invalidatedIds = new Set(outcomes.flatMap((outcome) => [...outcome.filed, ...outcome.unavailable]).map((row) => row.assessment_id));
        for (const id of invalidatedIds) {
          const previous = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
          if (!previous || (previous.ai_status !== 'none' && parse(previous.ai_result, {})?.outcome !== 'no_assessment')) continue;
          db.prepare("UPDATE assessments SET status = 'finalized', ai_status = 'done', ai_result = NULL, score = NULL, max_score = NULL, ai_error = NULL, evaluation_checkpoint = ?, evaluation_progress = ? WHERE id = ?").run(
            JSON.stringify({ superseded_result: parse(previous.ai_result, null), reason_code: 'batch_sources_changed', batch_id: batchId }),
            JSON.stringify({ stage: 'superseded', reason_code: 'batch_sources_changed', batch_id: batchId }), id);
        }
        for (const item of items) {
          const result = parse(item.result, {}), previous = result.finalization;
          result.finalization = { version: FINALIZATION_VERSION, batch_id: batchId, state: 'failed', basis: null,
            invalidated_outcome: previous.outcome, error: 'The submission sources changed before batch assessment began.' };
          setResult.run(JSON.stringify(result), item.id); setStatus.run('finalization_failed', null, item.id);
        }
      })();
      return false;
    }
    db.transaction(() => {
      const ids = [];
      for (const id of new Set(filed.map((row) => row.assessment_id))) {
        const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
        const contributorIds = new Set(outcomes.filter((outcome) => outcome.pages.some((p) => p.assessment_id === id)).map((outcome) => outcome.item_id));
        const unresolved = outcomes.flatMap((outcome) => outcome.pages
          .filter((p) => (p.state === 'unassigned' && contributorIds.has(outcome.item_id)) || (p.state === 'no_assessment' && p.teacher_id === assessment.teacher_id))
          .map((p) => ({ source_file: outcome.file_name, source_page: p.source_page, reason_code: p.reason_code })));
        for (const file of db.prepare("SELECT id, source_metadata FROM assessment_files WHERE assessment_id = ? AND kind = 'response'").all(id)) {
          const metadata = parse(file.source_metadata, {}); metadata.unresolved_sibling_pages = unresolved;
          db.prepare('UPDATE assessment_files SET source_metadata = ? WHERE id = ?').run(JSON.stringify(metadata), file.id);
        }
        const ordered = db.prepare("SELECT id, source_metadata FROM assessment_files WHERE assessment_id = ? AND kind = 'response'").all(id)
          .sort((a, b) => { const x = parse(a.source_metadata, {}), y = parse(b.source_metadata, {}); return x.bulk_item_id - y.bulk_item_id || x.source_page - y.source_page || a.id - b.id; });
        ordered.forEach((file, index) => db.prepare('UPDATE assessment_files SET position = ? WHERE id = ?').run(index + 1, file.id));
        db.prepare("UPDATE assessments SET status = 'scanned' WHERE id = ?").run(id); ids.push(id);
      }
      for (const item of items) { const work = parse(selectItem.get(item.id).result, {}).finalization; work.dispatched = true; saveFinalization(item.id, work); }
      if (ids.length) markingQueue.enqueue(ids, 'standard');
    })();
  }
  markingQueue.pump();
  const unavailableTeachers = outcomes.flatMap((outcome) => outcome.unavailable.map((row) => row.teacher.id));
  for (const teacherId of new Set(unavailableTeachers)) {
    const report = findReport('teacher', items[0].test_id, teacherId);
    if (!report?.content || report.status === 'failed' || isOutOfDate(report, teacherResults(teacherId, items[0].test_id))) queueTeacherReports(teacherId, items[0].test_id);
  }
  return true;
}

export function finalizationState(schoolId, testId) {
  return selectItems.all(schoolId, testId).filter(isFinalizationLocked).map((item) => {
    const work = parse(item.result, {}).finalization ?? {};
    const outcome = work.outcome;
    const assessments = outcome ? [...outcome.filed.map((f) => f.assessment_id), ...outcome.unavailable.map((f) => f.assessment_id)] : [];
    const marking = assessments.length ? markingState(assessments) : [];
    const active = marking.some((m) => ['queued', 'running'].includes(m.state));
    const batchItems = work.batch_id ? finalizationBatchItems(work.batch_id) : [];
    const blocked = outcome?.filed.length && batchItems.some((i) => i.sort_status === 'finalization_failed');
    const assembling = outcome?.filed.length && batchItems.some((i) => i.sort_status !== 'finalized');
    return { item_id: item.id, file_name: item.file_name, state: item.sort_status === 'finalization_failed' || blocked ? 'failed' : item.sort_status !== 'finalized' || assembling ? 'running' : active ? 'assessing' : 'finalized',
      error: item.sort_status === 'finalization_failed' || blocked ? 'This submission changed or could not be saved. Its original pages are retained. Retry finalization with the current sources.' : null,
      retry_ids: blocked || item.sort_status === 'finalization_failed' ? batchItems.filter((i) => i.sort_status === 'finalization_failed').map((i) => i.id) : [],
      source_outcome: outcome ? outcome.pages.every((p) => p.state === 'unassigned') ? 'unassigned' : outcome.filed.length ? 'filed' : 'no_assessment' : null,
      filed: outcome?.filed ?? [], unavailable: outcome?.unavailable ?? [], marking,
      unassessed_pages: outcome?.pages.filter((p) => ['unassigned', 'no_assessment'].includes(p.state)).map((p) => p.source_page) ?? [],
      source_pages: selectPages.all(item.id).map((p) => ({ source_page: p.position, src: `/uploads/${p.stored_name}` })),
      download_url: item.sort_status === 'finalization_failed' || blocked || (outcome && !active && !assembling) ? `/api/bulk/${item.id}/outcome` : null };
  });
}

export function finalizationOutcome(id, { statusOnly = false } = {}) {
  const item = selectItem.get(Number(id));
  if (!item || !['finalized', 'finalization_failed'].includes(item.sort_status)) return null;
  const context = { school: selectSchool.get(item.school_id), test: selectTest.get(item.test_id) };
  if (statusOnly || item.sort_status === 'finalization_failed') return { ...context, item_id: item.id, file_name: item.file_name,
    processing_state: 'failed', teachers: [], filed: [], unavailable: [],
    pages: selectPages.all(item.id).map((p) => ({ page_id: p.id, source_page: p.position, source_available: fileBasis(p).sha256 !== 'missing',
      state: 'unassigned', teacher_id: null, reason_code: 'assessment_unavailable' })) };
  const outcome = parse(item.result, {}).finalization?.outcome;
  if (!outcome) return null;
  return { ...outcome, ...context,
    teachers: selectSchoolTeachers.all(item.school_id).filter((t) => outcome.pages.some((p) => p.teacher_id === t.id)) };
}

function pumpFinalizations() {
  while (finalizationActive.size < MATCHING_AT_ONCE && finalizationWaiting.length) {
    const id = finalizationWaiting.shift();
    if (finalizationActive.has(id)) continue;
    finalizationActive.add(id);
    keepAwake(finalizeBulkItem(id).catch((error) => {
      // A changed source or database fault is a genuine operational failure,
      // never a successful assessment. Preserve the sources and diagnostic.
      const item = selectItem.get(id);
      if (item) { const result = parse(item.result, {}); result.finalization ??= {}; result.finalization.state = 'failed';
        result.finalization.error = String(error.userMessage ?? error.message); setResult.run(JSON.stringify(result), id); setStatus.run('finalization_failed', null, id); }
    }).finally(() => { finalizationActive.delete(id); pumpFinalizations(); }));
  }
}

export function queueFinalizations(schoolId, testId, ids = null) {
  const added = [];
  const batchId = `batch-${schoolId}-${testId}-${Date.now()}-${digest(`${Math.random()}`).slice(0, 12)}`;
  db.transaction(() => {
    for (const item of selectItems.all(schoolId, testId)) {
      if ((ids && !ids.includes(item.id)) || ['waiting', 'running', 'finalized'].includes(item.sort_status) || finalizationActive.has(item.id) || finalizationWaiting.includes(item.id)) continue;
      const result = parse(item.result, {});
      result.finalization = { ...result.finalization, batch_id: result.finalization?.batch_id ?? batchId, state: 'queued' };
      setResult.run(JSON.stringify(result), item.id);
      setStatus.run('finalization_waiting', null, item.id);
      added.push(item.id);
    }
  })();
  finalizationWaiting.push(...added);
  pumpFinalizations();
  return { started: added.length, finalizations: finalizationState(schoolId, testId) };
}

for (const { id } of db.prepare("SELECT id FROM bulk_items WHERE sort_status IN ('finalization_waiting', 'finalizing') ORDER BY id").all()) finalizationWaiting.push(id);
setImmediate(() => {
  pumpFinalizations();
  for (const { batch_id } of db.prepare("SELECT DISTINCT json_extract(result, '$.finalization.batch_id') AS batch_id FROM bulk_items WHERE sort_status = 'finalized' AND json_valid(result)").all()) if (batch_id) flushFinalizationBatch(batch_id);
});
