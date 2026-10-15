// Read-only diagnostics from the authenticated bulk response. Keep the
// projection explicit: no prompts, answers, images, credentials, or arbitrary
// nested payloads. This module must never be used to decide or change a match.
import { h } from './ui.js';

export const MATCH_EVIDENCE_LIMITS = Object.freeze({ pages: 100, sections: 20, labels: 50, issues: 20, ids: 50, text: 600, label: 80, heading: 300 });
const NOT_RECORDED = 'Not recorded';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;
const headerStatuses = new Set(['not_present', 'descriptive', 'compatible', 'conflict', 'unresolved']);
const confidenceLevels = new Set(['high', 'medium', 'low']);
const contentStatuses = new Map([['complete', 'Complete'], ['running', 'Running'], ['failed', 'Failed'], ['stale', 'Sources changed; compare again'], ['not_started', 'Not started']]);
const identityStatuses = new Map([['needs_review', 'Needs review'], ['verified', 'Verified']]);
const metadataFields = [['name_written', 'Name'], ['grade_written', 'Class'], ['subjects_written', 'Subject'], ['paper_title_written', 'Paper heading']];
const proposedMaster = value => positiveId(value) ? String(value) : value === null || value === 0 ? 'None proposed' : NOT_RECORDED;

function text(value, limit = MATCH_EVIDENCE_LIMITS.text) {
  if (typeof value !== 'string') return NOT_RECORDED;
  // Plain text only; control characters cannot disguise the surrounding labels.
  const clipped = value.slice(0, limit).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return `${clipped || '(blank)'}${value.length > limit ? '… [truncated]' : ''}`;
}

function list(value, limit, accept, project = value => value) {
  if (!Array.isArray(value)) return { available: false, values: [], omitted: 0, invalid: 0 };
  const entries = value.slice(0, limit);
  return {
    available: true,
    values: entries.filter(accept).map(project),
    omitted: Math.max(0, value.length - limit),
    invalid: entries.filter(entry => !accept(entry)).length,
  };
}

const labels = value => list(value, MATCH_EVIDENCE_LIMITS.labels, entry => typeof entry === 'string', entry => text(entry, MATCH_EVIDENCE_LIMITS.label));
const ids = value => list(value, MATCH_EVIDENCE_LIMITS.ids, positiveId);
const idCount = value => Array.isArray(value) ? new Set(value.filter(positiveId)).size : null;

export function questionMatchEvidence(page) {
  const match = record(page?.match) ? page.match : null;
  const pageNumber = positiveId(page?.position) ? page.position : positiveId(match?.source_page) ? match.source_page : null;
  if (!match) return { page: pageNumber, available: false };
  const header = record(match.header_evidence) ? match.header_evidence : {};
  return {
    page: pageNumber,
    available: true,
    proposedMaster: proposedMaster(match.paper_id),
    sourceHeading: text(match.source_heading, MATCH_EVIDENCE_LIMITS.heading),
    headerStatus: headerStatuses.has(header.status) ? header.status : NOT_RECORDED,
    headerReason: text(header.reason),
    confidence: confidenceLevels.has(match.confidence) ? match.confidence : NOT_RECORDED,
    reason: text(match.reason),
    questions: labels(match.questions),
    issues: list(match.issues, MATCH_EVIDENCE_LIMITS.issues, entry => typeof entry === 'string', entry => text(entry)),
    matchedQuestionLabels: labels(match.matched_question_labels),
    alternatives: ids(match.alternatives),
    summaryCount: count(match.summary_count),
  };
}

export function bankComparisonEvidence(summary) {
  if (!record(summary)) return { available: false };
  const screenedIds = summary.coverage_mode === 'content_first' && Array.isArray(summary.text_screened_ids) && Array.isArray(summary.full_pdf_screened_ids)
    ? [...summary.text_screened_ids, ...summary.full_pdf_screened_ids] : null;
  return {
    available: true,
    complete: flag(summary.complete),
    candidateCount: count(summary.candidate_count),
    batchCount: count(summary.batch_count),
    finalistIds: ids(summary.finalist_ids),
    finalCompared: flag(summary.final_compared),
    phase: ['indexing', 'screening', 'final_comparison', 'profile_fallback'].includes(summary.phase) ? summary.phase : null,
    completedCandidates: idCount(summary.completed_candidate_ids) ?? idCount(screenedIds),
    reusedCandidates: count(summary.reused_candidate_count),
    coverageMode: summary.coverage_mode === 'content_first' ? 'content_first' : null,
    textScreenedCandidates: idCount(summary.text_screened_ids),
    pdfScreenedCandidates: idCount(summary.full_pdf_screened_ids),
    fullPdfVerifiedIds: ids(summary.full_pdf_verified_ids),
    ambiguousEquivalentIds: ids(summary.ambiguous_equivalent_ids),
  };
}

// These independent server statuses are never inferred from one another, page
// confidence, or bank coverage. A completed comparison can retain ambiguity.
export function contentMatchEvidence(content) {
  if (!record(content)) return { available: false };
  return {
    available: true,
    status: contentStatuses.get(content.status) ?? NOT_RECORDED,
    coverage: bankComparisonEvidence(content.coverage),
    error: typeof content.error === 'string' && content.error.trim() ? text(content.error) : null,
    sections: list(content.sections, MATCH_EVIDENCE_LIMITS.sections, record, section => ({
      section: text(section.section, MATCH_EVIDENCE_LIMITS.label),
      proposedMaster: proposedMaster(section.paper_id),
      confidence: confidenceLevels.has(section.confidence) ? section.confidence : NOT_RECORDED,
      reason: text(section.reason),
      matchedQuestionLabels: labels(section.matched_question_labels),
      alternatives: ids(section.alternatives),
      pageIds: ids(section.page_ids),
      masterPages: ids(section.master_pages),
    })),
  };
}

export function identityReviewEvidence(identity) {
  if (!record(identity)) return { available: false };
  return {
    available: true,
    status: identityStatuses.get(identity.status) ?? NOT_RECORDED,
    problems: list(identity.problems, MATCH_EVIDENCE_LIMITS.issues, entry => typeof entry === 'string', entry => text(entry)),
  };
}

export function sourceMetadataEvidence(page) {
  const identity = record(page?.identity) ? page.identity : null;
  return {
    available: Boolean(identity),
    page: positiveId(page?.position) ? page.position : positiveId(identity?.source_page) ? identity.source_page : null,
    sourceFile: text(page?.source_file ?? identity?.source_file, MATCH_EVIDENCE_LIMITS.heading),
    fields: identity ? metadataFields.map(([key, label]) => ({
      label,
      recorded: text(identity[key], MATCH_EVIDENCE_LIMITS.heading),
      observed: text(identity.field_observations?.[key], MATCH_EVIDENCE_LIMITS.heading),
      original: record(identity.context_verification?.original_fields?.[key])
        ? text(identity.context_verification.original_fields[key].value, MATCH_EVIDENCE_LIMITS.heading) : null,
    })) : [],
  };
}

function listSummary(label, evidence) {
  const notes = [];
  if (!evidence.available) notes.push(NOT_RECORDED);
  else if (!evidence.values.length && !evidence.invalid && !evidence.omitted) notes.push('None recorded');
  if (evidence.invalid) notes.push(`${evidence.invalid} invalid recorded ${evidence.invalid === 1 ? 'entry' : 'entries'} not displayed`);
  if (evidence.omitted) notes.push(`${evidence.omitted} more recorded ${evidence.omitted === 1 ? 'entry' : 'entries'} not displayed (display limit)`);
  return h('p', {}, `${label}${notes.length ? `: ${notes.join('; ')}` : ':'}`);
}

function listView(label, evidence) {
  return h('div', {},
    listSummary(label, evidence),
    evidence.values.length ? h('ul', {}, evidence.values.map(value => h('li', {}, value))) : null);
}

const shownFlag = value => value === null ? NOT_RECORDED : value ? 'Yes' : 'No';

function bankComparisonView(bank) {
  return bank.available ? h('details', {},
    h('summary', {}, 'Question bank comparison'),
    h('p', {}, `Question-bank comparison recorded complete: ${shownFlag(bank.complete)}. Candidate count: ${bank.candidateCount ?? NOT_RECORDED}. Recorded batch count: ${bank.batchCount ?? NOT_RECORDED}. Final comparison performed: ${shownFlag(bank.finalCompared)}.`),
    h('p', {}, `All-bank coverage: ${bank.completedCandidates ?? NOT_RECORDED} of ${bank.candidateCount ?? NOT_RECORDED} candidate papers considered. Reused same-run candidate coverage: ${bank.reusedCandidates ?? NOT_RECORDED}. Incomplete coverage is diagnostic only; it cannot confirm a new match.`),
    bank.coverageMode === 'content_first' ? [
      h('p', {}, `Papers screened using complete text: ${bank.textScreenedCandidates ?? NOT_RECORDED}. Papers screened as full PDFs: ${bank.pdfScreenedCandidates ?? NOT_RECORDED}. Text screening is not full-PDF inspection. Final contenders require a separate full-PDF comparison; this still does not clear ambiguity or identity review.`),
      listView('Full-PDF verified finalist master IDs', bank.fullPdfVerifiedIds),
      listView('Content-equivalent master IDs (ambiguity retained)', bank.ambiguousEquivalentIds),
    ] : null,
    bank.phase ? h('p', {}, `Last recorded phase: ${bank.phase}.`) : null,
    listView('Finalist master IDs', bank.finalistIds)) : h('p', {}, 'Question bank comparison: Not recorded.');
}

function contentMatchView(content, bank) {
  const sections = content.available ? content.sections : null;
  return h('section', { 'data-content-match': true },
    h('h4', {}, 'Content Match'),
    h('p', {}, `Content Match: ${content.available ? content.status : NOT_RECORDED}.`),
    h('p', {}, 'Complete means the content-comparison pass finished. It does not mean every section has a unique master. Uncertain findings and alternative masters remain unresolved.'),
    content.error ? h('p', { class: 'notice' }, `Content matching error: ${content.error}`) : null,
    bankComparisonView(content.coverage?.available ? content.coverage : bank),
    sections ? listSummary('Content section findings', sections) : null,
    sections?.values.map((section, index) => h('details', { 'data-content-match-section': index + 1 },
      h('summary', {}, `Section ${section.section}: proposed master ${section.proposedMaster}`),
      h('p', {}, `Confidence: ${section.confidence}. Match reason: ${section.reason}`),
      listView('Matched question labels', section.matchedQuestionLabels),
      listView('Matched master PDF pages (contained paper)', section.masterPages),
      listView('Alternative master IDs', section.alternatives),
      listView('Source page IDs', section.pageIds))));
}

function identityReviewView(identity, sourcePages) {
  const metadata = sourcePages.slice(0, MATCH_EVIDENCE_LIMITS.pages).map(sourceMetadataEvidence).filter(page => page.available);
  return h('section', { 'data-identity-review': true },
    h('h4', {}, 'Identity Review'),
    h('p', {}, `Identity Review: ${identity.available ? identity.status : NOT_RECORDED}.`),
    h('p', {}, 'Content identification does not clear identity conflicts or authorize filing. Identity review and the existing filing checks remain separate; original source metadata is retained.'),
    identity.available ? listView('Identity review problems', identity.problems) : null,
    metadata.length ? h('details', {},
      h('summary', {}, 'Retained source metadata'),
      h('p', {}, 'These are stored observations, not verified identity. Detailed field-role and reread disagreements remain in Source identity evidence.'),
      metadata.map(page => h('div', {},
        h('p', {}, `Source page ${page.page ?? '(number not recorded)'}; original file: ${page.sourceFile}.`),
        page.fields.map(field => h('p', {}, `${field.label}: recorded ${field.recorded}; observed ${field.observed}${field.original !== null ? `; before independent check ${field.original}` : ''}.`))))) : null,
    sourcePages.length > MATCH_EVIDENCE_LIMITS.pages ? h('p', {}, `Source metadata is limited to the first ${MATCH_EVIDENCE_LIMITS.pages} pages.`) : null);
}

export function questionMatchEvidenceDrawer(pages, bankSummary, options = {}) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  const bank = bankComparisonEvidence(bankSummary);
  const content = contentMatchEvidence(options?.content_match);
  const identity = identityReviewEvidence(options?.identity_review);
  const separateStatuses = content.available || identity.available;
  if (!sourcePages.length && !bank.available && !separateStatuses) return null;
  return h('details', { class: 'hint', 'data-question-match-evidence': true, style: 'overflow-wrap:anywhere' },
    h('summary', {}, `Question match evidence${separateStatuses ? ` · Content Match: ${content.available ? content.status : NOT_RECORDED} · Identity Review: ${identity.available ? identity.status : NOT_RECORDED}` : ''}`),
    h('p', {}, 'Read-only stored matching evidence for operator review. Proposed IDs and confidence are recorded findings, not confirmation of the administered master. These details are not included in teacher reports.'),
    separateStatuses ? [contentMatchView(content, bank), identityReviewView(identity, sourcePages)] : bankComparisonView(bank),
    sourcePages.slice(0, MATCH_EVIDENCE_LIMITS.pages).map((page, index) => {
      const evidence = questionMatchEvidence(page);
      return h('details', { 'data-question-match-page': evidence.page ?? `unknown-${index + 1}` },
        h('summary', {}, `Source page ${evidence.page ?? '(number not recorded)'}`),
        evidence.available ? [
          h('p', {}, `Proposed master ID: ${evidence.proposedMaster}.`),
          h('p', {}, `Source heading: ${evidence.sourceHeading}`),
          h('p', {}, `Header status: ${evidence.headerStatus}. Header reason: ${evidence.headerReason}`),
          h('p', {}, `Confidence: ${evidence.confidence}. Match reason: ${evidence.reason}`),
          listView('Page question labels', evidence.questions),
          listView('Matching issues', evidence.issues),
          h('p', {}, `Matching paper-summary entries: ${evidence.summaryCount ?? NOT_RECORDED}.`),
          listView('Summary matched question labels', evidence.matchedQuestionLabels),
          listView('Alternative master IDs', evidence.alternatives),
        ] : h('p', {}, 'No stored question match evidence for this page.'));
    }),
    sourcePages.length > MATCH_EVIDENCE_LIMITS.pages
      ? h('p', {}, `Showing the first ${MATCH_EVIDENCE_LIMITS.pages} source pages; ${sourcePages.length - MATCH_EVIDENCE_LIMITS.pages} more pages are not displayed (display limit).`)
      : null);
}
