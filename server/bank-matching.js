// Compare every compatible bank paper in full. A winner inside one batch is
// provisional until all batches have been inspected and all contenders have
// been compared together. This module only reads sources; it never files them.
import fs from 'node:fs/promises';
import path from 'node:path';

export const BANK_COMPARISON_BATCH_SIZE = 8;
export const BANK_COMPARISON_FINALIST_LIMIT = 16;

// Profile metadata orders discovery; it cannot prove which paper was sat.
// A successful but unresolved profile-bank pass gets one wider full-bank pass
// using the SAME request policy. Acceptance/confirmation remains the caller's.
export async function compareWithProfileFallback({ candidates, fallbackCandidates, needsFallback, ...options }) {
  const first = candidates.length ? await compareQuestionBank({ ...options, candidates }) : null;
  const unresolved = !first || (needsFallback ? needsFallback(first) : first.pages.some(page => page.has_answers && (!page.paper_id ||
    !first.papers.some(paper => paper.paper_id === page.paper_id && paper.section === page.section &&
      paper.confidence === 'high' && paper.reason.trim() && !paper.alternatives.length))));
  const ids = new Set(candidates.map(paper => Number(paper.id)));
  if (!unresolved || !fallbackCandidates?.some(paper => !ids.has(Number(paper.id)))) return first;
  if (typeof options.requestPolicy?.beginAttempt !== 'function') throw new Error('Cross-profile discovery requires the shared packet request budget.');
  const wider = await compareQuestionBank({ ...options, candidates: fallbackCandidates,
    instructions: `${options.instructions ?? ''}\nPROFILE FALLBACK: The initial profile-compatible bank left responses unresolved. Teaching class/subject are discovery hints, not proof of the administered paper. Compare actual response content with every supplied full master. A cross-profile match will require separate operator review. Do not infer missing answers; partial response coverage is valid. Preserve explicit source-paper identifiers and genuine contradictions.` });
  const pages = wider.pages.map(page => {
    const prior = first?.pages.find(old => old.page === page.page);
    const priorClear = prior?.paper_id && first.papers.some(paper => paper.paper_id === prior.paper_id &&
      paper.section === prior.section && paper.confidence === 'high' && !paper.alternatives.length);
    if (prior?.header_evidence?.status === 'conflict' || (prior?.has_answers && !page.has_answers) ||
        (priorClear && page.paper_id && (page.paper_id !== prior.paper_id || page.section !== prior.section))) {
      return { ...page, section: 'none', paper_id: 0, questions: [], has_answers: true,
        header_evidence: { status: 'unresolved', reason: 'Profile and wider-bank readings disagree about existing answer content or a previously clear master. Review the original sources.' } };
    }
    return page;
  });
  return { ...wider, pages, bank_comparison: { ...wider.bank_comparison, profile_fallback: true, initial_candidate_count: candidates.length } };
}

const sections = new Set(['A', 'B', 'C']);
const confidenceLevels = new Set(['high', 'medium', 'low']);
const headerStatuses = new Set(['not_present', 'descriptive', 'compatible', 'conflict', 'unresolved']);
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function comparisonError(message, code, details = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.userMessage = message;
  error.code = code;
  Object.assign(error, details);
  return error;
}

function metadata(paper) {
  return { type: 'input_text', text: `QUESTION PAPER ${JSON.stringify({
    id: Number(paper.id), title: paper.title ?? '', sections: paper.sections ?? '',
    subject: paper.subject ?? '', levels: paper.levels ?? '', board: paper.board ?? '', language: paper.language ?? '',
  })}. The following PDF is the complete question paper.` };
}

async function storedPaperInputs(paper, uploadsDir) {
  // Load the application's path only when needed, so injected request/input
  // factories can be tested without opening the application database.
  const directory = uploadsDir ?? (await import('./db.js')).UPLOADS_DIR;
  const data = await fs.readFile(path.join(directory, paper.stored_name));
  return [{ type: 'input_file', filename: `paper-${paper.id}.pdf`, file_data: `data:application/pdf;base64,${data.toString('base64')}` }];
}

function validateResult(result, suppliedIds, answerPageCount) {
  const fail = (detail) => { throw comparisonError(`Question-bank comparison returned invalid evidence: ${detail}. No match was accepted.`, 'QUESTION_BANK_INVALID_EVIDENCE'); };
  const reference = (id, zeroAllowed = true) => {
    if (!Number.isSafeInteger(id) || (id === 0 ? !zeroAllowed : !suppliedIds.has(id))) fail(`paper ID ${String(id)} was not supplied in this comparison`);
  };
  if (!result || !Array.isArray(result.pages) || !Array.isArray(result.papers)) fail('pages and papers must be arrays');
  if (!result.pages.length) fail('the response did not account for every answer page');
  if (answerPageCount !== null && result.pages.length !== answerPageCount) fail('the response did not account for every answer page');
  const pageNumbers = new Set();
  for (const page of result.pages) {
    if (!page || !Number.isSafeInteger(page.page) || page.page < 1 || pageNumbers.has(page.page) ||
        page.page > (answerPageCount ?? result.pages.length) ||
        (!sections.has(page.section) && page.section !== 'none') || typeof page.has_answers !== 'boolean' || !strings(page.questions)) fail('an answer page is missing or malformed');
    pageNumbers.add(page.page);
    reference(page.paper_id);
    // Legacy injected responses may omit this newer field. The caller checks
    // whether a source heading requires it; any supplied evidence must be valid.
    if (Object.hasOwn(page, 'header_evidence') && (!page.header_evidence ||
        !headerStatuses.has(page.header_evidence.status) || typeof page.header_evidence.reason !== 'string')) fail('source heading evidence is malformed');
  }
  for (const paper of result.papers) {
    if (!paper || !sections.has(paper.section) || !confidenceLevels.has(paper.confidence) ||
        typeof paper.reason !== 'string' || !strings(paper.matched_question_labels) || !Array.isArray(paper.alternatives)) fail('a paper finding is malformed');
    reference(paper.paper_id);
    for (const alternative of paper.alternatives) reference(alternative, false);
  }
  return result;
}

function contenderIds(result) {
  return new Set([
    ...result.pages.map((page) => page.paper_id),
    ...result.papers.flatMap((paper) => [paper.paper_id, ...paper.alternatives]),
  ].filter((id) => id > 0));
}

/**
 * content contains the unchanged teacher context and answer-sheet inputs.
 * paperInputs, when supplied, is async (paper) => input-content-array and must
 * include that paper's full PDF. The default reads the original from UPLOADS_DIR.
 * All remaining options are forwarded to request (normally requestJson).
 */
export async function compareQuestionBank({
  candidates, request, instructions, content, schema, paperInputs, uploadsDir,
  answerPageCount = Array.isArray(content) ? (content.filter((entry) => entry.type === 'input_image').length || null) : null,
  ...requestOptions
}) {
  if (!Array.isArray(candidates) || !candidates.length || typeof request !== 'function' || !Array.isArray(content)) {
    throw new TypeError('Question-bank comparison requires candidates, a request function and answer content.');
  }
  const ids = candidates.map((paper) => Number(paper.id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new TypeError('Question-bank candidates must have unique positive integer IDs.');
  }
  if (answerPageCount !== null && (!Number.isSafeInteger(answerPageCount) || answerPageCount < 1)) {
    throw new TypeError('The answer page count must be a positive integer.');
  }
  const loadPaper = paperInputs ?? ((paper) => storedPaperInputs(paper, uploadsDir));
  const batchCount = Math.ceil(candidates.length / BANK_COMPARISON_BATCH_SIZE);
  const considered = [];
  const findings = [];
  let recoverySplitCount = 0;
  let expectedPageCount = answerPageCount;

  const compare = async (papers, phase, batchIndex, observations = [], recoveryPart = null) => {
    const suppliedIds = new Set(papers.map((paper) => Number(paper.id)));
    const phaseInstructions = phase === 'screening'
      ? `This is screening batch ${batchIndex + 1} of ${batchCount}, not the whole compatible question bank. Inspect EVERY supplied PDF against every answer image. A match within this subset is only provisional, never globally unique. Include every plausible supplied paper ID, even a low-confidence possibility, in papers, page paper_id, or alternatives so it remains available for final disambiguation. Do not prefer or discard a paper because of its position, metadata rank, or priority. If none matches, retain the pages as unresolved with paper_id 0 and has_answers true unless genuinely blank.`
      : `This is the final comparison. Inspect all supplied complete PDFs together against the original answer images, resolving any ambiguity using concrete answer-to-question evidence. Earlier batch findings, if present, are provisional leads, not authoritative matches. Retain all equally plausible supplied paper IDs in alternatives and keep weak or conflicting matches unresolved. Never call a subset's winner globally unique merely because it won that subset.`;
    try {
      const inputs = await Promise.all(papers.map(async (paper) => {
        const supplied = await loadPaper(paper);
        if (!Array.isArray(supplied) || !supplied.some((entry) => entry.type === 'input_file' &&
            typeof entry.file_data === 'string' && entry.file_data.startsWith('data:application/pdf;base64,') &&
            entry.file_data.length > 'data:application/pdf;base64,'.length)) {
          throw new Error(`The full PDF for question paper ${paper.id} was not supplied.`);
        }
        return [metadata(paper), ...supplied];
      }));
      const result = await request({
        ...requestOptions,
        instructions: `${instructions ?? ''}\n\nQUESTION BANK COMPARISON: ${phaseInstructions}${recoveryPart === null ? '' : `\nThis is timeout-recovery subset ${recoveryPart} of 2 for that screening batch. The other subset must also be inspected before the bank comparison can finish.`}\nOnly return paper IDs supplied in this call, or paper_id 0 for unresolved evidence. Other IDs mentioned in source titles, confirmations or earlier observations are context only when their PDFs are absent. Do not mistake an absent confirmed master in a screening subset for evidence supporting a different master.`,
        content: [
          { type: 'input_text', text: `SUPPLIED QUESTION PAPER IDS: ${JSON.stringify([...suppliedIds])}. Compatible bank size: ${candidates.length}. Comparison phase: ${phase}.` },
          ...inputs.flat(),
          ...(observations.length ? [{ type: 'input_text', text: `PROVISIONAL BATCH FINDINGS (verify against full PDFs and answer images): ${JSON.stringify(observations)}` }] : []),
          ...content,
        ],
        schema,
      });
      validateResult(result, suppliedIds, expectedPageCount);
      // With text-only caller content, the first map establishes the page set.
      // Later batches cannot make unmatched pages disappear. Callers that know
      // the source count should always pass answerPageCount explicitly.
      expectedPageCount ??= result.pages.length;
      return result;
    } catch (cause) {
      throw comparisonError(`Question-bank ${phase === 'screening' ? `batch ${batchIndex + 1} of ${batchCount}${recoveryPart === null ? '' : ` (recovery subset ${recoveryPart} of 2)`}` : 'final comparison'} failed. The full bank comparison is incomplete; no match was accepted. ${cause.userMessage ?? cause.message}`, 'QUESTION_BANK_COMPARISON_FAILED', {
        considered_candidate_ids: [...considered], failed_candidate_ids: [...suppliedIds],
      }, cause);
    }
  };

  const finish = (result, finalists, finalCompared) => ({
    ...result,
    considered_candidate_ids: [...ids],
    bank_comparison: { complete: true, candidate_count: ids.length, batch_count: batchCount, screening_leaf_count: findings.length,
      recovery_split_count: recoverySplitCount, finalist_ids: finalists, final_compared: finalCompared },
  });

  if (batchCount === 1) {
    const result = await compare(candidates, 'final', 0);
    return finish(result, ids, true);
  }

  const contenders = new Set();
  const retain = (batch, result) => {
    considered.push(...batch.map((paper) => Number(paper.id)));
    findings.push(result);
    for (const id of contenderIds(result)) contenders.add(id);
  };
  for (let index = 0; index < batchCount; index += 1) {
    const batch = candidates.slice(index * BANK_COMPARISON_BATCH_SIZE, (index + 1) * BANK_COMPARISON_BATCH_SIZE);
    try {
      retain(batch, await compare(batch, 'screening', index));
    } catch (error) {
      // One bisection, only after a typed transport timeout and only with a
      // shared packet budget. Keep every answer image and every full master.
      // A child failure aborts: there is no recursion or partial-bank winner.
      if (typeof requestOptions.requestPolicy?.beginAttempt !== 'function' || batch.length < 2 ||
          error.cause?.code !== 'OPENAI_REQUEST_TIMEOUT') throw error;
      recoverySplitCount += 1;
      const middle = Math.ceil(batch.length / 2);
      for (const [part, subset] of [batch.slice(0, middle), batch.slice(middle)].entries()) {
        retain(subset, await compare(subset, 'screening', index, [], part + 1));
      }
    }
  }

  if (!contenders.size) {
    // No batch proposed a paper. Keep answer content unresolved. A blank is
    // trusted only when every independent batch agreed that page was blank.
    const last = findings.at(-1);
    const pages = last.pages.map((page) => ({
      ...page, section: 'none', paper_id: 0, questions: [],
      has_answers: findings.some((finding) => finding.pages.find((p) => p.page === page.page)?.has_answers !== false),
    }));
    return finish({ pages, papers: [] }, [], false);
  }

  const finalists = candidates.filter((paper) => contenders.has(Number(paper.id)));
  if (finalists.length > BANK_COMPARISON_FINALIST_LIMIT) {
    throw comparisonError(`All ${candidates.length} compatible question papers were inspected, but ${finalists.length} remain plausible. The final comparison supports at most ${BANK_COMPARISON_FINALIST_LIMIT} full PDFs at once. Identify the administered master or narrow the compatible bank; no paper was selected and no contender was dropped.`, 'QUESTION_BANK_FINALIST_LIMIT', {
      considered_candidate_ids: [...considered], finalist_ids: finalists.map((paper) => Number(paper.id)),
    });
  }
  // Even one surviving contender is rechecked after the entire bank has been
  // searched. A batch's local high-confidence finding is never returned as-is.
  const result = await compare(finalists, 'final', batchCount, findings);
  // A later comparison cannot erase writing observed in any earlier batch.
  // Keep contradictory blank claims unresolved, never silently discard a page.
  const blankConflicts = result.pages.filter((page) => page.has_answers === false &&
    findings.some((finding) => finding.pages.some((prior) => prior.page === page.page && prior.has_answers === true))).map((page) => page.page);
  const reconciled = { ...result, pages: result.pages.map((page) => blankConflicts.includes(page.page)
    ? { ...page, section: 'none', paper_id: 0, questions: [], has_answers: true,
      header_evidence: { status: 'unresolved', reason: 'Earlier source inspection found writing; the final blank claim needs reconciliation.' } }
    : page) };
  return { ...finish(reconciled, finalists.map((paper) => Number(paper.id)), true),
    blank_conflict_pages: blankConflicts };
}
