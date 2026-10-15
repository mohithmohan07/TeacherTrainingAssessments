// Read-only diagnostics from the authenticated bulk response. Keep the
// projection explicit: no prompts, answers, images, credentials, or arbitrary
// nested payloads. This module must never be used to decide or change a match.
import { h } from './ui.js';

export const MATCH_EVIDENCE_LIMITS = Object.freeze({ pages: 100, labels: 50, issues: 20, ids: 50, text: 600, label: 80, heading: 300 });
const NOT_RECORDED = 'Not recorded';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;
const headerStatuses = new Set(['not_present', 'descriptive', 'compatible', 'conflict', 'unresolved']);
const confidenceLevels = new Set(['high', 'medium', 'low']);

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

export function questionMatchEvidence(page) {
  const match = record(page?.match) ? page.match : null;
  const pageNumber = positiveId(page?.position) ? page.position : positiveId(match?.source_page) ? match.source_page : null;
  if (!match) return { page: pageNumber, available: false };
  const header = record(match.header_evidence) ? match.header_evidence : {};
  return {
    page: pageNumber,
    available: true,
    proposedMaster: positiveId(match.paper_id) ? String(match.paper_id) : match.paper_id === null || match.paper_id === 0 ? 'None proposed' : NOT_RECORDED,
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
  return {
    available: true,
    complete: flag(summary.complete),
    candidateCount: count(summary.candidate_count),
    batchCount: count(summary.batch_count),
    finalistIds: ids(summary.finalist_ids),
    finalCompared: flag(summary.final_compared),
    phase: ['screening', 'final_comparison', 'profile_fallback'].includes(summary.phase) ? summary.phase : null,
    completedCandidates: Array.isArray(summary.completed_candidate_ids) ? new Set(summary.completed_candidate_ids.filter(positiveId)).size : null,
    reusedCandidates: count(summary.reused_candidate_count),
  };
}

function listView(label, evidence) {
  const notes = [];
  if (!evidence.available) notes.push(NOT_RECORDED);
  else if (!evidence.values.length && !evidence.invalid && !evidence.omitted) notes.push('None recorded');
  if (evidence.invalid) notes.push(`${evidence.invalid} invalid recorded ${evidence.invalid === 1 ? 'entry' : 'entries'} not displayed`);
  if (evidence.omitted) notes.push(`${evidence.omitted} more recorded ${evidence.omitted === 1 ? 'entry' : 'entries'} not displayed (display limit)`);
  return h('div', {},
    h('p', {}, `${label}${notes.length ? `: ${notes.join('; ')}` : ':'}`),
    evidence.values.length ? h('ul', {}, evidence.values.map(value => h('li', {}, value))) : null);
}

const shownFlag = value => value === null ? NOT_RECORDED : value ? 'Yes' : 'No';

export function questionMatchEvidenceDrawer(pages, bankSummary) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  const bank = bankComparisonEvidence(bankSummary);
  if (!sourcePages.length && !bank.available) return null;
  return h('details', { class: 'hint', 'data-question-match-evidence': true, style: 'overflow-wrap:anywhere' },
    h('summary', {}, 'Question match evidence'),
    h('p', {}, 'Read-only stored matching evidence for operator review. Proposed IDs and confidence are recorded findings, not confirmation of the administered master. These details are not included in teacher reports.'),
    bank.available ? h('details', {},
      h('summary', {}, 'Question bank comparison'),
      h('p', {}, `Full comparison recorded complete: ${shownFlag(bank.complete)}. Candidate count: ${bank.candidateCount ?? NOT_RECORDED}. Recorded batch count: ${bank.batchCount ?? NOT_RECORDED}. Final comparison performed: ${shownFlag(bank.finalCompared)}.`),
      bank.phase ? h('p', {}, `Last recorded phase: ${bank.phase}. Completed candidate coverage: ${bank.completedCandidates ?? NOT_RECORDED}. Reused same-run candidate coverage: ${bank.reusedCandidates ?? 0}. Incomplete coverage is diagnostic only; it cannot confirm a new match.`) : null,
      listView('Finalist master IDs', bank.finalistIds)) : h('p', {}, 'Question bank comparison: Not recorded.'),
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
