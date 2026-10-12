import { nameRelationship } from './identity.js';
// Pure contracts between paper extraction, response matching and marking.
// No model output may replace source question identity, printed marks or text.
export const PIPELINE_VERSION = 'grounded-finalization-v2';
export const RUBRIC_POLICY = 'provisional-inferred-v1';
export const RESPONSE_STATUSES = ['answered', 'partial', 'unreadable', 'unanswered', 'section_not_supplied', 'missing_page', 'extraction_failure', 'unmatched', 'identity_unresolved', 'marking_unavailable', 'paper_unavailable'];
const object = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const string = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const array = (items) => ({ type: 'array', items });
const choice = (values) => ({ type: 'string', enum: values });
const section = choice(['A', 'B', 'C', '']);

export const PAPER_SCHEMA = object({
  issues: array(string),
  questions: array(object({
    section, question: string, question_text: string, max_marks: number,
    source_id: string, source_page: integer, printed_marks: string,
    expected_answer: string,
    criteria: array(object({ criterion: string, max_marks: number })),
    assumptions: array(string), issues: array(string),
  })),
});
export const RESPONSE_SCHEMA = object({
  paper_match: choice(['matched', 'mismatch', 'uncertain']), match_reason: string,
  page_identity: array(object({ page: integer, name: string, status: choice(['consistent', 'not_visible', 'uncertain', 'conflict']) })),
  sections: array(object({ section, status: choice(['supplied_complete', 'not_supplied', 'incomplete']), source_pages: array(integer), reason: string })),
  answers: array(object({ row: integer, status: choice(RESPONSE_STATUSES), teacher_answer: string, source_pages: array(integer), uncertainty: string,
    alignment: choice(['matched', 'uncertain', 'unmatched']), alignment_evidence: string })),
});
export const MARK_SCHEMA = object({
  questions: array(object({ row: integer, marks_awarded: number, feedback: string,
    credits: array(object({ criterion: integer, marks_awarded: number, evidence_quote: string, reason: string })),
  })),
  summary: string, strengths: array(string), areas_to_improve: array(string),
});

export const PAPER_INSTRUCTIONS = `Extract the selected administered question paper before seeing any teacher answers. The selected master is authoritative: never substitute a similar paper, subject or level. Copy every question/part identifier and preserve its section. Each lettered part is one row; keep distinct questions distinct. Read the printed right-hand marks column, not a guessed equal allocation or paper headline total. max_marks must be exactly the printed marks for that row and printed_marks the literal marks label. Copy source_id from the supplied source catalogue and source_page from its actual 1-based page. For a scanned source (one image), source_page is 1. Report incompatible masters or unusable whole papers in top-level issues; report unreadable/missing/ambiguous marks, incomplete individual questions and rubric uncertainties in that question’s issues; do not invent or silently rescale marks. If a sitting section is specified, extract only that section. Never relabel questions of another section to make them fit.

No approved answer scheme is supplied. Prepare an explicitly PROVISIONAL INFERRED rubric independently of the teacher's answers: expected_answer contains correct, source-specific guidance (original language for language exercises); criteria specify distinct creditable points whose maxima sum exactly to the printed row maximum. Allow supported partial credit in half-mark steps. Preserve source words needed to answer grammar/language questions. List any rubric assumptions internally. Do not describe this as an approved scheme. Questions about AI remain legitimate academic content.`;
export const RESPONSE_INSTRUCTIONS = `Read the response sources and match them to the immutable question ledger. This step extracts evidence only and awards NO marks. Preserve the teacher's own language, script, mistakes and actual words. Never complete an answer, invent an omitted answer, translate it into a false quote or copy expected-answer guidance into teacher_answer. Use [illegible] for unclear words and a short professional uncertainty note. Partial readable answers remain partial and may earn supported credit later. A failed OCR reading is not a blank answer; inspect the source image. Use extraction_failure if the evidence still cannot be inspected, unreadable for visible writing that cannot be read, missing_page for a demonstrably missing page, and unanswered only for an answer absent in a supplied complete section. Entire sections with no response pages are not_supplied and their answer status is section_not_supplied. A supplied section with every answer blank is still supplied_complete and scores zero. Do not classify an entire section absent merely because every answer is blank. If a sitting section is specified and its response pages are present, that section is supplied unless there is evidence of incompleteness.

Check every page's written teacher identity against the expected teacher, using full name, class and subject. A different teacher on any page is conflict; never merge them. A page with no name is not_visible, not an invented identity. For each ledger row return exactly one answer with its 1-based row and exact source page numbers. For each ledger section return completeness and page evidence. Preserve uncertain paper/question alignment as uncertain; incompatible Primary/Middle/High, subject or paper content is mismatch. Generic topic resemblance alone cannot establish a match. Never relabel evidence or replace the selected administered master. paper_match must be matched only when the actual response can be aligned to these questions. Also assess each row independently: alignment is matched only where question labels, actual wording, or specific response content support that exact ledger row; record that evidence internally in alignment_evidence. A generally uncertain paper can have independently matched rows, but topic resemblance alone is not enough. Exhaust the readable content before declaring a row unassessable. Keep every technical explanation in uncertainty or alignment_evidence, never in the teacher answer. Source metadata may list unresolved_sibling_pages from the same original submission: these omitted pages may contain apparent missing answers, so never label those omissions unanswered unless complete response coverage is positively established.`;
export const MARK_INSTRUCTIONS = `Evaluate only the extracted teacher answers against the supplied immutable question ledger and its PROVISIONAL INFERRED rubric. Do not change question identity, text, maxima, expected answers, coverage or transcription. Return exactly one result for each row. For assessable:false questions and unassessable/not-supplied answers, return zero (an internal placeholder, not a score) and zero credit; never guess. Give each rubric criterion one credit entry, in order, with the 1-based criterion index. Award supported correct and relevant content, including readable partial answers, in steps of 0.5, no more than that criterion's maximum. Every positive credit must quote an exact substring of the extracted teacher_answer as evidence. Do not invent evidence, reward expected answers instead of actual answers, or award marks to a blank/unreadable/absent answer. For zero credit evidence_quote is empty. The row's marks_awarded is the exact sum of criterion credits. Keep feedback professional, specific and grounded; describe unclear handwriting simply. Do not include process or model commentary in feedback, summary or guidance. No approved scheme is supplied: keep inferred-rubric assumptions in the audit, not claims of official approval. Answer-language choice alone never loses marks.`;

function fail(message) {
  const error = new Error(message);
  error.userMessage = `Assessment validation: ${message}`;
  error.code = 'GROUNDING_REVIEW_REQUIRED';
  throw error;
}
const close = (a, b) => Math.abs(a - b) < 0.00001;
const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clean = (value) => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
export const questionKey = (q) => `${q.section}|${clean(q.question).toUpperCase().replace(/[\s()]/gu, '')}`;

// Indian-script digits are valid printed marks; compound labels must identify
// one total rather than allowing an arbitrary numeral to justify the maximum.
export function printedMaximum(label) {
  const starts = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10];
  const text = String(label).replace(/\p{Nd}/gu, (c) => {
    const code = c.codePointAt(0), start = starts.find((n) => code >= n && code < n + 10);
    return start === undefined ? c : String(code - start);
  });
  const equation = /(?:=|total\s*[:=]?)\s*(\d+(?:\.\d+)?)/iu.exec(text);
  if (equation) return Number(equation[1]);
  const product = /^\s*[(\[]?\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[)\]]?\s*$/iu.exec(text);
  if (product) return Number(product[1]) * Number(product[2]);
  const numbers = text.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return numbers.length === 1 ? numbers[0] : null;
}

export function validatePaper(raw, sources, sittingSection = '') {
  if (!raw || !Array.isArray(raw.questions) || !raw.questions.length) fail('No source questions were extracted. Check the selected master.');
  if (raw.issues?.length) fail(`Question-paper extraction: ${raw.issues.join(' ')}`);
  const known = new Map(sources.map((s) => [s.source_id, s]));
  const seen = new Set();
  return raw.questions.map((q, index) => {
    if (q.issues?.length) fail(`Question ${q.question}: ${q.issues.join(' ')}`);
    if (!['A', 'B', 'C', ''].includes(q.section)) fail('Unrecognized question section.');
    if (sittingSection && q.section !== sittingSection) fail(`The selected paper does not identify question ${q.question} as Section ${sittingSection}.`);
    if (!clean(q.question) || !clean(q.question_text) || !clean(q.expected_answer)) fail('A question identifier, text or expected answer is missing.');
    const key = questionKey(q);
    if (seen.has(key)) fail(`Duplicate question identity ${key}.`);
    seen.add(key);
    const source = known.get(q.source_id);
    if (source?.sections && !String(source.sections).split(',').includes(q.section)) fail(`Question ${q.question} belongs to a different section than its selected source.`);
    if (!source || !Number.isInteger(q.source_page) || q.source_page < 1 || (source.pages && q.source_page > source.pages)) fail(`Question ${q.question} has an invalid source page.`);
    if (!finite(q.max_marks) || q.max_marks <= 0 || !clean(q.printed_marks)) fail(`Question ${q.question} needs legible printed marks.`);
    // A literal printed number must support the claimed maximum. No rescaling.
    const printed = printedMaximum(q.printed_marks);
    if (printed === null || !close(printed, q.max_marks)) fail(`Question ${q.question}'s maximum does not match its printed marks label.`);
    if (!q.criteria?.length || q.criteria.some((c) => !clean(c.criterion) || !finite(c.max_marks) || c.max_marks <= 0 || !Number.isInteger(c.max_marks * 2)) || !close(sum(q.criteria, 'max_marks'), q.max_marks)) fail(`Question ${q.question}'s provisional rubric does not add up to its printed maximum.`);
    return { ...q, row: index + 1, rubric_policy: RUBRIC_POLICY };
  });
}

// After one source-based repair attempt, retain only questions whose source
// identity is still defensible. Unreadable marks or an inconsistent inferred
// rubric cannot poison other questions, nor justify an invented maximum.
export function qualifyPaper(raw, sources, sittingSection = '') {
  if (!raw?.questions?.length || raw.issues?.length) return validatePaper(raw, sources, sittingSection);
  const seen = new Set();
  return raw.questions.map((q, i) => {
    const key = questionKey(q);
    if (seen.has(key)) fail(`Duplicate question identity ${key}.`);
    seen.add(key);
    try { return { ...validatePaper({ issues: [], questions: [q] }, sources, sittingSection)[0], row: i + 1, assessable: true }; }
    catch (error) {
      const source = sources.find((s) => s.source_id === q.source_id);
      if (!source || !clean(q.question) || !clean(q.question_text) || !['A', 'B', 'C', ''].includes(q.section) ||
        sittingSection && q.section !== sittingSection || source.sections && !String(source.sections).split(',').includes(q.section) ||
        !Number.isInteger(q.source_page) || q.source_page < 1 || source.pages && q.source_page > source.pages) throw error;
      const maximum = printedMaximum(q.printed_marks);
      return { ...q, row: i + 1, assessable: false, max_marks: maximum > 0 ? maximum : null,
        expected_answer: '', criteria: [], rubric_policy: RUBRIC_POLICY, paper_issue: error.message };
    }
  });
}

function pageList(pages, total) {
  return Array.isArray(pages) && new Set(pages).size === pages.length && pages.every((p) => Number.isInteger(p) && p >= 1 && p <= total);
}
export function validateResponse(raw, ledger, pageCount, sittingSection = '', context = {}) {
  if (context.finalize) return finalizeResponse(raw, ledger, pageCount, sittingSection, context);
  if (raw.paper_match !== 'matched') fail(`Response/question-paper alignment is ${raw.paper_match || 'unverified'}. ${raw.match_reason || ''}`);
  if (!Array.isArray(raw.page_identity) || raw.page_identity.length !== pageCount || new Set(raw.page_identity.map((p) => p.page)).size !== pageCount || !pageList(raw.page_identity.map((p) => p.page), pageCount)) fail('Teacher identity was not checked for every source page.');
  for (const p of raw.page_identity) {
    let provenance = {};
    try { provenance = JSON.parse(context.pages?.[p.page - 1]?.source_metadata ?? '{}'); } catch { /* unverified metadata grants nothing */ }
    const reviewed = provenance.identity_confirmed === true && provenance.teacher_id === context.teacher?.id;
    const relation = context.teacher?.name && clean(p.name) ? nameRelationship(context.teacher.name, p.name) : null;
    if (relation === 'conflict' || p.status === 'conflict') fail(`Source page ${p.page} names a different teacher. Check and separate the pages.`);
    if (!['consistent', 'not_visible', 'uncertain'].includes(p.status) || ((p.status === 'uncertain' || relation === 'unknown') && !reviewed)) fail('One or more source pages have conflicting or uncertain teacher identity. Check and separate the pages.');
  }
  const keys = [...new Set(ledger.map((q) => q.section))];
  const sections = new Map((raw.sections ?? []).map((s) => [s.section, s]));
  if (sections.size !== keys.length || raw.sections?.length !== keys.length || keys.some((key) => !sections.has(key))) fail('Section coverage does not match the selected paper.');
  for (const s of sections.values()) {
    if (!pageList(s.source_pages, pageCount)) fail('Invalid section source-page references.');
    if (s.status === 'incomplete' || !['supplied_complete', 'not_supplied'].includes(s.status)) fail(`Section ${s.section} may have missing pages. ${s.reason || ''}`);
    if (s.status === 'supplied_complete' && !s.source_pages.length) fail(`Section ${s.section} has no supporting response pages.`);
    if (s.status === 'not_supplied' && (s.source_pages.length || s.section === sittingSection)) fail(`Section ${s.section} coverage conflicts with the supplied sitting.`);
  }
  const supplied = [...sections.values()].filter((s) => s.status === 'supplied_complete');
  if (!supplied.length || new Set(supplied.flatMap((s) => s.source_pages)).size !== pageCount) fail('Every uploaded response page must be accounted for in a supplied section; review unassigned pages.');
  if (raw.answers?.length !== ledger.length || new Set(raw.answers.map((a) => a.row)).size !== ledger.length) fail('Response extraction omitted or duplicated a question.');
  const byRow = new Map(raw.answers.map((a) => [a.row, a]));
  const answers = ledger.map((q) => {
    const a = byRow.get(q.row);
    if (!a || !RESPONSE_STATUSES.includes(a.status) || !pageList(a.source_pages, pageCount)) fail(`Question ${q.question} has invalid response evidence.`);
    const coverage = sections.get(q.section);
    if (['missing_page', 'extraction_failure'].includes(a.status)) fail(`Question ${q.question}: ${a.status.replaceAll('_', ' ')}. ${a.uncertainty || ''}`);
    if ((coverage.status === 'not_supplied') !== (a.status === 'section_not_supplied')) fail(`Question ${q.question}'s status conflicts with section coverage.`);
    if (a.source_pages.some((p) => !coverage.source_pages.includes(p))) fail(`Question ${q.question} cites a page outside its section.`);
    if (['answered', 'partial', 'unreadable'].includes(a.status) && !a.source_pages.length) fail(`Question ${q.question} has no source page.`);
    if (['answered', 'partial'].includes(a.status) && !clean(a.teacher_answer)) fail(`Question ${q.question} has no extracted answer.`);
    if (['unanswered', 'section_not_supplied'].includes(a.status) && clean(a.teacher_answer)) fail(`Question ${q.question} has text but is labelled absent.`);
    const handwritingNote = a.status === 'unreadable' ? 'The handwriting could not be read reliably.'
      : ['answered', 'partial'].includes(a.status) && /\[\s*(?:illegible|unreadable|unclear)/iu.test(a.teacher_answer) ? 'Part of the handwriting is unclear; only readable content is credited.' : '';
    return { ...a, teacher_answer: String(a.teacher_answer ?? '').trim(), uncertainty: String(a.uncertainty ?? '').trim() || handwritingNote };
  });
  return { ...raw, answers, sections: [...sections.values()] };
}

// Terminal evidence qualification is deliberately separate from strict
// validation. Uncertainty can exclude evidence; impossible source references,
// duplicate rows and fabricated credit can never become successful marks.
export function finalizeResponse(raw, ledger, pageCount, sittingSection = '', context = {}) {
  if (!raw || !['matched', 'uncertain', 'mismatch'].includes(raw.paper_match)) fail('Invalid paper alignment.');
  if (!Array.isArray(raw.page_identity) || raw.page_identity.length !== pageCount || !pageList(raw.page_identity.map((p) => p.page), pageCount)) fail('Teacher identity was not checked for every source page.');
  const excluded = [];
  for (const p of raw.page_identity) {
    if (!['consistent', 'not_visible', 'uncertain', 'conflict'].includes(p.status)) fail('Invalid page identity state.');
    let provenance = {};
    try { provenance = JSON.parse(context.pages?.[p.page - 1]?.source_metadata ?? '{}'); } catch { /* No implicit identity approval. */ }
    const reviewed = provenance.identity_confirmed === true && provenance.teacher_id === context.teacher?.id;
    const relation = context.teacher?.name && clean(p.name) ? nameRelationship(context.teacher.name, p.name) : null;
    if (relation === 'conflict' || p.status === 'conflict' || (!reviewed && (p.status === 'uncertain' || relation === 'unknown'))) excluded.push(p.page);
  }
  const unresolvedSiblings = (context.pages ?? []).some((p) => {
    try { return JSON.parse(p.source_metadata ?? '{}').unresolved_sibling_pages?.length > 0; } catch { return false; }
  });
  const keys = [...new Set(ledger.map((q) => q.section))];
  if (!Array.isArray(raw.sections) || raw.sections.length !== keys.length || new Set(raw.sections.map((s) => s.section)).size !== keys.length) fail('Section coverage does not match the selected paper.');
  const sections = new Map(raw.sections.map((s) => [s.section, { ...s, source_pages: [...s.source_pages] }]));
  if (keys.some((key) => !sections.has(key))) fail('Section coverage does not match the selected paper.');
  for (const s of sections.values()) {
    if (!pageList(s.source_pages, pageCount) || !['supplied_complete', 'incomplete', 'not_supplied'].includes(s.status)) fail('Invalid section source evidence.');
    if (s.status === 'not_supplied' && s.source_pages.length) fail('An absent section cannot cite supplied pages.');
    if (s.status === 'not_supplied' && s.section === sittingSection && pageCount) s.status = 'incomplete';
    if (s.status === 'supplied_complete' && !s.source_pages.length) fail('A complete section has no supporting response pages.');
    if (s.source_pages.some((page) => excluded.includes(page))) s.status = 'incomplete';
    // Omitted sibling pages may contain an apparent blank's answer. All ledger
    // rows must have readable responses before completeness can be retained.
    if (unresolvedSiblings && s.status === 'supplied_complete' && ledger.filter((q) => q.section === s.section).some((q) => !['answered', 'partial'].includes(raw.answers?.find((a) => a.row === q.row)?.status))) s.status = 'incomplete';
  }
  const accounted = new Set([...sections.values()].flatMap((s) => s.source_pages));
  const unassigned = Array.from({ length: pageCount }, (_, i) => i + 1).filter((page) => !accounted.has(page));
  if (unassigned.length) for (const s of sections.values()) if (s.status === 'supplied_complete') s.status = 'incomplete';
  if (raw.answers?.length !== ledger.length || new Set(raw.answers.map((a) => a.row)).size !== ledger.length) fail('Response extraction omitted or duplicated a question.');
  const byRow = new Map(raw.answers.map((a) => [a.row, a]));
  const answers = ledger.map((q) => {
    const a = byRow.get(q.row), coverage = sections.get(q.section);
    if (!a || !RESPONSE_STATUSES.includes(a.status) || !pageList(a.source_pages, pageCount)) fail(`Question ${q.question} has invalid response evidence.`);
    if (a.source_pages.some((page) => !coverage.source_pages.includes(page))) fail(`Question ${q.question} cites a page outside its section.`);
    if (['answered', 'partial', 'unreadable'].includes(a.status) && !a.source_pages.length) fail(`Question ${q.question} has no source page.`);
    if (['answered', 'partial'].includes(a.status) && !clean(a.teacher_answer)) fail(`Question ${q.question} has no extracted answer.`);
    if (['unanswered', 'section_not_supplied'].includes(a.status) && clean(a.teacher_answer)) fail(`Question ${q.question} has text but is labelled absent.`);
    let status = a.status, answer = String(a.teacher_answer ?? '').trim();
    const alignment = a.alignment ?? (raw.paper_match === 'matched' ? 'matched' : 'uncertain');
    if (!['matched', 'uncertain', 'unmatched'].includes(alignment)) fail('Invalid question alignment.');
    if (coverage.status === 'not_supplied') {
      if (a.status !== 'section_not_supplied') fail('An absent section has a contradictory response.');
      status = 'section_not_supplied';
    } else if (q.assessable === false && !(a.status === 'unanswered' && q.max_marks > 0)) {
      status = 'paper_unavailable';
    } else if (a.source_pages.some((page) => excluded.includes(page))) {
      status = 'identity_unresolved'; answer = '';
    } else if (raw.paper_match === 'mismatch' || alignment !== 'matched' || (raw.paper_match !== 'matched' && !clean(a.alignment_evidence))) {
      status = 'unmatched';
    } else if (status === 'unanswered' && coverage.status !== 'supplied_complete') {
      status = 'missing_page';
    } else if (status === 'section_not_supplied') {
      status = 'missing_page';
    }
    return { ...a, status, teacher_answer: answer, alignment,
      assessment_state: status === 'section_not_supplied' ? 'not_supplied' : ['answered', 'partial', 'unanswered'].includes(status) ? 'assessed' : 'unassessable',
      qualification: ['answered', 'partial'].includes(status) && /\[\s*(?:illegible|unreadable|unclear)/iu.test(answer) ? 'limited_readability' : null,
      uncertainty: String(a.uncertainty ?? '').trim() };
  });
  return { ...raw, answers, sections: [...sections.values()], excluded_response_pages: excluded, unassigned_response_pages: unassigned };
}

export const responseNeedsResolution = (raw) => raw?.paper_match !== 'matched' ||
  raw?.page_identity?.some((p) => ['uncertain', 'conflict'].includes(p.status)) ||
  raw?.sections?.some((s) => s.status === 'incomplete') ||
  raw?.answers?.some((a) => !['answered', 'partial', 'unanswered', 'section_not_supplied'].includes(a.status) || a.alignment && a.alignment !== 'matched' || /\[\s*(?:illegible|unreadable|unclear)/iu.test(a.teacher_answer ?? ''));

// No provider is needed to establish zero for a verified blank. Every other
// unmarked answer remains unavailable, never a made-up zero.
export function unavailableMarks(ledger, response, reason = 'marking_unavailable') {
  const qualified = { ...response, answers: response.answers.map((a) => ['answered', 'partial'].includes(a.status)
    ? { ...a, status: reason, assessment_state: 'unassessable' } : a) };
  const raw = { questions: ledger.map((q) => ({ row: q.row, marks_awarded: 0, feedback: '',
    credits: q.criteria.map((_, i) => ({ criterion: i + 1, marks_awarded: 0, evidence_quote: '', reason: '' })) })),
  summary: '', strengths: [], areas_to_improve: [] };
  return validateMarks(raw, ledger, qualified);
}

export function validateMarks(raw, ledger, response) {
  if (raw.questions?.length !== ledger.length || new Set(raw.questions.map((q) => q.row)).size !== ledger.length) fail('Marking omitted or duplicated a question.');
  const byRow = new Map(raw.questions.map((q) => [q.row, q]));
  const answers = new Map(response.answers.map((a) => [a.row, a]));
  const questions = ledger.map((q) => {
    const m = byRow.get(q.row);
    const a = answers.get(q.row);
    if (!m || !finite(m.marks_awarded) || m.marks_awarded < 0 || m.marks_awarded > q.max_marks) fail(`Question ${q.question} has invalid marks.`);
    if (m.credits?.length !== q.criteria.length) fail(`Question ${q.question} has an incomplete credit audit.`);
    m.credits.forEach((credit, i) => {
      if (credit.criterion !== i + 1 || !finite(credit.marks_awarded) || credit.marks_awarded < 0 || credit.marks_awarded > q.criteria[i].max_marks || !Number.isInteger(credit.marks_awarded * 2)) fail(`Question ${q.question} has invalid criterion credit.`);
      if (credit.marks_awarded > 0 && (!['answered', 'partial'].includes(a.status) || !clean(credit.evidence_quote) || /\[\s*(?:illegible|unreadable|unclear|uncertain)[^\]]*\]/iu.test(credit.evidence_quote) || !/[\p{L}\p{N}]/u.test(credit.evidence_quote) || !clean(a.teacher_answer).includes(clean(credit.evidence_quote)))) fail(`Question ${q.question} has credit unsupported by its extracted answer.`);
    });
    if (!close(sum(m.credits, 'marks_awarded'), m.marks_awarded)) fail(`Question ${q.question}'s credits do not add up.`);
    if (!['answered', 'partial'].includes(a.status) && m.marks_awarded !== 0) fail(`Question ${q.question} cannot receive marks without readable evidence.`);
    return {
      section: q.section ? `Section ${q.section}` : '', question: q.question, question_text: q.question_text,
      teacher_answer: ['unmatched', 'paper_unavailable', 'identity_unresolved'].includes(a.status) ? '' : a.teacher_answer, expected_answer: q.expected_answer,
      max_marks: q.max_marks, marks_awarded: ['answered', 'partial', 'unanswered'].includes(a.status) ? m.marks_awarded : null,
      assessment_state: a.status === 'section_not_supplied' ? 'not_supplied' : ['answered', 'partial', 'unanswered'].includes(a.status) ? 'assessed' : 'unassessable',
      qualification: a.qualification ?? (['answered', 'partial'].includes(a.status) && /\[\s*(?:illegible|unreadable|unclear)/iu.test(a.teacher_answer) ? 'limited_readability' : null),
      feedback: a.status === 'unreadable' ? 'The handwriting could not be read reliably.'
        : !['answered', 'partial', 'unanswered', 'section_not_supplied'].includes(a.status) ? 'Not assessable from the submitted response.'
          : a.status === 'section_not_supplied' ? '' : (a.qualification === 'limited_readability' || /\[\s*(?:illegible|unreadable|unclear)/iu.test(a.teacher_answer)) ? `${m.feedback} Part of the handwriting is unclear; marks reflect readable content.`.trim() : m.feedback,
      response_status: a.status, source_pages: a.source_pages,
      question_source: { source_id: q.source_id, page: q.source_page, printed_marks: q.printed_marks },
      audit: { rubric_policy: RUBRIC_POLICY, criteria: q.criteria, credits: m.credits, assumptions: q.assumptions, uncertainty: a.uncertainty, unaligned_response: ['unmatched', 'paper_unavailable'].includes(a.status) ? a.teacher_answer : null, paper_issue: q.paper_issue ?? null },
    };
  });
  return { ...raw, questions, submission: { sections: response.sections }, audit: { pipeline_version: PIPELINE_VERSION, rubric_policy: RUBRIC_POLICY, paper_match: response.paper_match, match_reason: response.match_reason, page_identity: response.page_identity, excluded_response_pages: response.excluded_response_pages ?? [], unassigned_response_pages: response.unassigned_response_pages ?? [] } };
}

// A malformed score for one row must not erase independently validated rows.
// Invalid rows become explicitly unassessable after the bounded repair pass.
export function qualifyMarks(raw, ledger, response) {
  const fallback = unavailableMarks(ledger, response);
  const counts = new Map();
  for (const row of raw?.questions ?? []) counts.set(row.row, (counts.get(row.row) ?? 0) + 1);
  const issues = [];
  const questions = ledger.map((q, i) => {
    const marking = raw?.questions?.find((m) => m.row === q.row);
    try {
      if (counts.get(q.row) !== 1) fail('Missing or duplicate marking row.');
      return validateMarks({ questions: [marking], summary: '', strengths: [], areas_to_improve: [] }, [q],
        { ...response, answers: response.answers.filter((a) => a.row === q.row) }).questions[0];
    } catch (error) {
      issues.push({ row: q.row, error: error.message });
      return fallback.questions[i];
    }
  });
  return { ...fallback, questions, audit: { ...fallback.audit, marking_issues: issues } };
}
