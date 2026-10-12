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
import { nameRelationship } from './identity.js';
import { PIPELINE_VERSION, RUBRIC_POLICY, PAPER_SCHEMA, RESPONSE_SCHEMA, MARK_SCHEMA,
  PAPER_INSTRUCTIONS, RESPONSE_INSTRUCTIONS, MARK_INSTRUCTIONS,
  validatePaper, qualifyPaper, validateResponse, validateMarks, qualifyMarks, unavailableMarks, responseNeedsResolution } from './grounding.js';

const selectAssessment = db.prepare('SELECT * FROM assessments WHERE id = ?');
const selectFiles = db.prepare('SELECT * FROM assessment_files WHERE assessment_id = ? AND kind = ? ORDER BY position, id');
const markFailed = db.prepare("UPDATE assessments SET ai_status = 'failed', ai_error = ?, updated_at = datetime('now') WHERE id = ?");
const saveResult = db.prepare(`UPDATE assessments SET ai_status = 'done', ai_error = NULL,
  ai_result = @result, ai_model = @model, ai_evaluated_at = datetime('now'),
  score = @score, max_score = @max_score, status = @status, updated_at = datetime('now') WHERE id = @id`);
const saveCheckpoint = db.prepare('UPDATE assessments SET evaluation_checkpoint = ?, evaluation_progress = ? WHERE id = ?');
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function startEvaluation(assessmentId, marking = 'standard') {
  const assessment = selectAssessment.get(assessmentId);
  if (!assessment) return 'Assessment not found.';
  if (assessment.status === 'assembling') return 'This submission batch is still being assembled.';
  if (!openaiConfigured()) { finalizeUnavailable(assessmentId, 'service_unavailable', 'Assessment provider is not configured.'); return null; }
  if (assessment.ai_status === 'running') return null;
  if (marking !== 'standard') return 'Use Standard marking: unanswered questions in a supplied complete section score zero. Entire sections not supplied are excluded.';
  const paper = selectFiles.all(assessment.id, 'question_paper');
  const library = sittingPapers(assessment.id);
  const response = selectFiles.all(assessment.id, 'response');
  if (!paper.length && !library.length) { finalizeUnavailable(assessmentId, 'paper_unavailable', 'No administered question paper was supplied.'); return null; }
  if (!response.length) { finalizeUnavailable(assessmentId, 'no_response', 'No response source was supplied.'); return null; }
  const source = currentSourceBasis(assessment.id);
  const unavailableFiles = new Set(source.files.filter((file) => file.sha256 === 'missing').map((file) => file.id));
  const unavailablePapers = new Set(source.papers.filter((file) => file.sha256 === 'missing').map((file) => file.id));
  if ([...paper, ...response].some((file) => !unavailableFiles.has(file.id) && !OPENAI_IMAGE_TYPES.has(file.mime_type))) return 'Re-upload scanned pages as JPG, PNG, WEBP or GIF.';
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(assessment.teacher_id);
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(assessment.school_id);
  for (const p of library.filter((file) => !unavailablePapers.has(file.id))) {
    const sections = assessment.section ? [assessment.section] : String(p.sections).split(',').filter(Boolean);
    for (const section of sections) {
      const problem = paperCompatibilityProblem(p, teacher, school, section);
      if (problem) { finalizeUnavailable(assessmentId, 'paper_mismatch', problem); return null; }
    }
  }
  // An explicit re-evaluation of a completed result starts fresh. Checkpoints
  // resume interrupted/failed work only, never freeze a requested re-mark.
  if (assessment.ai_status === 'done') db.prepare('UPDATE assessments SET evaluation_checkpoint = NULL WHERE id = ?').run(assessment.id);
  db.prepare("UPDATE assessments SET ai_status = 'running', ai_error = NULL, updated_at = datetime('now') WHERE id = ?").run(assessment.id);
  keepAwake(markWithSecondTry(assessment, { paper, library, response }, digest(source)));
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
      if (digest(currentSourceBasis(assessment.id)) !== originalSourceDigest) {
        markFailed.run(error.userMessage ?? error.message, assessment.id);
        return;
      }
      finalizeUnavailable(assessment.id, error.code === 'GROUNDING_REVIEW_REQUIRED' ? 'evidence_unavailable' : 'service_unavailable', error.userMessage ?? error.message);
      return;
    }
  }
}

export const evaluationConfig = () => ({
  pipeline: PIPELINE_VERSION, rubric: RUBRIC_POLICY, model: OPENAI_MODEL, reading_model: GEMINI_MODEL, source_availability: 'bounded-sources-v1',
  reading_version: READING_VERSION, writing_version: WRITING_VERSION,
  prompts: digest([PAPER_INSTRUCTIONS, RESPONSE_INSTRUCTIONS, MARK_INSTRUCTIONS, PAPER_SCHEMA, RESPONSE_SCHEMA, MARK_SCHEMA]),
});

async function evaluate(assessment, files, attempt, originalSourceDigest) {
  const source = currentSourceBasis(assessment.id);
  if (digest(source) !== originalSourceDigest) throw friendly('The assessment sources or teacher details changed while evaluation was pending. Evaluate again using the current inputs.');
  // Keep the complete basis, including missing files, for every checkpoint and
  // freshness check. Only provider inputs are narrowed to readable sources.
  const originals = files;
  const unavailableFiles = new Set(source.files.filter((file) => file.sha256 === 'missing').map((file) => file.id));
  const unavailablePapers = new Set(source.papers.filter((file) => file.sha256 === 'missing').map((file) => file.id));
  files = { paper: files.paper.filter((file) => !unavailableFiles.has(file.id)),
    response: files.response.filter((file) => !unavailableFiles.has(file.id)),
    library: files.library.filter((file) => !unavailablePapers.has(file.id)) };
  if ((!files.paper.length && !files.library.length) || !files.response.length) {
    finalizeUnavailable(assessment.id, !files.response.length ? 'response_unavailable' : 'paper_unavailable', 'No usable source remains for the required assessment evidence.');
    return;
  }
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
  const request = (args) => requestJson({ maxRetries: 1, timeoutMs: 120_000, ...args });
  const language = await stage('language', async () => {
    try { return await answerLanguage({ paper: files.library.length ? [] : files.paper, response: files.response }, { maxRetries: 1, timeoutMs: 120_000 }); }
    catch (error) { return { language: 'mixed', languages: [], pages_swapped: false, diagnostic: error.message }; }
  });
  const pagesSwapped = !originals.library.length && files.paper.length > 0 && language.pages_swapped === true;
  const paper = pagesSwapped ? files.response : files.paper;
  const response = pagesSwapped ? files.paper : files.response;
  const originalResponse = pagesSwapped ? originals.paper : originals.response;
  const originalPaper = pagesSwapped ? originals.response : originals.paper;
  const availability = sourceAvailability(source, originalResponse);
  const missingResponses = originalResponse.filter((file) => unavailableFiles.has(file.id));
  const missingPaperScans = originalPaper.filter((file) => unavailableFiles.has(file.id));
  const sources = await stage('source_catalogue', async () => [
    ...await Promise.all(files.library.map(async (p) => {
      const loading = getDocument({ data: new Uint8Array(await fs.readFile(path.join(UPLOADS_DIR, p.stored_name))), isEvalSupported: false });
      try {
        const pdf = await loading.promise;
        return { source_id: `library:${p.id}`, title: p.title, kind: 'pdf', pages: pdf.numPages, sections: p.sections, subject: p.subject, levels: p.levels };
      } finally { await loading.destroy(); }
    })),
    ...paper.map((p) => ({ source_id: `scan:${p.id}`, title: `QUESTION PAPER scanned page ${originalPaper.findIndex((file) => file.id === p.id) + 1}`, kind: 'image', pages: 1 })),
  ]);
  const expectedTeacher = db.prepare('SELECT id, name, grade, subjects FROM teachers WHERE id = ?').get(assessment.teacher_id);
  const scope = assessment.section ? `This sitting is Section ${assessment.section} only.` : 'This sitting can contain any of the selected paper sections.';
  const ledger = await stage('paper_rubric', async () => {
    let raw, issue = '';
    for (let pass = 0; pass < 2; pass++) {
      raw = await request({
        instructions: `${PAPER_INSTRUCTIONS}\n${scope}`,
        content: [{ type: 'input_text', text: `EXPECTED TEACHER PROFILE: ${JSON.stringify(expectedTeacher)}\nReject incompatible printed subject/level in top-level issues. SOURCE CATALOGUE: ${JSON.stringify(sources)}. ${issue ? `Focused repair: ${issue}. Inspect the actual source again; never rescale marks to fit.` : ''}` }, ...(await questionPaperInputs({ paper, library: files.library }))],
        name: 'grounded_question_ledger', schema: PAPER_SCHEMA, task: 'read the administered questions', retry: 'The attempt will finish with available evidence.',
      });
      try { return validatePaper(raw, sources, assessment.section); }
      catch (error) { issue = error.message; }
    }
    return qualifyPaper(raw, sources, assessment.section);
  });

  const extraction = await stage('reading', async () => {
    if (language.language === 'english') return { texts: null, pages: [], read_by: 'openai', model: OPENAI_MODEL };
    let detail;
    try { detail = await readAnswers(response, language.languages, { includeDetails: true }); }
    catch (error) { return { texts: null, pages: [], read_by: 'openai', model: OPENAI_MODEL, diagnostic: error.message }; }
    const allFallback = detail.texts.every((text) => !String(text ?? '').trim());
    return { ...detail, read_by: allFallback ? 'openai' : 'gemini', model: allFallback ? OPENAI_MODEL : GEMINI_MODEL, extractor_model: GEMINI_MODEL };
  });
  const teacher = expectedTeacher;
  const compactMatched = await stage('response_matching', async () => {
    const attempts = [];
    const identityConflicts = new Map();
    let qualified, issue = '', lastPaperMatch;
    for (let pass = 0; pass < 2; pass++) {
      let raw;
      try { raw = await request({
        instructions: `${RESPONSE_INSTRUCTIONS}\n${scope}\n${pass ? 'FOCUSED FINAL READING: inspect the original images again. Resolve uncertainty using actual identity fields, question labels and specific response content. Use all readable partial content. Do not force a match or change the master. Leave genuinely unsupported rows unassessable.' : ''}`,
        content: [
          { type: 'input_text', text: `EXPECTED TEACHER: ${JSON.stringify(teacher)}\nIMMUTABLE QUESTION LEDGER: ${JSON.stringify(ledger)}\nSOURCE IDENTITY REVIEW: ${JSON.stringify(response.map((p, i) => ({ page: i + 1, source_metadata: p.source_metadata })))}. ${issue ? `Earlier validation: ${issue}` : ''}` },
          ...(pass || !extraction.texts ? await pageInputs("TEACHER'S RESPONSE", response) : await readingInputs(extraction.texts, response, extraction.pages)),
        ],
        name: 'grounded_response_extraction', schema: RESPONSE_SCHEMA, task: 'read and align the responses', retry: 'The attempt will finish with available evidence.',
      }); } catch (error) { if (qualified) return { ...qualified, resolution_attempts: attempts, diagnostic: error.message }; throw error; }
      attempts.push(raw);
      lastPaperMatch = raw.paper_match;
      for (const page of raw.page_identity ?? []) {
        if (Number.isInteger(page.page) && page.page >= 1 && page.page <= response.length && (page.status === 'conflict' || page.name && nameRelationship(teacher.name, page.name) === 'conflict')) identityConflicts.set(page.page, { ...page, status: 'conflict' });
      }
      const consistentRaw = { ...raw, page_identity: raw.page_identity?.map((p) => identityConflicts.get(p.page) ?? p) };
      try {
        const candidate = validateResponse(consistentRaw, ledger, response.length, assessment.section, { teacher, pages: response, finalize: true });
        qualified = qualified ? mergeResponseEvidence(qualified, candidate, ledger) : candidate;
        if (!responseNeedsResolution(raw) && !qualified.excluded_response_pages.length && !qualified.unassigned_response_pages.length) break;
      } catch (error) { issue = error.message; if (pass && !qualified) throw error; }
    }
    qualified = retainDefiniteExclusions(qualified, [...identityConflicts.values()], lastPaperMatch === 'mismatch', ledger);
    return { ...qualified, resolution_attempts: attempts };
  });

  const matched = boundMissingResponses(compactMatched, ledger, missingResponses, assessment.section);
  const marked = await stage('marking_validation', async () => {
    if (!matched.answers.some((a) => ['answered', 'partial'].includes(a.status))) return unavailableMarks(ledger, matched);
    let raw, issue = '';
    for (let pass = 0; pass < 2; pass++) {
      try {
        raw = await request({
          instructions: `${MARK_INSTRUCTIONS}${issue ? `\nRepair only the invalid scoring: ${issue}. Keep the original maxima and extracted answers unchanged.` : ''}`,
          content: [{ type: 'input_text', text: JSON.stringify({ ledger, response: matched }) }],
          name: 'grounded_criterion_marks', schema: MARK_SCHEMA, task: 'mark supported responses', retry: 'The attempt will finish with available evidence.',
        });
      } catch (error) { return { ...(raw ? qualifyMarks(raw, ledger, matched) : unavailableMarks(ledger, matched)), diagnostic: error.message }; }
      try { return validateMarks(raw, ledger, matched); }
      catch (error) { issue = error.message; }
    }
    return qualifyMarks(raw, ledger, matched);
  });
  let writing;
  try {
    const eligibleQuestions = marked.questions.filter((q) => q.assessment_state === 'assessed' && ['answered', 'partial'].includes(q.response_status));
    const writtenPages = new Set(eligibleQuestions.flatMap((q) => q.source_pages));
    const safePages = response.filter((_, i) => writtenPages.has(i + 1) && !matched.excluded_response_pages.includes(i + 1));
    writing = eligibleQuestions.length ? await stage('writing', () => checkWriting(marked.questions, { pages: safePages })) : { sections: [], errors: [] };
  } catch (error) {
    writing = { problem: error.userMessage ?? `The writing could not be checked: ${error.message}` };
  }
  assertUnchanged();
  const retained = restoreResponsePageNumbers(marked, availability.response_page_map);
  retained.submission = boundMissingPapers(retained.submission, source.papers.filter((file) => unavailablePapers.has(file.id)), missingPaperScans, assessment.section);
  const originalPage = (page) => availability.response_page_map.find((entry) => entry.provider_page === page)?.original_page ?? page;
  const result = normalise({ ...retained, marking: 'standard', completion: { section: assessment.section || '' }, reading: { ...language, ...extraction,
    pages: extraction.pages.map((page) => ({ ...page, page: originalPage(page.page) })),
    unread_pages: extraction.unread_pages?.map(originalPage) }, writing, pages_swapped: pagesSwapped,
    audit: { ...retained.audit, availability, source, source_digest: digest(source), config, basis, resolution_attempts: matched.resolution_attempts, diagnostics: [language.diagnostic, extraction.diagnostic, matched.diagnostic, marked.diagnostic].filter(Boolean) } });
  saveMarking(assessment.id, result);
  db.prepare('UPDATE assessments SET evaluation_progress = ? WHERE id = ?').run(JSON.stringify({ stage: 'complete', attempt, basis }), assessment.id);
  const saved = selectAssessment.get(assessment.id);
  if (saved.test_id) queueTeacherReports(saved.teacher_id, saved.test_id);
}

// Keep independently validated readable content when a focused reread is less
// useful, but a definite identity conflict always wins over apparent fluency.
export function mergeResponseEvidence(prior, current, ledger) {
  if (current.paper_match === 'mismatch') return current;
  // Definite conflicts were already locked into current by the caller. A
  // resolved uncertain identity must not remain excluded forever.
  const excluded = new Set(current.excluded_response_pages ?? []);
  const sections = current.sections.map((s) => {
    const before = prior.sections.find((p) => p.section === s.section);
    const pages = [...new Set([...(before?.source_pages ?? []), ...s.source_pages])].sort((a, b) => a - b);
    return { ...s, source_pages: pages, status: pages.some((p) => excluded.has(p)) || pages.length && s.status === 'not_supplied' ? 'incomplete' : s.status };
  });
  const rank = (a) => a.status === 'answered' ? 3 : a.status === 'partial' ? 2 : a.status === 'unanswered' ? 1 : 0;
  const answers = current.answers.map((answer) => {
    const before = prior.answers.find((a) => a.row === answer.row);
    const q = ledger.find((item) => item.row === answer.row);
    const coverage = sections.find((s) => s.section === q.section);
    const chosen = before && rank(before) > rank(answer) ? before : answer;
    if (chosen.source_pages.some((p) => excluded.has(p))) return { ...chosen, status: 'identity_unresolved', assessment_state: 'unassessable', teacher_answer: '' };
    if (chosen.status === 'unanswered' && coverage.status !== 'supplied_complete') return { ...chosen, status: 'missing_page', assessment_state: 'unassessable' };
    if (chosen === before && (answer.status === 'unreadable' || answer.qualification === 'limited_readability')) return { ...chosen, qualification: 'limited_readability' };
    return chosen;
  });
  return { ...current, answers, sections, excluded_response_pages: [...excluded] };
}

// Even malformed focused output can reveal a definite conflict on an actual
// source page. Such a conflict must also constrain the retained first pass.
export function retainDefiniteExclusions(response, conflicts, paperMismatch = false, ledger = []) {
  const excluded = new Set([...(response.excluded_response_pages ?? []), ...conflicts.map((p) => p.page)]);
  return { ...response, paper_match: paperMismatch ? 'mismatch' : response.paper_match,
    excluded_response_pages: [...excluded],
    page_identity: response.page_identity.map((p) => conflicts.find((c) => c.page === p.page) ?? p),
    sections: response.sections.map((s) => ({ ...s, status: s.source_pages.some((p) => excluded.has(p)) ? 'incomplete' : s.status })),
    answers: response.answers.map((a) => a.source_pages.some((p) => excluded.has(p))
      ? { ...a, teacher_answer: '', status: 'identity_unresolved', assessment_state: 'unassessable' }
      : paperMismatch && a.status !== 'section_not_supplied' ? { ...a, status: 'unmatched', assessment_state: 'unassessable' }
        : a.status === 'unanswered' && response.sections.find((s) => s.section === ledger.find((q) => q.row === a.row)?.section && s.source_pages.some((p) => excluded.has(p)))
          ? { ...a, status: 'missing_page', assessment_state: 'unassessable' } : a),
  };
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
  saveResult.run({ id: assessmentId, result: JSON.stringify(result), model: OPENAI_MODEL, score: result.total_score, max_score: result.max_score, status: result.outcome === 'no_assessment' ? 'finalized' : 'evaluated' });
});

export function normalise(raw) {
  const marking = markingOf(raw.marking);
  const questions = (raw.questions ?? []).map((q) => {
    const max = q.assessment_state && q.max_marks === null ? null : Math.max(0, Number(q.max_marks) || 0);
    const awarded = q.assessment_state && (q.marks_awarded === null || q.assessment_state !== 'assessed') ? null : Math.min(max, Math.max(0, Number(q.marks_awarded) || 0));
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
  const bounded = Boolean(raw.outcome || raw.completion || questions.some((q) => q.assessment_state));
  const noAssessment = raw.outcome === 'no_assessment' || (questions.length > 0 && !counted.length);
  const limited = questions.some((q) => q.assessment_state === 'unassessable' || q.qualification) || raw.submission?.sections?.some((s) => s.status === 'incomplete');
  return {
    marking,
    ...(bounded ? { outcome: noAssessment ? 'no_assessment' : limited ? 'qualified' : 'assessed',
      completion: { ...raw.completion, state: noAssessment ? 'no_assessment' : limited ? 'qualified' : 'assessed' } } : {}),
    submission: raw.submission ?? null,
    audit: raw.audit ?? null,
    reading: readingOf(raw.reading),
    writing: writingOf(raw.writing, questions),
    pages_swapped: raw.pages_swapped === true,
    questions,
    total_score: noAssessment ? null : sum('marks_awarded'),
    max_score: noAssessment ? null : sum('max_marks'),
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

// Missing files are audited by stable IDs, separately for scans and library
// papers. Provider page numbers are compact, while saved evidence always uses
// the original response ordering expected by report appendices.
function sourceAvailability(source, response = source.files.filter((file) => file.kind === 'response')) {
  const unavailable = new Set(source.files.filter((file) => file.sha256 === 'missing').map((file) => file.id));
  let providerPage = 0;
  return {
    unavailable_file_ids: [...unavailable],
    unavailable_paper_ids: source.papers.filter((file) => file.sha256 === 'missing').map((file) => file.id),
    response_page_map: response.flatMap((file, index) => unavailable.has(file.id) ? [] : [{ provider_page: ++providerPage, original_page: index + 1, file_id: file.id }]),
  };
}

function missingResponseSections(files, ledger, sittingSection) {
  const sections = new Set();
  for (const file of files) {
    const key = sectionKey(parse(file.source_metadata)?.filed_section || sittingSection);
    if (['A', 'B', 'C'].includes(key)) sections.add(key);
    else for (const question of ledger) sections.add(question.section);
  }
  return sections;
}

function boundMissingResponses(response, ledger, files, sittingSection) {
  if (!files.length) return response;
  const affected = missingResponseSections(files, ledger, sittingSection);
  const sections = response.sections.map((section) => affected.has(section.section)
    ? { ...section, status: 'incomplete' } : section);
  for (const key of affected) if (!sections.some((section) => section.section === key)) sections.push({ section: key, status: 'incomplete', source_pages: [], reason: '' });
  // Known missing pages can contain an apparent omission. Readable supported
  // answers survive, but neither absence nor a complete blank can be inferred.
  const answers = response.answers.map((answer) => affected.has(ledger.find((q) => q.row === answer.row)?.section) && ['unanswered', 'section_not_supplied'].includes(answer.status)
    ? { ...answer, status: 'missing_page', assessment_state: 'unassessable' } : answer);
  return { ...response, sections, answers };
}

function boundMissingPapers(submission, missingPapers, missingScans, sittingSection) {
  if (!missingPapers.length && !missingScans.length) return submission;
  const sections = (submission?.sections ?? []).map((section) => ({ ...section }));
  const affected = new Set();
  let unknown = missingScans.length > 0;
  for (const paper of missingPapers) {
    const known = String(paper.sections ?? '').split(',').map(sectionKey).filter((key) => ['A', 'B', 'C'].includes(key) && (!sittingSection || key === sittingSection));
    if (known.length) for (const key of known) affected.add(key);
    else unknown = true;
  }
  // A missing scanned paper has no reliable section identity. Qualify the
  // surviving ledger rather than manufacturing its missing questions/maxima.
  if (unknown) for (const section of sections) if (section.status !== 'not_supplied') affected.add(section.section);
  if (unknown && !affected.size) affected.add(sittingSection || '');
  for (const key of affected) {
    const section = sections.find((item) => item.section === key);
    if (section) {
      if (section.status !== 'not_supplied') section.status = 'incomplete';
    } else sections.push({ section: key, status: 'incomplete', source_pages: [], reason: '' });
  }
  return { ...submission, sections };
}

function restoreResponsePageNumbers(marked, pageMap) {
  const original = (page) => pageMap.find((entry) => entry.provider_page === page)?.original_page ?? page;
  const remap = (pages) => (pages ?? []).map(original);
  return { ...marked,
    questions: marked.questions.map((question) => ({ ...question, source_pages: remap(question.source_pages) })),
    submission: { ...marked.submission, sections: marked.submission.sections.map((section) => ({ ...section, source_pages: remap(section.source_pages) })) },
    audit: { ...marked.audit,
      page_identity: marked.audit.page_identity?.map((identity) => ({ ...identity, page: original(identity.page) })),
      excluded_response_pages: remap(marked.audit.excluded_response_pages),
      unassigned_response_pages: remap(marked.audit.unassigned_response_pages) },
  };
}

// Terminal artifacts may retain already verified originals even when no
// provider is available. A name or ID conflict overrides a manual selection.
function safeTerminalResponse(file, teacher, unavailable) {
  if (unavailable.has(file.id)) return false;
  const metadata = parse(file.source_metadata) ?? {}, identity = metadata.identity ?? {};
  const name = identity.name_written ?? identity.name ?? '';
  const relation = nameRelationship(teacher?.name, name);
  if (relation === 'conflict' || identity.status === 'conflict' ||
    (metadata.teacher_id && metadata.teacher_id !== teacher?.id) || (identity.teacher_id && identity.teacher_id !== teacher?.id)) return false;
  return (metadata.identity_confirmed === true && metadata.teacher_id === teacher?.id) ||
    (identity.name_confidence === 'certain' && identity.teacher_id === teacher?.id && ['same', 'compatible'].includes(relation));
}

// A downloadable terminal outcome is not a completed assessment. Technical
// diagnostics and any prior result remain internal to the audit.
export function finalizeUnavailable(assessmentId, reasonCode = 'assessment_unavailable', diagnostic = '', { queueReports = true } = {}) {
  const assessment = selectAssessment.get(assessmentId);
  if (!assessment) return false;
  const source = currentSourceBasis(assessmentId), config = evaluationConfig();
  const previous = parse(assessment.ai_result);
  const response = selectFiles.all(assessmentId, 'response');
  const availability = sourceAvailability(source, response);
  const unavailable = new Set(availability.unavailable_file_ids);
  const result = normalise({ questions: [], outcome: 'no_assessment',
    completion: { state: 'no_assessment', reason_code: reasonCode, section: assessment.section || '' },
    audit: { source, source_digest: digest(source), config, basis: digest({ source, config }), availability,
      diagnostics: diagnostic ? [diagnostic] : [], previous_result: previous?.questions?.length ? previous : null,
      excluded_response_pages: response.flatMap((file, i) => safeTerminalResponse(file, source.teacher, unavailable) ? [] : [i + 1]) } });
  saveMarking(assessmentId, result);
  saveCheckpoint.run(null, JSON.stringify({ stage: 'terminal', outcome: 'no_assessment', reason_code: reasonCode }), assessmentId);
  if (queueReports && assessment.test_id) queueTeacherReports(assessment.teacher_id, assessment.test_id);
  return true;
}
