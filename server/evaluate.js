// Grounded, resumable evaluation: extract the administered paper and its
// provisional rubric, independently transcribe/match responses, then mark and
// validate. Only validated rows can reach saved results and report aggregates.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import db, { UPLOADS_DIR } from './db.js';
import { OPENAI_MODEL, friendly, openaiConfigured, requestJson } from './openai.js';
import { GEMINI_MODEL } from './gemini.js';
import { answerLanguage, readAnswers, READING_VERSION } from './reading.js';
import { queueTeacherReports } from './reports.js';
import { swapScanKinds } from './scans.js';
import { sittingPapers, paperCompatibilityProblem } from './papers.js';
import { counts, markingOf, sectionKey } from './results.js';
import { OPENAI_IMAGE_TYPES, pageInputs, questionPaperInputs, readingInputs } from './paper-inputs.js';
import { checkWriting, writingOf, WRITING_VERSION } from './writing.js';
import { keepAwake } from './idle.js';
import { currentSourceBasis, digest } from './provenance.js';
import { PIPELINE_VERSION, RUBRIC_POLICY, PAPER_SCHEMA, RESPONSE_SCHEMA, MARK_SCHEMA,
  PAPER_INSTRUCTIONS, RESPONSE_INSTRUCTIONS, MARK_INSTRUCTIONS,
  validatePaper, validateResponse, validateMarks } from './grounding.js';

const selectAssessment = db.prepare('SELECT * FROM assessments WHERE id = ?');
const selectFiles = db.prepare('SELECT * FROM assessment_files WHERE assessment_id = ? AND kind = ? ORDER BY position, id');
const markFailed = db.prepare("UPDATE assessments SET ai_status = 'failed', ai_error = ?, updated_at = datetime('now') WHERE id = ?");
const saveResult = db.prepare(`UPDATE assessments SET ai_status = 'done', ai_error = NULL,
  ai_result = @result, ai_model = @model, ai_evaluated_at = datetime('now'),
  score = @score, max_score = @max_score, status = 'evaluated', updated_at = datetime('now') WHERE id = @id`);
const saveCheckpoint = db.prepare('UPDATE assessments SET evaluation_checkpoint = ?, evaluation_progress = ? WHERE id = ?');
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function startEvaluation(assessmentId, marking = 'standard') {
  const assessment = selectAssessment.get(assessmentId);
  if (!assessment) return 'Assessment not found.';
  if (!openaiConfigured()) return 'OpenAI is not set up on the server: the OPENAI_API_KEY secret is missing.';
  if (assessment.ai_status === 'running') return null;
  if (marking !== 'standard') return 'Use Standard marking: unanswered questions in a supplied complete section score zero. Entire sections not supplied are excluded.';
  const paper = selectFiles.all(assessment.id, 'question_paper');
  const library = sittingPapers(assessment.id);
  const response = selectFiles.all(assessment.id, 'response');
  if (!paper.length && !library.length) return 'Choose the administered question paper from the library, or upload it, first.';
  if (!response.length) return 'Upload the teacher’s answer paper first.';
  if ([...paper, ...response].some((file) => !OPENAI_IMAGE_TYPES.has(file.mime_type))) return 'Re-upload scanned pages as JPG, PNG, WEBP or GIF.';
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(assessment.teacher_id);
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(assessment.school_id);
  for (const p of library) {
    const sections = assessment.section ? [assessment.section] : String(p.sections).split(',').filter(Boolean);
    for (const section of sections) {
      const problem = paperCompatibilityProblem(p, teacher, school, section);
      if (problem) return problem;
    }
  }
  // An explicit re-evaluation of a completed result starts fresh. Checkpoints
  // resume interrupted/failed work only, never freeze a requested re-mark.
  if (assessment.ai_status === 'done') db.prepare('UPDATE assessments SET evaluation_checkpoint = NULL WHERE id = ?').run(assessment.id);
  db.prepare("UPDATE assessments SET ai_status = 'running', ai_error = NULL, updated_at = datetime('now') WHERE id = ?").run(assessment.id);
  keepAwake(markWithSecondTry(assessment, { paper, library, response }, digest(currentSourceBasis(assessment.id))));
  return null;
}

const SECOND_TRY_AFTER_MS = Number(process.env.SECOND_TRY_AFTER_MS ?? 60_000);
async function markWithSecondTry(assessment, files, originalSourceDigest) {
  for (let attempt = 1; ; attempt += 1) {
    try { await evaluate(assessment, files, attempt, originalSourceDigest); return; }
    catch (error) {
      if (error.passing && attempt === 1) {
        db.prepare('UPDATE assessments SET evaluation_progress = ? WHERE id = ?').run(JSON.stringify({ stage: 'retry_wait', attempt, error: error.userMessage ?? error.message }), assessment.id);
        await new Promise((resolve) => setTimeout(resolve, SECOND_TRY_AFTER_MS * (1 + Math.random())));
        continue;
      }
      console.error(`Evaluating assessment ${assessment.id} failed:`, error);
      markFailed.run(error.userMessage ?? `Marking failed: ${error.message}`, assessment.id);
      return;
    }
  }
}

export const evaluationConfig = () => ({
  pipeline: PIPELINE_VERSION, rubric: RUBRIC_POLICY, model: OPENAI_MODEL, reading_model: GEMINI_MODEL,
  reading_version: READING_VERSION, writing_version: WRITING_VERSION,
  prompts: digest([PAPER_INSTRUCTIONS, RESPONSE_INSTRUCTIONS, MARK_INSTRUCTIONS, PAPER_SCHEMA, RESPONSE_SCHEMA, MARK_SCHEMA]),
});

async function evaluate(assessment, files, attempt, originalSourceDigest) {
  const source = currentSourceBasis(assessment.id);
  if (digest(source) !== originalSourceDigest) throw friendly('The assessment sources or teacher details changed while evaluation was pending. Evaluate again using the current inputs.');
  if ([...source.files, ...source.papers].some((f) => f.sha256 === 'missing')) throw friendly('A source file is missing. Restore it before evaluating.');
  const config = evaluationConfig();
  const basis = digest({ source, config });
  const prior = parse(selectAssessment.get(assessment.id)?.evaluation_checkpoint);
  const checkpoint = prior?.basis === basis ? prior : { basis, stages: {} };
  const assertUnchanged = () => {
    if (digest(currentSourceBasis(assessment.id)) !== digest(source)) throw friendly('The teacher, source pages or question paper changed during evaluation. Evaluate again using the current sources.');
  };
  const stage = async (name, work) => {
    assertUnchanged();
    saveCheckpoint.run(JSON.stringify(checkpoint), JSON.stringify({ stage: name, attempt, resumed: name in checkpoint.stages }), assessment.id);
    if (!(name in checkpoint.stages)) {
      checkpoint.stages[name] = await work();
      assertUnchanged();
      saveCheckpoint.run(JSON.stringify(checkpoint), JSON.stringify({ stage: name, attempt, complete: true }), assessment.id);
    }
    return checkpoint.stages[name];
  };
  const language = await stage('language', () => answerLanguage({ paper: files.library.length ? [] : files.paper, response: files.response }));
  const pagesSwapped = !files.library.length && files.paper.length > 0 && language.pages_swapped === true;
  const paper = pagesSwapped ? files.response : files.paper;
  const response = pagesSwapped ? files.paper : files.response;
  const sources = await stage('source_catalogue', async () => [
    ...await Promise.all(files.library.map(async (p) => {
      const loading = getDocument({ data: new Uint8Array(await fs.readFile(path.join(UPLOADS_DIR, p.stored_name))), isEvalSupported: false });
      try {
        const pdf = await loading.promise;
        return { source_id: `library:${p.id}`, title: p.title, kind: 'pdf', pages: pdf.numPages, sections: p.sections, subject: p.subject, levels: p.levels };
      } finally { await loading.destroy(); }
    })),
    ...paper.map((p, i) => ({ source_id: `scan:${p.id}`, title: `QUESTION PAPER scanned page ${i + 1}`, kind: 'image', pages: 1 })),
  ]);
  const expectedTeacher = db.prepare('SELECT id, name, grade, subjects FROM teachers WHERE id = ?').get(assessment.teacher_id);
  const scope = assessment.section ? `This sitting is Section ${assessment.section} only.` : 'This sitting can contain any of the selected paper sections.';
  const ledger = await stage('paper_rubric', async () => validatePaper(await requestJson({
    instructions: `${PAPER_INSTRUCTIONS}\n${scope}`,
    content: [{ type: 'input_text', text: `EXPECTED TEACHER PROFILE: ${JSON.stringify(expectedTeacher)}\nReject a printed subject/level inconsistent with this profile; report the conflict in issues. SOURCE CATALOGUE (in input order): ${JSON.stringify(sources)}` }, ...(await questionPaperInputs({ paper, library: files.library }))],
    name: 'grounded_question_ledger', schema: PAPER_SCHEMA, task: 'read the question paper and provisional rubric', retry: 'Check the sources and press Evaluate again.',
  }), sources, assessment.section));

  const extraction = await stage('reading', async () => {
    if (language.language === 'english') return { texts: null, pages: [], read_by: 'openai', model: OPENAI_MODEL };
    const detail = await readAnswers(response, language.languages, { includeDetails: true });
    const allFallback = detail.texts.every((text) => !String(text ?? '').trim());
    return { ...detail, read_by: allFallback ? 'openai' : 'gemini', model: allFallback ? OPENAI_MODEL : GEMINI_MODEL, extractor_model: GEMINI_MODEL };
  });
  const teacher = expectedTeacher;
  const matched = await stage('response_matching', async () => validateResponse(await requestJson({
    instructions: `${RESPONSE_INSTRUCTIONS}\n${scope}`,
    content: [
      { type: 'input_text', text: `EXPECTED TEACHER: ${JSON.stringify(teacher)}\nIMMUTABLE QUESTION LEDGER: ${JSON.stringify(ledger)}\nSOURCE IDENTITY REVIEW: ${JSON.stringify(response.map((p, i) => ({ page: i + 1, source_metadata: p.source_metadata })))}. Confirmed identity review can resolve an uncertain spelling or cross-script name, never a definite different person.` },
      ...(extraction.texts ? await readingInputs(extraction.texts, response, extraction.pages) : await pageInputs("TEACHER'S RESPONSE", response)),
    ],
    name: 'grounded_response_extraction', schema: RESPONSE_SCHEMA, task: 'read and match the response evidence', retry: 'Review the source pages and try again.',
  }), ledger, response.length, assessment.section, { teacher, pages: response }));

  const marked = await stage('marking_validation', async () => validateMarks(await requestJson({
    instructions: MARK_INSTRUCTIONS,
    content: [{ type: 'input_text', text: JSON.stringify({ ledger, response: matched }) }],
    name: 'grounded_criterion_marks', schema: MARK_SCHEMA, task: 'mark the grounded responses', retry: 'Press Evaluate again after reviewing the source evidence.',
  }), ledger, matched));
  let writing;
  try {
    writing = await stage('writing', () => checkWriting(marked.questions, extraction.texts
      ? { reading: extraction.texts, readingDetails: extraction.pages, pages: response } : { pages: response }));
  } catch (error) {
    writing = { problem: error.userMessage ?? `The writing could not be checked: ${error.message}` };
  }
  assertUnchanged();
  const result = normalise({ ...marked, marking: 'standard', reading: { ...language, ...extraction }, writing, pages_swapped: pagesSwapped,
    audit: { ...marked.audit, source, source_digest: digest(source), config, basis } });
  saveMarking(assessment.id, result);
  db.prepare('UPDATE assessments SET evaluation_progress = ? WHERE id = ?').run(JSON.stringify({ stage: 'complete', attempt, basis }), assessment.id);
  const saved = selectAssessment.get(assessment.id);
  if (saved.test_id) queueTeacherReports(saved.teacher_id, saved.test_id);
}

// Kept for callers and regression coverage; a mismatch is never relabelled.
export function scopeToSection(questions, section) {
  if (!section) return questions;
  const inSection = questions.filter((q) => sectionKey(q.section) === section);
  if (!inSection.length) throw friendly(`No questions identify Section ${section}; check the selected paper.`);
  return inSection;
}
const saveMarking = db.transaction((assessmentId, result) => {
  if (result.pages_swapped) {
    swapScanKinds(assessmentId);
    // The persisted provenance follows the verified physical swap.
    result.audit.initial_basis = result.audit.basis;
    result.audit.source = currentSourceBasis(assessmentId);
    result.audit.source_digest = digest(result.audit.source);
    result.audit.basis = digest({ source: result.audit.source, config: result.audit.config });
  }
  saveResult.run({ id: assessmentId, result: JSON.stringify(result), model: OPENAI_MODEL, score: result.total_score, max_score: result.max_score });
});

export function normalise(raw) {
  const marking = markingOf(raw.marking);
  const questions = (raw.questions ?? []).map((q) => {
    const max = Math.max(0, Number(q.max_marks) || 0);
    const awarded = Math.min(max, Math.max(0, Number(q.marks_awarded) || 0));
    return {
      ...q,
      section: String(q.section ?? '').trim(),
      question: String(q.question ?? '').trim(),
      question_text: String(q.question_text ?? '').trim(),
      teacher_answer: String(q.teacher_answer ?? '').trim(),
      expected_answer: String(q.expected_answer ?? '').trim(),
      max_marks: max,
      marks_awarded: awarded,
      feedback: String(q.feedback ?? '').trim(),
    };
  });
  const counted = questions.filter((q) => counts(q, marking));
  const sum = (key) => Math.round(counted.reduce((total, q) => total + q[key], 0) * 100) / 100;
  return {
    marking,
    submission: raw.submission ?? null,
    audit: raw.audit ?? null,
    reading: readingOf(raw.reading),
    writing: writingOf(raw.writing, questions),
    pages_swapped: raw.pages_swapped === true,
    questions,
    total_score: sum('marks_awarded'),
    max_score: sum('max_marks'),
    summary: String(raw.summary ?? '').trim(),
    strengths: (raw.strengths ?? []).map(String),
    areas_to_improve: (raw.areas_to_improve ?? []).map(String),
  };
}

// How the answers were read: the language they are in, whether OpenAI read
// them from the scans or Gemini read them first, and the pages Gemini would
// not read, which OpenAI read from the scans. Sittings marked before the
// language check have none.
function readingOf(reading) {
  if (!reading || typeof reading !== 'object') return null;
  const unread = (Array.isArray(reading.unread_pages) ? reading.unread_pages : []).map(Number).filter(Number.isInteger);
  return {
    pages: Array.isArray(reading.pages) ? reading.pages : [],
    language: String(reading.language ?? ''),
    languages: (reading.languages ?? []).map(String),
    read_by: reading.read_by === 'gemini' ? 'gemini' : 'openai',
    model: String(reading.model ?? ''),
    extractor_model: String(reading.extractor_model ?? ''),
    ...(unread.length ? { unread_pages: unread } : {}),
  };
}
