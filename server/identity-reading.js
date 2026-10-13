// Read each source page independently in small image batches. Page numbers in
// provider responses are local to a batch; callers always receive original
// one-based indices into files. No teacher is inherited from another page.
export const IDENTITY_BATCH_SIZE = 8;
export const IDENTITY_REREAD_BATCH_SIZE = 4;

const fields = ['name_written', 'grade_written', 'subjects_written', 'paper_title_written'];
const origins = new Set(['identity_header', 'document_heading', 'answer_content', 'absent', 'uncertain']);
const confidences = new Set(['certain', 'uncertain', 'none']);
const languages = new Set(['english', 'other', 'mixed']);

const INDEPENDENT_INSTRUCTIONS = `Inspect each supplied page independently. The supplied roster and filename are context only: never copy a target teacher's identity from them, and never inherit an identity from another page or batch. Copy only text actually visible in that page's identity fields or administered document heading. A blank boxed Name/Class/Subject field remains blank even when an equation, formula, voltage, answer note or other handwriting is nearby. A report title, classroom example, question heading or heading within an answer is answer content, not the administered question-paper title. Use field_evidence to distinguish these visual roles; mark uncertain roles as uncertain rather than guessing. Return exactly one observation for every supplied image. Number observations with the LOCAL page numbers 1 through this batch's page count; the caller will restore original page numbers using the explicit map. Do not return observations for pages outside this batch.`;

const FOCUSED_INSTRUCTIONS = `FOCUSED IDENTITY REREAD: Read only the flagged source images supplied in this batch, once each. Inspect the actual boxed or labelled identity fields closely and distinguish their contents from adjacent answer-body text. In particular, equations such as Vc = 60V are not Class metadata, and report/assessment titles written inside an answer are not the administered paper's title. Do not try to make a page agree with a roster, filename, expected teacher, previous page or other source page. Preserve a genuinely different clearly written teacher name. If the field's role or handwriting remains uncertain, report that uncertainty faithfully.`;

function invalid(detail) {
  const error = new Error(`Identity reading returned invalid evidence: ${detail}. No page observations were replaced.`);
  error.code = 'IDENTITY_INVALID_EVIDENCE';
  error.userMessage = error.message;
  return error;
}

function validatePages(result, count, { provider = false } = {}) {
  if (!result || !Array.isArray(result.pages) || result.pages.length !== count) throw invalid('every supplied page must have exactly one observation');
  const seen = new Set();
  for (const page of result.pages) {
    if (!page || !Number.isSafeInteger(page.page) || page.page < 1 || page.page > count || seen.has(page.page)) {
      throw invalid('page numbers must be unique local integers from 1 through the batch page count');
    }
    seen.add(page.page);
    if (provider && Object.keys(page).some(key => ![...fields, 'page', 'teacher_id', 'name_confidence', 'language', 'languages', 'field_evidence', 'identity_panel_bounds'].includes(key))) {
      throw invalid(`page ${page.page} contains an unexpected or server-only property`);
    }
    if (!fields.every((key) => typeof page[key] === 'string') || !Number.isSafeInteger(page.teacher_id) || page.teacher_id < 0 ||
        !confidences.has(page.name_confidence) || !languages.has(page.language) ||
        !Array.isArray(page.languages) || !page.languages.every((language) => typeof language === 'string')) throw invalid(`page ${page.page} is malformed`);
    // The actual provider receives the caller's strict schema requiring these
    // fields. Older injected responses may omit evidence, but malformed
    // evidence must never be treated as a valid observation.
    if (Object.hasOwn(page, 'field_evidence')) {
      const evidence = page.field_evidence;
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
          Object.keys(evidence).some((key) => !fields.includes(key)) || !fields.every((key) => {
            const field = evidence[key];
            return field && typeof field === 'object' && !Array.isArray(field) && origins.has(field.origin) &&
              typeof field.reason === 'string' && Object.keys(field).every((part) => ['origin', 'reason'].includes(part));
          })) throw invalid(`page ${page.page} has malformed field evidence`);
    }
  }
  return result.pages;
}

async function storedPageInputs(files) {
  // Do not open the application database when tests inject synthetic inputs.
  const { pageInputs } = await import('./paper-inputs.js');
  return pageInputs('ANSWER SHEETS', files);
}

function validateOptions({ files, request, content }) {
  if (!Array.isArray(files)) throw new TypeError('Identity reading files must be an array.');
  if (typeof request !== 'function') throw new TypeError('Identity reading requires a request function.');
  if (!Array.isArray(content) || content.some((entry) => entry?.type !== 'input_text' || typeof entry.text !== 'string')) {
    throw new TypeError('Identity reading content must contain only roster/filename text; source images are batched separately.');
  }
}

async function readBatches({ files, request, instructions = '', schema, content = [], requestPolicy,
  timeoutMs = 120000, maxRetries = 1, pageInputs = storedPageInputs,
  name = 'answer_sheets_first_look', task = 'read the name and languages on these answer sheets',
  retry = 'Press Match again to try again.', priorPages = [] }, originalPages, batchSize, phase) {
  validateOptions({ files, request, content });
  const observations = [], batches = [];
  for (let offset = 0; offset < originalPages.length; offset += batchSize) {
    const originals = originalPages.slice(offset, offset + batchSize);
    const map = originals.map((original, index) => ({ local_page: index + 1, original_page: original }));
    const inputs = await pageInputs(originals.map((number) => structuredClone(files[number - 1])));
    if (!Array.isArray(inputs)) throw new TypeError('Identity pageInputs must return an input-content array.');
    const result = await request({
      instructions: [instructions, INDEPENDENT_INSTRUCTIONS, phase === 'focused' ? FOCUSED_INSTRUCTIONS : ''].filter(Boolean).join('\n\n'),
      content: [...structuredClone(content), {
        type: 'input_text',
        text: `IDENTITY IMAGE BATCH (${originals.length} pages; ${files.length} pages in the original input). LOCAL-TO-ORIGINAL PAGE MAP:\n${map.map(({ local_page, original_page }) => `local page ${local_page} -> original page ${original_page}`).join('\n')}\nReturn only local page numbers 1 through ${originals.length}. The following images are only these mapped pages.`,
      }, ...(phase === 'focused' ? [{ type: 'input_text', text: `PRIOR OCR TO VERIFY (not authoritative): ${JSON.stringify(priorPages.filter(page => originals.includes(page.page)).map(page => ({ original_page: page.page, ...Object.fromEntries(fields.map(key => [key, page[key]])) })))}. If prior text actually belongs to an answer, report that field origin as answer_content and explain; do not silently replace genuine identity/header contradictions with roster values.` }] : []), ...inputs],
      schema, name, task, retry, requestPolicy, timeoutMs, maxRetries,
    });
    const pages = validatePages(result, originals.length, { provider: true });
    observations.push(...pages.map((page) => ({ ...structuredClone(page), page: originals[page.page - 1] })));
    batches.push({ phase, original_pages: originals, local_to_original: map });
  }
  return { pages: observations.sort((a, b) => a.page - b.page), batches };
}

/** Read all files in batches of at most eight without deriving a PDF owner. */
export async function readIdentityPages(options) {
  const result = await readBatches(options, Array.from({ length: options.files.length }, (_, index) => index + 1), IDENTITY_BATCH_SIZE, 'initial');
  return { name_written: '', teacher_id: 0, pages: result.pages, audit: { batches: result.batches, focused_pages: [] } };
}

const normalizedName = (name) => name.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function preserveObservation(old, fresh) {
  if (old.name_confidence === 'certain' && old.name_written.trim()) {
    if (fresh.name_confidence === 'certain' && fresh.name_written.trim() && normalizedName(old.name_written) !== normalizedName(fresh.name_written)) {
      return { ...old, identity_conflict: true, reread_observation: fresh };
    }
    if (fresh.name_confidence !== 'certain' || !fresh.name_written.trim()) return { ...old, reread_observation: fresh };
  }
  return fresh;
}

/**
 * Reread only selected original indices, at most four images per call. The
 * caller may supply mergeObservation(old, fresh) for domain-specific guards.
 * Both arguments are copies; failures leave the complete previous LOOK intact.
 */
export async function rereadIdentityPages({ previous, pageNumbers, mergeObservation = preserveObservation, ...options }) {
  validateOptions({ ...options, content: options.content ?? [] });
  validatePages(previous, options.files.length);
  if (!Array.isArray(pageNumbers) || pageNumbers.some((number) => !Number.isSafeInteger(number) || number < 1 || number > options.files.length)) {
    throw invalid('focused page numbers must refer to original source pages');
  }
  const selected = [...new Set(pageNumbers)].sort((a, b) => a - b);
  const alreadyRead = new Set(previous.audit?.focused_pages ?? []);
  if (selected.some((number) => alreadyRead.has(number))) throw invalid('a focused page has already been reread');
  const result = await readBatches({ ...options, priorPages: previous.pages }, selected, IDENTITY_REREAD_BATCH_SIZE, 'focused');
  const replacements = new Map(result.pages.map((page) => [page.page, page]));
  const pages = previous.pages.map((old) => {
    const fresh = replacements.get(old.page);
    if (!fresh) return structuredClone(old);
    const merged = mergeObservation(structuredClone(old), structuredClone(fresh));
    if (!merged || merged.page !== old.page) throw invalid('a focused merge changed the original page index');
    return structuredClone(merged);
  });
  validatePages({ pages }, options.files.length);
  return { name_written: '', teacher_id: 0, pages,
    audit: { ...structuredClone(previous.audit ?? {}), batches: [...structuredClone(previous.audit?.batches ?? []), ...result.batches],
      focused_pages: [...alreadyRead, ...selected].sort((a, b) => a - b) } };
}
