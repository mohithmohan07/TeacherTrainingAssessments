import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CONTENT_ENGINE_DESCRIPTOR, CONTENT_ENGINE_SIGNATURE, CONTENT_INDEX_VERSION, CONTENT_SCREEN_SCHEMA, CONTENT_VERIFY_SCHEMA, CONTENT_SCREENING_MAX_CHARS, CONTENT_SCREENING_MAX_PAPERS,
  createContentBankIndex, extractCompletePdfText, compareContentFirstQuestionBank, contentReconciliationSchema,
} from '../server/content-bank.js';
import { createMatchingBudget } from '../server/matching-budget.js';
import { BANK_COMPARISON_BATCH_SIZE, BANK_COMPARISON_FINALIST_LIMIT } from '../server/bank-matching.js';

// Synthetic local sources and metered injected requests only. No provider,
// credentials, application DB, production bank, or deployment is used.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tta-content-bank-'));
after(() => fs.rm(temporary, { recursive: true, force: true }));
const extraction = (texts, overrides = {}) => ({ complete: true, page_count: texts.length, reason: null,
  pages: texts.map((text, i) => ({ page: i + 1, text, coverage: 'complete_text', reasons: [] })), ...overrides });
const synthetic = id => Buffer.from(`%PDF-1.7\nSynthetic complete question ${id}\n%%EOF`);
const original = Object.freeze({ type: 'input_image', image_url: 'data:image/png;base64,b3JpZ2luYWwtYW5zd2VyLWltYWdl', detail: 'high' });
const content = Object.freeze([{ type: 'input_text', text: 'Teacher profile is arbitrary and cannot restrict matching.' }, original]);
const schema = { type: 'object', properties: { pages: { type: 'array' }, papers: { type: 'array' } } };
const page = (id = 0, extras = {}) => ({ page: 1, paper_id: id, section: id ? 'B' : 'none', questions: id ? ['5A'] : [], has_answers: true, ...extras });
const matched = (id, alternatives = []) => ({ pages: [page(id)], papers: [{ paper_id: id, section: 'B', confidence: 'high', reason: 'Distinctive response to question 5A.', matched_question_labels: ['5A'], alternatives }] });
const supplied = request => JSON.parse(request.content[0].text.match(/\[[\d,]*\]/)[0]);
const screened = (ids, keep = [], hasAnswers = true) => ({ candidates: ids.map(paper_id => ({ paper_id, disposition: keep.includes(paper_id) ? 'plausible' : 'excluded', reason: keep.includes(paper_id) ? 'Response content is compatible.' : 'Concrete response content does not correspond to these questions.' })), pages: [{ page: 1, has_answers: hasAnswers }] });
function fixture(count, handler, extra = {}) {
  const requestPolicy = extra.requestPolicy ?? createMatchingBudget();
  const candidates = Array.from({ length: count }, (_, i) => ({ id: i + 1, title: `Misleading title ${i}`, subject: 'Not the actual subject', levels: 'Wrong level' }));
  const request = async options => {
    assert.equal(options.requestPolicy, requestPolicy);
    const attempt = requestPolicy.beginAttempt({ provider: 'openai', model: 'synthetic-model' });
    try { const result = await handler(options); attempt.finish({ status: 'success' }); return result; }
    catch (error) { attempt.finish({ status: error.code === 'OPENAI_REQUEST_TIMEOUT' ? 'timeout' : 'error', error }); throw error; }
  };
  return { requestPolicy, options: { candidates, request, requestPolicy, content, schema, name: 'original_answer_sort',
    paperBytes: async paper => synthetic(paper.id), screeningConcurrency: 1,
    indexCache: createContentBankIndex({ parserVersion: 'synthetic-v1', extractPdf: bytes => extraction([`${bytes.toString()}\nQuestion ends on the last page.`]) }), ...extra } };
}

// Minimal valid PDF generation exercises the installed production parser.
function pdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const { text = '', vector = false, image = false, annotation = false, stream: customStream } of pages) {
    const pageId = objects.length + 1, streamId = pageId + 1;
    const imageId = image ? pageId + 2 : null;
    const annotationId = annotation ? pageId + 2 + (image ? 1 : 0) : null;
    kids.push(`${pageId} 0 R`);
    const stream = customStream ?? `${text ? `BT /F1 12 Tf 12 120 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET\n` : ''}${vector ? '0 0 10 10 re S\n' : ''}${image ? 'q 10 0 0 10 0 0 cm /Img Do Q\n' : ''}`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Img ${imageId} 0 R >>` : ''} >> /Contents ${streamId} 0 R ${annotation ? `/Annots [${annotationId} 0 R]` : ''} >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    if (image) objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream');
    if (annotation) objects.push('<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (Important handwritten question) >>');
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('engine signature covers exact implementation source and imported runtime policy rather than version labels alone', async () => {
  const bytes = await fs.readFile(new URL('../server/content-bank.js', import.meta.url));
  assert.equal(CONTENT_ENGINE_DESCRIPTOR.module_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(CONTENT_ENGINE_DESCRIPTOR.full_pdf_batch_size, BANK_COMPARISON_BATCH_SIZE);
  assert.equal(CONTENT_ENGINE_DESCRIPTOR.full_pdf_finalist_limit, BANK_COMPARISON_FINALIST_LIMIT);
  assert.equal(CONTENT_ENGINE_SIGNATURE, createHash('sha256').update(JSON.stringify(CONTENT_ENGINE_DESCRIPTOR)).digest('hex'));
});

test('production PDF parser keeps complete text from every page including the last', async () => {
  const record = await createContentBankIndex().get(pdf([{ text: 'First page question with five marks.' }, { text: 'Last page rubric and distinctive response.' }]));
  assert.equal(record.parser_version, CONTENT_INDEX_VERSION);
  assert.equal(record.complete, true); assert.equal(record.indexed, true); assert.equal(record.page_count, 2);
  assert.match(record.pages[0].text, /First page/); assert.match(record.pages[1].text, /Last page rubric/);
  assert.ok(record.pages.every(page => page.coverage === 'complete_text'));
});

for (const [name, stream] of [
  ['superscript', 'BT /F1 12 Tf 12 120 Td (x) Tj 6 Ts /F1 8 Tf (2) Tj ET\n'],
  ['subscript', 'BT /F1 12 Tf 12 120 Td (H) Tj -4 Ts /F1 8 Tf (2) Tj ET\n'],
  ['raised positioned text', 'BT /F1 12 Tf 12 120 Td (x) Tj ET BT /F1 8 Tf 20 126 Td (2) Tj ET\n'],
  ['two columns on one line', 'BT /F1 12 Tf 12 120 Td (Left question) Tj ET BT /F1 12 Tf 260 120 Td (Right question) Tj ET\n'],
  ['offset rows in two columns', 'BT /F1 12 Tf 12 120 Td (Left question) Tj ET BT /F1 12 Tf 260 100 Td (Right question) Tj ET\n'],
  ['rotated text', 'BT /F1 12 Tf 0 1 -1 0 30 40 Tm (Rotated question) Tj ET\n'],
  ['significant kerning positions', 'BT /F1 12 Tf 12 120 Td [(Left) -2000 (Right)] TJ ET\n'],
  ['white text', '1 g BT /F1 12 Tf 12 120 Td (Invisible question) Tj ET\n'],
  ['white RGB text', '1 1 1 rg BT /F1 12 Tf 12 120 Td (Invisible question) Tj ET\n'],
  ['hidden rendering mode', 'BT /F1 12 Tf 3 Tr 12 120 Td (Invisible question) Tj ET\n'],
  ['out-of-page text', 'BT /F1 12 Tf 490 120 Td (Question running outside its page) Tj ET\n'],
]) test(`${name} uses the full PDF because flat glyph text cannot prove semantic or visual coverage`, async () => {
  const record = await createContentBankIndex().get(pdf([{ stream }]));
  assert.equal(record.indexed, false);
  assert.ok(record.pages.some(page => page.coverage === 'requires_full_pdf'));
});

test('simple horizontal multiline prose remains eligible for complete-text screening', async () => {
  const stream = '0 g BT /F1 12 Tf 12 120 Td (First question.) Tj 0 -18 Td (Second question.) Tj ET\n';
  const record = await createContentBankIndex().get(pdf([{ stream }]));
  assert.equal(record.indexed, true); assert.match(record.pages[0].text, /First question/); assert.match(record.pages[0].text, /Second question/);
});

for (const [name, pages, reason] of [
  ['scanned image', [{ image: true }], 'non_text_or_unclassified_content'],
  ['image accompanying valid OCR text', [{ text: 'Valid OCR question.', image: true }], 'non_text_or_unclassified_content'],
  ['vector diagram', [{ text: 'Question with an important diagram.', vector: true }], 'non_text_or_unclassified_content'],
  ['annotation', [{ text: 'Question with a handwritten annotation.', annotation: true }], 'annotations'],
  ['blank later page', [{ text: 'Readable first question.' }, {}], 'empty_text'],
]) test(`${name} cannot be excluded by text-only screening`, async () => {
  const record = await createContentBankIndex().get(pdf(pages));
  assert.equal(record.indexed, false); assert.equal(record.pages.length, pages.length);
  assert.ok(record.pages.some(page => page.coverage === 'requires_full_pdf' && page.reasons.includes(reason)));
});

test('malformed PDF, page limit, and text limit remain explicitly unindexed', async () => {
  const invalid = await createContentBankIndex().get(Buffer.from('not a PDF'));
  assert.equal(invalid.indexed, false); assert.equal(invalid.complete, false);
  assert.equal(invalid.reason, 'extraction_failed');
  for (const limits of [{ maxPages: 1 }, { maxTextChars: 3 }]) {
    const result = await extractCompletePdfText(pdf([{ text: 'First question.' }, { text: 'Last question.' }]), limits);
    assert.equal(result.complete, false);
    assert.match(result.reason, /limit/);
  }
});

test('byte-keyed in-flight cache coalesces parsing and returns immutable complete page records', async () => {
  let calls = 0;
  const index = createContentBankIndex({ parserVersion: 'fixture-v1', extractPdf: async bytes => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return extraction([bytes.toString(), 'Last page.']); } });
  const input = synthetic(1), originalBytes = Buffer.from(input);
  const first = index.get(input); input.fill(0);
  const [a, b] = await Promise.all([first, index.get(originalBytes)]);
  assert.equal(calls, 1); assert.equal(a, b); assert.equal(a.indexed, true);
  assert.throws(() => { a.pages[1].text = 'mutated'; }, TypeError);
  assert.equal(await index.get(originalBytes), a);
  const changed = await index.get(synthetic(2)); assert.equal(calls, 2); assert.notEqual(changed.source_sha256, a.source_sha256);
});

test('private disk cache is immutable and bound to bytes plus extractor policy version', async () => {
  const cacheDir = path.join(temporary, 'private-cache'); let calls = 0;
  const extractPdf = bytes => { calls++; return extraction([bytes.toString()]); };
  const options = { cacheDir, parserVersion: 'fixture-v1', extractPdf };
  const one = await createContentBankIndex(options).get(synthetic(1));
  const files = await fs.readdir(cacheDir); assert.equal(files.length, 1);
  const before = await fs.readFile(path.join(cacheDir, files[0]));
  assert.equal((await fs.stat(cacheDir)).mode & 0o077, 0);
  assert.equal((await fs.stat(path.join(cacheDir, files[0]))).mode & 0o077, 0);
  const two = await createContentBankIndex(options).get(synthetic(1));
  assert.deepEqual(two, one); assert.equal(calls, 1);
  await createContentBankIndex({ ...options, parserVersion: 'fixture-v2' }).get(synthetic(1));
  await createContentBankIndex(options).get(synthetic(2));
  assert.equal(calls, 3); assert.equal((await fs.readdir(cacheDir)).length, 3);
  assert.deepEqual(await fs.readFile(path.join(cacheDir, files[0])), before);
});

test('corrupt/insecure cache and extractor failure never silently remove a master', async () => {
  const cacheDir = path.join(temporary, 'broken-cache'); let calls = 0;
  const options = { cacheDir, parserVersion: 'fixture-v1', extractPdf: () => { calls++; return extraction(['Complete question.']); } };
  await createContentBankIndex(options).get(synthetic(1));
  const filename = path.join(cacheDir, (await fs.readdir(cacheDir))[0]);
  await fs.writeFile(filename, '{broken json');
  assert.equal((await createContentBankIndex(options).get(synthetic(1))).indexed, true); assert.equal(calls, 2);
  const failed = await createContentBankIndex({ extractPdf() { throw new Error('private parser internals'); } }).get(synthetic(3));
  assert.equal(failed.indexed, false); assert.equal(failed.reason, 'extraction_failed');
  assert.doesNotMatch(JSON.stringify(failed), /private parser internals/);
  const incomplete = await createContentBankIndex({ extractPdf: () => extraction(['First page only.'], { page_count: 2 }) }).get(synthetic(4));
  assert.equal(incomplete.indexed, false); assert.equal(incomplete.complete, false);
});

test('120 all-bank masters use bounded complete-text batches and verify the late contender with its actual PDF', async () => {
  const calls = [], before = JSON.stringify(content);
  const { options, requestPolicy } = fixture(120, async request => {
    const ids = supplied(request); calls.push({ ids, request });
    assert.ok(request.content.includes(original));
    assert.deepEqual(request.content.slice(-content.length), content);
    assert.match(request.instructions, /NEVER eligibility restrictions/);
    assert.doesNotMatch(JSON.stringify(request.content.slice(0, -content.length)), /Misleading title|Not the actual subject|Wrong level/);
    if (request.schema === CONTENT_SCREEN_SCHEMA) {
      assert.ok(ids.length <= CONTENT_SCREENING_MAX_PAPERS);
      const texts = request.content.filter(item => item.type === 'input_text' && item.text.startsWith('QUESTION PAPER ID'));
      assert.ok(texts.reduce((sum, item) => sum + item.text.length, 0) <= CONTENT_SCREENING_MAX_CHARS);
      assert.equal(request.content.filter(item => item.type === 'input_file').length, 0);
      for (const text of texts) assert.match(text.text, /Question ends on the last page/);
      return screened(ids, [120]);
    }
    assert.deepEqual(ids, [120]); assert.equal(request.schema, schema); assert.equal(request.name, 'original_answer_sort');
    const full = request.content.find(item => item.type === 'input_file');
    assert.deepEqual(Buffer.from(full.file_data.split(',')[1], 'base64'), synthetic(120));
    return matched(120);
  });
  const result = await compareContentFirstQuestionBank(options);
  assert.equal(calls.length, 6); assert.equal(requestPolicy.snapshot().attempts, 6);
  assert.equal(requestPolicy.snapshot().limits.maxProviderAttempts, 40); assert.equal(requestPolicy.snapshot().limits.packetTimeoutMs, 900000);
  assert.equal(result.pages[0].paper_id, 120); assert.equal(result.considered_candidate_ids.length, 120);
  assert.equal(result.bank_comparison.complete, true); assert.equal(result.bank_comparison.coverage_mode, 'content_first');
  assert.equal(result.bank_comparison.text_screened_ids.length, 120); assert.deepEqual(result.bank_comparison.full_pdf_screened_ids, []);
  assert.deepEqual(result.bank_comparison.full_pdf_verified_ids, [120]); assert.equal(JSON.stringify(content), before);
  assert.equal(result.bank_comparison.parser_version, 'synthetic-v1');
  assert.equal(result.bank_comparison.engine_signature, CONTENT_ENGINE_SIGNATURE);
  assert.equal(result.bank_comparison.source_manifest.length, 120);
  assert.deepEqual(result.bank_comparison.source_manifest.map(item => item.paper_id), options.candidates.map(item => item.id));
  assert.ok(result.bank_comparison.source_manifest.every(item => item.screening_mode === 'complete_text' && item.source_sha256.length === 64 && item.text_sha256.length === 64 && item.pages.length === 1));
});

test('unindexed and oversized masters get full-PDF screening with all original answer images', async () => {
  const calls = [];
  const indexCache = createContentBankIndex({ parserVersion: 'mixed-v1', extractPdf: bytes => {
    const id = Number(bytes.toString().match(/question (\d+)/)[1]);
    if (id === 2) return extraction(['OCR text alone is incomplete.'], { pages: [{ page: 1, text: 'OCR text alone is incomplete.', coverage: 'requires_full_pdf', reasons: ['image'] }] });
    if (id === 3) return extraction(['Huge question '.repeat(CONTENT_SCREENING_MAX_CHARS)]);
    return extraction([`Complete question ${id}.`]);
  } });
  const { options } = fixture(3, async request => {
    const ids = supplied(request); calls.push(ids); assert.ok(request.content.includes(original));
    const fullIds = request.content.filter(item => item.type === 'input_file').map(item => Number(item.filename.match(/\d+/)[0]));
    if (request.schema === CONTENT_SCREEN_SCHEMA) { if (ids.includes(2)) assert.deepEqual(fullIds, [2, 3]); else assert.deepEqual(fullIds, []); return screened(ids, [2]); }
    assert.deepEqual(fullIds, [2]); return matched(2);
  }, { indexCache });
  const result = await compareContentFirstQuestionBank(options);
  assert.deepEqual(calls, [[1], [2, 3], [2]]); assert.deepEqual(result.bank_comparison.text_screened_ids, [1]);
  assert.deepEqual(result.bank_comparison.full_pdf_screened_ids, [2, 3]);
});

test('full PDF bytes are reloaded only for bounded active batches/final and remain byte-verified', async () => {
  const reads = new Map(); let active = 0, peak = 0, calls = 0;
  const indexCache = createContentBankIndex({ extractPdf: bytes => extraction([bytes.toString()], {
    pages: [{ page: 1, text: bytes.toString(), coverage: 'requires_full_pdf', reasons: ['unclassified_layout'] }],
  }) });
  const { options } = fixture(25, async request => {
    calls++;
    if (request.schema === CONTENT_SCREEN_SCHEMA) {
      assert.ok(supplied(request).length <= 8);
      for (const id of supplied(request)) assert.equal(reads.get(id), 2, 'indexed once, freshly loaded for active screening');
      return screened(supplied(request), [25]);
    }
    assert.deepEqual(supplied(request), [25]); assert.equal(reads.get(25), 3, 'final verification reloads and checks the PDF again');
    return matched(25);
  }, { indexCache, screeningConcurrency: 2, paperBytes: async paper => {
    reads.set(paper.id, (reads.get(paper.id) ?? 0) + 1);
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return synthetic(paper.id);
  } });
  const result = await compareContentFirstQuestionBank(options);
  assert.equal(result.pages[0].paper_id, 25); assert.equal(calls, 5); assert.ok(peak <= 16);
  assert.equal(reads.size, 25); assert.ok([...reads].every(([id, count]) => count === (id === 25 ? 3 : 2)));
});

for (const unindexed of [false, true]) test(`changed PDF reload fails before ${unindexed ? 'full screening' : 'final verification'} reaches a provider`, async () => {
  let reads = 0, calls = 0;
  const indexCache = createContentBankIndex({ extractPdf: bytes => extraction([bytes.toString()], unindexed ? {
    pages: [{ page: 1, text: bytes.toString(), coverage: 'requires_full_pdf', reasons: ['unclassified_layout'] }],
  } : {}) });
  const { options } = fixture(1, async request => { calls++; return screened(supplied(request), [1]); }, {
    indexCache, paperBytes: async () => synthetic(++reads === 1 ? 1 : 999),
  });
  await assert.rejects(compareContentFirstQuestionBank(options), error => {
    assert.equal(error.code, 'QUESTION_BANK_COMPARISON_FAILED'); assert.equal(error.cause.code, 'QUESTION_BANK_SOURCES_CHANGED'); return true;
  });
  assert.equal(calls, unindexed ? 0 : 1);
});

test('an extraction record from a different engine implementation cannot be reused', async () => {
  const record = await createContentBankIndex({ extractPdf: bytes => extraction([bytes.toString()]) }).get(synthetic(1));
  const { options } = fixture(1, () => assert.fail('Different extraction policy must not reach a provider.'), {
    indexCache: { get: async () => ({ ...record, engine_signature: '0'.repeat(64) }) },
  });
  await assert.rejects(compareContentFirstQuestionBank(options), { code: 'QUESTION_BANK_STALE_INDEX' });
});

test('every plausible and uncertain contender survives; metadata is never a filter', async () => {
  const { options } = fixture(30, async request => {
    const ids = supplied(request);
    if (request.schema === CONTENT_SCREEN_SCHEMA) { const result = screened(ids, [2, 29]); const uncertain = result.candidates.find(item => item.paper_id === 20); if (uncertain) uncertain.disposition = 'uncertain'; return result; }
    assert.deepEqual(ids, [2, 20, 29]); return matched(29, [2, 20]);
  });
  const result = await compareContentFirstQuestionBank(options);
  assert.deepEqual(result.bank_comparison.finalist_ids, [2, 20, 29]); assert.deepEqual(result.papers[0].alternatives, [2, 20]);
});

test('all equal byte/text versions remain separate ambiguous IDs despite a provider declaring a winner', async () => {
  const indexCache = createContentBankIndex({ parserVersion: 'equal-text-v1', extractPdf: bytes => {
    const text = bytes.toString().includes('3') ? 'Same  question with 5 marks.\nRubric is preserved.' : 'Same question with 5 marks.\nRubric is preserved.';
    return extraction([text]);
  } });
  const { options } = fixture(3, async request => {
    const ids = supplied(request);
    if (request.schema === CONTENT_SCREEN_SCHEMA) return screened(ids, [1]);
    assert.deepEqual(ids, [1, 2, 3]); return matched(1);
  }, { indexCache, paperBytes: async paper => synthetic(paper.id === 2 ? 1 : paper.id) });
  const result = await compareContentFirstQuestionBank(options);
  assert.deepEqual(result.bank_comparison.finalist_ids, [1, 2, 3]); assert.equal(result.pages[0].paper_id, 1);
  assert.deepEqual(result.pages[0].proposed_candidate_ids, [1, 2, 3]); assert.deepEqual(result.pages[0].questions, ['5A']);
  assert.equal(result.pages[0].section, 'B'); assert.equal(result.pages[0].header_evidence.status, 'unresolved');
  assert.deepEqual(result.papers[0].alternatives, [2, 3]); assert.equal(result.papers[0].confidence, 'low');
  assert.deepEqual(result.bank_comparison.ambiguous_equivalent_ids, [1, 2, 3]);
});

test('equal-content fingerprints preserve page boundaries, marks, punctuation, and rubric differences', async () => {
  const index = createContentBankIndex({ extractPdf: bytes => JSON.parse(bytes.toString()) });
  const values = [extraction(['Question 5 marks.\nRubric: evidence.']), extraction(['Question 6 marks.\nRubric: evidence.']),
    extraction(['Question 5 marks.', 'Rubric: evidence.']), extraction(['Question 5 marks.\nRubric: explanation.']), extraction(['Question 5 marks?\nRubric: evidence.'])];
  const records = await Promise.all(values.map(value => index.get(Buffer.from(JSON.stringify(value)))));
  assert.equal(new Set(records.map(record => record.text_sha256)).size, values.length);
});

for (const malformed of ['missing', 'duplicate', 'absent', 'unreasoned', 'pages']) test(`screening ${malformed} decisions fail closed before final comparison`, async () => {
  let calls = 0;
  const { options } = fixture(2, async request => {
    calls++; const result = screened(supplied(request), [1]);
    if (malformed === 'missing') result.candidates.pop();
    if (malformed === 'duplicate') result.candidates[1].paper_id = 1;
    if (malformed === 'absent') result.candidates[1].paper_id = 999;
    if (malformed === 'unreasoned') result.candidates[0].reason = ' ';
    if (malformed === 'pages') result.pages = [];
    return result;
  });
  await assert.rejects(compareContentFirstQuestionBank(options), error => error.code === 'QUESTION_BANK_COMPARISON_FAILED' && error.cause.code === 'QUESTION_BANK_INVALID_EVIDENCE');
  assert.equal(calls, 2); // One bounded schema repair, then fail closed.
});

test('final invented IDs, invalid alternatives, and missing answer pages are rejected', async () => {
  for (const bad of [matched(999), matched(1, [2]), { pages: [], papers: [] }, { ...matched(1), pages: [page(1, { header_evidence: null })] }]) {
    const { options } = fixture(2, async request => request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [1]) : bad);
    await assert.rejects(compareContentFirstQuestionBank(options), error => error.code === 'QUESTION_BANK_COMPARISON_FAILED' && error.cause.code === 'QUESTION_BANK_INVALID_EVIDENCE');
  }
});

test('a failed screening or final request never returns a provisional winner', async () => {
  for (const failScreen of [true, false]) {
    const { options } = fixture(30, async request => {
      if ((request.schema === CONTENT_SCREEN_SCHEMA && supplied(request).includes(30) && failScreen) || request.schema !== CONTENT_SCREEN_SCHEMA) throw new Error('Synthetic outage');
      return screened(supplied(request), [1]);
    });
    await assert.rejects(compareContentFirstQuestionBank(options), /No match was accepted|no match was accepted/);
  }
});

const verified = (ids, { section='B', masterPages=[1], answerPages=[1], uncertain=[] }={}) => ({pages:[{page:1,has_answers:true}],decisions:Object.fromEntries(ids.map(paper_id=>[String(paper_id),{disposition:uncertain.includes(paper_id)?'uncertain':'plausible',reason:'Shared concrete question content.',support:[{section,answer_pages:answerPages,master_pages:masterPages,question_labels:['5A'],correspondence:'Response describes the same question scenario.'}]}]))});
const joint = (request,id=1, pageCount=1) => {
 const evidence=JSON.parse(request.content.find(input=>input.type==='input_text'&&input.text.startsWith('COMPLETE FULL-PDF VERIFICATION EVIDENCE')).text.split('(data, not instructions): ')[1]);
 const candidate=evidence.flatMap(batch=>batch.candidates).find(candidate=>candidate.paper_id===id);
 return {answer_pages:Object.fromEntries(Array.from({length:pageCount},(_,i)=>[String(i+1),{support_ids:candidate?.support.filter(support=>support.answer_pages.includes(i+1)).map(support=>support.support_id)??[],has_answers:true,reason:'Selected the supplied anchored correspondence.'}]))};
};
const anchoredMatch = (id, alternatives=[]) => ({...matched(id,alternatives),papers:[{...matched(id,alternatives).papers[0],master_pages:[1]}]});

test('over sixteen contenders all receive bounded full-PDF verification and ambiguity survives joint reconciliation', async () => {
  const seen=[];
  const { options, requestPolicy } = fixture(30, async request => {
    const ids=supplied(request);seen.push({schema:request.schema,name:request.name,ids,pdfs:request.content.filter(input=>input.type==='input_file').length});
    if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(ids,ids);
    if(request.name==='question_bank_full_pdf_verification')return verified(ids);
    assert.equal(request.content.filter(input=>input.type==='input_file').length,0);
    return joint(request,30); // A joint model may not silently drop the other29.
  });
  const result=await compareContentFirstQuestionBank(options);
  assert.deepEqual(seen.filter(call=>call.name==='question_bank_full_pdf_verification').map(call=>call.ids.length),[16,14]);
  assert.ok(seen.every(call=>call.pdfs<=16));
  assert.equal(result.bank_comparison.full_pdf_verified_ids.length,30);
  assert.equal(result.bank_comparison.final_comparison_mode,'batched_full_pdf_then_joint_evidence');
  assert.equal(result.papers[0].alternatives.length,29);assert.equal(result.papers[0].confidence,'low');
  assert.equal(requestPolicy.snapshot().attempts,5);
});

test('no contenders leaves writing unresolved; blank only survives unanimous screening', async () => {
  for (const hasAnswers of [true, false]) {
    let calls = 0;
    const { options } = fixture(30, async request => { calls++; return screened(supplied(request), [], calls === 1 && hasAnswers); });
    const result = await compareContentFirstQuestionBank(options);
    assert.equal(result.pages[0].has_answers, hasAnswers); assert.equal(result.pages[0].paper_id, 0);
    assert.deepEqual(result.papers, []); assert.equal(result.bank_comparison.final_compared, false); assert.equal(calls, 2);
  }
});

test('final blank cannot erase writing observed during any screen', async () => {
  const { options } = fixture(2, async request => request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [1]) : { pages: [page(0, { has_answers: false })], papers: [] });
  const result = await compareContentFirstQuestionBank(options);
  assert.equal(result.pages[0].has_answers, true); assert.equal(result.pages[0].paper_id, 0); assert.deepEqual(result.blank_conflict_pages, [1]);
});

test('matching never reuses model responses across packets with the shared extraction cache', async () => {
  let extractions = 0, calls = 0;
  const indexCache = createContentBankIndex({ extractPdf: bytes => { extractions++; return extraction([bytes.toString()]); } });
  for (let packet = 0; packet < 2; packet++) {
    const { options } = fixture(2, async request => { calls++; return request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [1]) : matched(1); }, { indexCache });
    await compareContentFirstQuestionBank(options);
  }
  assert.equal(extractions, 2); assert.equal(calls, 4);
});

test('same packet budget covers content screening and full verification with unchanged limits', async () => {
  const requestPolicy = createMatchingBudget({ maxProviderAttempts: 1 });
  const { options } = fixture(2, async request => screened(supplied(request), [1]), { requestPolicy });
  await assert.rejects(compareContentFirstQuestionBank(options), error => error.cause?.code === 'MATCHING_BUDGET_EXHAUSTED');
  assert.equal(requestPolicy.snapshot().attempts, 1);
});

test('packet deadline includes extraction and prevents later provider work', async () => {
  let time = 0, calls = 0;
  const requestPolicy = createMatchingBudget({ clock: () => time, packetTimeoutMs: 100 });
  const indexCache = createContentBankIndex({ extractPdf: bytes => { time = 101; return extraction([bytes.toString()]); } });
  const { options } = fixture(2, async () => { calls++; assert.fail('Expired packet must not contact a provider.'); }, { requestPolicy, indexCache });
  await assert.rejects(compareContentFirstQuestionBank(options), { code: 'MATCHING_BUDGET_EXHAUSTED', reason: 'packet_deadline' });
  assert.equal(calls, 0);
});

test('full immutable-source assertions scale with request stages, while indexing keeps cheap budget checks', async () => {
  let sourceAssertions = 0, budgetChecks = 0, calls = 0;
  const budget = createMatchingBudget();
  const requestPolicy = { ...budget, remainingMs() { budgetChecks++; return budget.remainingMs(); } };
  const { options } = fixture(120, async request => {
    calls++;
    return request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [120]) : matched(120);
  }, { requestPolicy, assertSourcesUnchanged() { sourceAssertions++; } });
  await compareContentFirstQuestionBank(options);
  assert.equal(calls, 6);
  assert.equal(sourceAssertions, calls * 2 + 4, 'entry, after indexing, after screening, return, and before/after every call');
  assert.ok(sourceAssertions < options.candidates.length);
  assert.ok(budgetChecks >= options.candidates.length * 3, 'each source read/index step still checks the existing deadline');
});

test('timeout recovery bisects only once, preserving all originals and every candidate', async () => {
  const calls = [];
  const { options } = fixture(25, async request => {
    const ids = supplied(request); calls.push(ids); assert.ok(request.content.includes(original));
    if (calls.length === 1) throw Object.assign(new Error('Synthetic timeout'), { code: 'OPENAI_REQUEST_TIMEOUT' });
    return request.schema === CONTENT_SCREEN_SCHEMA ? screened(ids, [24, 25]) : matched(25, [24]);
  });
  const result = await compareContentFirstQuestionBank(options);
  assert.deepEqual(calls.map(ids => ids.length), [24, 12, 12, 1, 2]); assert.equal(result.bank_comparison.recovery_split_count, 1);
  assert.deepEqual(result.bank_comparison.finalist_ids, [24, 25]); assert.equal(result.considered_candidate_ids.length, 25);
});

test('a timed-out recovery child aborts without recursive subdivision', async () => {
  let calls = 0;
  const { options } = fixture(25, async () => { calls++; throw Object.assign(new Error('Synthetic timeout'), { code: 'OPENAI_REQUEST_TIMEOUT' }); });
  await assert.rejects(compareContentFirstQuestionBank(options), /incomplete/); assert.equal(calls, 2);
});

test('parallel work caps at two and drains cancelled in-flight screening before rejection', async () => {
  let active = 0, peak = 0, calls = 0, secondDone = false, announceSecond;
  const started = new Promise(resolve => { announceSecond = resolve; });
  const { options, requestPolicy } = fixture(60, async request => {
    active++; peak = Math.max(peak, active); const call = ++calls;
    try {
      if (call === 1) { await started; throw new Error('Synthetic fatal screening failure'); }
      announceSecond(); await new Promise(resolve => setTimeout(resolve, 15)); secondDone = true;
      return screened(supplied(request));
    } finally { active--; }
  }, { screeningConcurrency: 10 });
  await assert.rejects(compareContentFirstQuestionBank(options), /Synthetic fatal/);
  assert.equal(peak, 2); assert.equal(calls, 2); assert.equal(active, 0); assert.equal(secondDone, true);
  assert.equal(requestPolicy.snapshot().activeAttempts, 0); assert.equal(requestPolicy.snapshot().cancelled, true);
});

test('successful parallel screens all finish before the joint final full-PDF call', async () => {
  let active = 0, peak = 0, screenedCount = 0;
  const { options } = fixture(60, async request => {
    if (request.schema !== CONTENT_SCREEN_SCHEMA) { assert.equal(active, 0); assert.equal(screenedCount, 60); return matched(60); }
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    screenedCount += supplied(request).length; return screened(supplied(request), [60]);
  }, { screeningConcurrency: 2 });
  assert.equal((await compareContentFirstQuestionBank(options)).pages[0].paper_id, 60); assert.equal(peak, 2);
});

test('source bytes, answer content, and stale indexes fail closed rather than relying on cached decisions', async () => {
  let checks = 0;
  const { options } = fixture(2, async request => screened(supplied(request), [1]), { assertSourcesUnchanged() { if (++checks === 4) throw new Error('Synthetic sources changed'); } });
  await assert.rejects(compareContentFirstQuestionBank(options), /sources changed/);
  const valid = await createContentBankIndex({ extractPdf: () => extraction(['Other source.']) }).get(synthetic(99));
  const stale = fixture(1, async () => assert.fail('Stale source must not reach provider.'), { indexCache: { get: async () => valid } });
  await assert.rejects(compareContentFirstQuestionBank(stale.options), { code: 'QUESTION_BANK_STALE_INDEX' });
  const answer = { ...original }, mutable = [{ ...content[0] }, answer];
  const changed = fixture(1, async request => { answer.image_url = 'data:image/png;base64,Y2hhbmdlZA=='; return screened(supplied(request), [1]); }, { content: mutable });
  await assert.rejects(compareContentFirstQuestionBank(changed.options), /inputs changed/);
});

test('missing originals, duplicate bank IDs, and missing shared policy fail before requests', async () => {
  const { options } = fixture(2, () => assert.fail('Invalid arguments must not reach provider.'));
  await assert.rejects(compareContentFirstQuestionBank({ ...options, content: [{ type: 'input_text', text: 'A transcription is not the original.' }] }), /original answer images/);
  await assert.rejects(compareContentFirstQuestionBank({ ...options, candidates: [{ id: 1 }, { id: 1 }] }), /unique positive/);
  await assert.rejects(compareContentFirstQuestionBank({ ...options, requestPolicy: null }), /shared cancellable/);
});

test('DOCX/ZIP and arbitrary non-PDF bytes are rejected before indexing or provider calls', async () => {
  for (const bytes of [Buffer.from('PK\x03\x04word/document.xml'), Buffer.from('ordinary text'), Buffer.from('non-whitespace preamble %PDF-1.7\n'), Buffer.from(`${' '.repeat(1024)}%PDF-1.7\n`)]) {
    let indexed = 0;
    const { options, requestPolicy } = fixture(1, () => assert.fail('Non-PDF source must never reach a provider.'), {
      paperBytes: async () => bytes, indexCache: { get() { indexed++; assert.fail('Non-PDF source must fail before indexing.'); } },
    });
    await assert.rejects(compareContentFirstQuestionBank(options), { code: 'QUESTION_BANK_UNSUPPORTED_SOURCE' });
    assert.equal(requestPolicy.snapshot().attempts, 0); assert.equal(indexed, 0);
  }
});

test('valid PDF header with a leading BOM and whitespace is accepted without rewriting bytes', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(' \r\n\t'), synthetic(1)]);
  const { options } = fixture(1, async request => {
    if (request.schema === CONTENT_SCREEN_SCHEMA) return screened(supplied(request), [1]);
    assert.deepEqual(Buffer.from(request.content.find(item => item.type === 'input_file').file_data.split(',')[1], 'base64'), bytes);
    return matched(1);
  }, { paperBytes: async () => bytes });
  assert.equal((await compareContentFirstQuestionBank(options)).pages[0].paper_id, 1);
});

const checkpointContext = { provider: 'openai', model: 'synthetic-model', settings: { temperature: 0 }, source_key: 'source-ids-and-bytes' };
test('completed screening batches resume after failure but final full PDFs are always freshly compared', async () => {
  let saved, calls = 0;
  const first = fixture(25, async request => {
    calls++;
    if (calls === 2) throw new Error('Synthetic provider failure');
    return screened(supplied(request), [1]);
  }, { checkpointContext, onScreeningCheckpoint: value => { saved = structuredClone(value); } });
  await assert.rejects(compareContentFirstQuestionBank(first.options), /provider failure/);
  assert.equal(saved.batches.length, 1);
  const seen = [];
  const second = fixture(25, async request => {
    seen.push([request.schema === CONTENT_SCREEN_SCHEMA ? 'screen' : 'final', supplied(request)]);
    if (request.schema === CONTENT_SCREEN_SCHEMA) return screened(supplied(request));
    assert.ok(request.content.some(input => input.type === 'input_file'));
    return matched(1);
  }, { checkpointContext, screeningCheckpoint: saved });
  const result = await compareContentFirstQuestionBank(second.options);
  assert.deepEqual(seen, [['screen', [25]], ['final', [1]]]);
  assert.equal(result.bank_comparison.reused_screening_ids.length, 24);
  assert.deepEqual(result.bank_comparison.fresh_screening_ids, [25]);
});

test('partial timeout split is never saved as a completed reusable batch', async () => {
  let calls = 0, saved;
  const first = fixture(24, async request => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'OPENAI_REQUEST_TIMEOUT' });
    if (calls === 3) throw new Error('second split failed');
    return screened(supplied(request), [1]);
  }, { checkpointContext, onScreeningCheckpoint: value => { saved = value; } });
  await assert.rejects(compareContentFirstQuestionBank(first.options), /second split failed/);
  assert.equal(saved, undefined);
});

test('checkpoint keys invalidate changed provider, model, settings, source, prompt, schema and bank metadata', async () => {
  let saved;
  const first = fixture(1, async request => request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [1]) : matched(1),
    { checkpointContext, onScreeningCheckpoint: value => { saved = structuredClone(value); } });
  await compareContentFirstQuestionBank(first.options);
  for (const overrides of [
    { checkpointContext: { ...checkpointContext, provider: 'other' } },
    { checkpointContext: { ...checkpointContext, model: 'other' } },
    { checkpointContext: { ...checkpointContext, settings: { temperature: 1 } } },
    { checkpointContext: { ...checkpointContext, source_key: 'changed' } },
    { instructions: 'changed prompt' }, { schema: { ...schema, description: 'changed' } },
    { paperBytes: async () => synthetic(999) },
    { candidates: [{ id: 1, title: 'different metadata' }] },
    { content: [{ ...original, image_url: 'data:image/png;base64,bmV3' }] },
    { checkpointContext: undefined },
  ]) {
    let screens = 0;
    const next = fixture(1, async request => {
      if (request.schema === CONTENT_SCREEN_SCHEMA) { screens++; return screened(supplied(request), [1]); }
      return matched(1);
    }, { checkpointContext, screeningCheckpoint: saved, ...overrides });
    await compareContentFirstQuestionBank(next.options);
    assert.equal(screens, 1);
  }
});

test('corrupt checkpoint evidence is re-screened rather than accepted', async () => {
  let saved;
  const first = fixture(1, async request => request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [1]) : matched(1),
    { checkpointContext, onScreeningCheckpoint: value => { saved = structuredClone(value); } });
  await compareContentFirstQuestionBank(first.options);
  for (const corrupt of [value => { value.batches[0].leaves[0].result.candidates = []; },
    value => { value.batches[0].leaves[0].result.candidates[0].disposition = 'excluded'; },
    value => { value.batches[0].leaves[0].ids = [2]; }]) {
    const checkpoint = structuredClone(saved); corrupt(checkpoint); let screens = 0;
    const next = fixture(1, async request => {
      if (request.schema === CONTENT_SCREEN_SCHEMA) { screens++; return screened(supplied(request), [1]); }
      return matched(1);
    }, { checkpointContext, screeningCheckpoint: checkpoint });
    await compareContentFirstQuestionBank(next.options); assert.equal(screens, 1);
  }
});

test('both validated timeout halves resume after a failed final, with a fresh final request', async () => {
  let saved, calls = 0;
  const first = fixture(24, async request => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'OPENAI_REQUEST_TIMEOUT' });
    if (request.schema !== CONTENT_SCREEN_SCHEMA) throw new Error('final failed');
    return screened(supplied(request), [1]);
  }, { checkpointContext, onScreeningCheckpoint: value => { saved = structuredClone(value); } });
  await assert.rejects(compareContentFirstQuestionBank(first.options), /final failed/);
  assert.equal(saved.batches.length, 1); assert.equal(saved.batches[0].leaves.length, 2);
  let finals = 0;
  const next = fixture(24, async request => {
    assert.notEqual(request.schema, CONTENT_SCREEN_SCHEMA);
    finals++; return matched(1);
  }, { checkpointContext, screeningCheckpoint: saved });
  const result = await compareContentFirstQuestionBank(next.options);
  assert.equal(finals, 1); assert.equal(result.bank_comparison.reused_screening_ids.length, 24);
  assert.equal(result.bank_comparison.fresh_screening_ids.length, 0);
  assert.equal(result.bank_comparison.recovery_split_count, 1);
});

test('changed extraction parser invalidates checkpoint screening', async () => {
  let saved;
  const first = fixture(1, async request => request.schema === CONTENT_SCREEN_SCHEMA ? screened(supplied(request), [1]) : matched(1),
    { checkpointContext, onScreeningCheckpoint: value => { saved = structuredClone(value); } });
  await compareContentFirstQuestionBank(first.options);
  let screens = 0;
  const next = fixture(1, async request => {
    if (request.schema === CONTENT_SCREEN_SCHEMA) { screens++; return screened(supplied(request), [1]); }
    return matched(1);
  }, { checkpointContext, screeningCheckpoint: saved,
    indexCache: createContentBankIndex({ parserVersion: 'synthetic-v2', extractPdf: bytes => extraction([`${bytes.toString()}\nQuestion ends on the last page.`]) }) });
  await compareContentFirstQuestionBank(next.options); assert.equal(screens, 1);
});
test('combined-source matches require valid physical master page anchors when schema requests them',async()=>{
 const anchoredSchema={type:'object',properties:{papers:{items:{required:['master_pages']}}}};
 for (const anchors of [undefined,[],[0],[3],[1,1]]) {
   const {options}=fixture(1,async request=>request.schema===CONTENT_SCREEN_SCHEMA ? screened(supplied(request),[1]) : {...matched(1),papers:[{...matched(1).papers[0],master_pages:anchors}]},
   {schema:anchoredSchema,indexCache:createContentBankIndex({extractPdf:()=>extraction(['Contained paper one.','Contained paper two.'])})});
   await assert.rejects(compareContentFirstQuestionBank(options),/physical pages/);
 }
 const {options}=fixture(1,async request=>request.schema===CONTENT_SCREEN_SCHEMA ? screened(supplied(request),[1]) : {...matched(1),papers:[{...matched(1).papers[0],master_pages:[2]}]},
 {schema:anchoredSchema,indexCache:createContentBankIndex({extractPdf:()=>extraction(['Contained paper one.','Contained paper two.'])})});
 assert.deepEqual((await compareContentFirstQuestionBank(options)).papers[0].master_pages,[2]);
});
test('matched answer pages cannot bypass physical anchors by omitting their paper finding',async()=>{
 const anchoredSchema={type:'object',properties:{papers:{items:{required:['master_pages']}}}};
 for (const papers of [[],[{...matched(1).papers[0],section:'A',master_pages:[1]}]]) {
   const {options}=fixture(1,async request=>request.schema===CONTENT_SCREEN_SCHEMA ? screened(supplied(request),[1]) : {...matched(1),papers},{schema:anchoredSchema});
   await assert.rejects(compareContentFirstQuestionBank(options),/anchored paper finding/);
 }
});

test('one schema repair reinspects identical complete sources and consumes the shared request budget',async()=>{
 let screens=0,firstInputs;
 const {options,requestPolicy}=fixture(2,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA){screens++;if(screens===1){firstInputs=JSON.stringify(request.content);return {...screened(supplied(request),[1]),pages:[]};}
     assert.equal(JSON.stringify(request.content),firstInputs);assert.match(request.instructions,/SCHEMA REPAIR/);return screened(supplied(request),[1]);}
   return matched(1);
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(screens,2);assert.equal(requestPolicy.snapshot().attempts,3);assert.equal(result.bank_comparison.schema_repair_count,1);
});
test('schema repair cannot bypass the global provider-attempt limit',async()=>{
 let calls=0;const requestPolicy=createMatchingBudget({maxProviderAttempts:1});
 const {options}=fixture(2,async request=>{calls++;return {...screened(supplied(request),[1]),pages:[]};},{requestPolicy});
 await assert.rejects(compareContentFirstQuestionBank(options),/request|budget|permitted|attempt/i);assert.equal(calls,1);assert.equal(requestPolicy.snapshot().attempts,1);
});
for(const mode of ['missing_candidate','missing_page','timeout','cancelled'])test(`incomplete multi-batch verification (${mode}) cannot reach joint reconciliation`,async()=>{
 let batches=0,joint=0;const {options,requestPolicy}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
   if(request.name==='question_bank_full_pdf_verification'){batches++;const result=verified(supplied(request));if(batches>=2){
     if(mode==='missing_candidate')delete result.decisions[String(supplied(request).at(-1))];if(mode==='missing_page')result.pages=[];
     if(mode==='timeout')throw Object.assign(new Error('bounded timeout'),{code:'OPENAI_REQUEST_TIMEOUT'});
     if(mode==='cancelled')requestPolicy.cancel();
   }return result;}joint++;return joint(request,1);
 });
 await assert.rejects(compareContentFirstQuestionBank(options),/verification batch 2 failed/);assert.equal(joint,0);assert.equal(batches,['missing_candidate','missing_page'].includes(mode)?3:2);assert.equal(requestPolicy.snapshot().activeAttempts,0);
});
for(const mode of ['unknown_support','extra_anchor','wrong_page'])test(`joint reconciliation rejects conflicting ${mode} support`,async()=>{
 const {options}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
   if(request.name==='question_bank_full_pdf_verification')return verified(supplied(request));
   const result=joint(request,1);
   if(mode==='unknown_support')result.answer_pages['1'].support_ids=['invented'];
   if(mode==='extra_anchor')result.answer_pages['1'].master_pages=[2];
   if(mode==='wrong_page'){result.answer_pages['2']=result.answer_pages['1'];delete result.answer_pages['1'];}
   return result;
 },{indexCache:createContentBankIndex({extractPdf:bytes=>extraction([`${bytes} first page`,`${bytes} second page`])})});
 await assert.rejects(compareContentFirstQuestionBank(options),/support|page/);
});
test('uncertain contenders without anchors remain alternatives rather than being silently excluded',async()=>{
 const {options}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
   if(request.name==='question_bank_full_pdf_verification'){const result=verified(supplied(request));for(const [id,candidate] of Object.entries(result.decisions))if(id!=='1'){candidate.disposition='uncertain';candidate.support=[];}return result;}
   return joint(request,1);
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(result.papers[0].alternatives.length,29);assert.equal(result.papers[0].confidence,'low');
});
test('multi-batch verification and reconciliation retain the same global attempt cap',async()=>{
 const requestPolicy=createMatchingBudget({maxProviderAttempts:4});let joint=0;
 const {options}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
   if(request.name==='question_bank_full_pdf_verification')return verified(supplied(request));
   joint++;return joint(request,1);
 },{requestPolicy});
 await assert.rejects(compareContentFirstQuestionBank(options));assert.equal(joint,0);assert.equal(requestPolicy.snapshot().attempts,4);
});
test('verification-observed writing cannot become blank when screening and final disagree',async()=>{
 const {options}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request),false);
   if(request.name==='question_bank_full_pdf_verification')return verified(supplied(request));
   return {answer_pages:{'1':{support_ids:[],has_answers:false,reason:'Appears blank.'}}};
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(result.pages[0].has_answers,true);assert.equal(result.pages[0].paper_id,0);assert.deepEqual(result.blank_conflict_pages,[1]);
});
test('overlapping content support with conflicting section classifications remains ambiguous',async()=>{
 const {options}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
   if(request.name==='question_bank_full_pdf_verification'){const evidence=verified(supplied(request));for(const [id,candidate] of Object.entries(evidence.decisions))if(id!=='1')candidate.support[0].section='A';return evidence;}
   return joint(request,1);
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(result.papers[0].alternatives.length,29);assert.equal(result.papers[0].confidence,'low');
});
test('each answer page gets its own verified anchors and labels by deterministic expansion',async()=>{
 const {options}=fixture(30,async request=>{
   if(request.schema===CONTENT_SCREEN_SCHEMA){const result=screened(supplied(request),supplied(request));result.pages.push({page:2,has_answers:true});return result;}
   if(request.name==='question_bank_full_pdf_verification'){const evidence=verified(supplied(request));evidence.pages.push({page:2,has_answers:true});for(const candidate of Object.values(evidence.decisions))candidate.support.push({section:'B',answer_pages:[2],master_pages:[2],question_labels:['5B'],correspondence:'A second answer matches a different contained question.'});return evidence;}
   return joint(request,1,2);
 },{content:[...content,{...original,image_url:'data:image/png;base64,c2Vjb25k'}],answerPageCount:2,indexCache:createContentBankIndex({extractPdf:bytes=>extraction([`${bytes} page1`,`${bytes} page2`])})});
 const result=await compareContentFirstQuestionBank(options);assert.deepEqual(result.papers[0].master_pages,[1,2]);assert.deepEqual(result.pages[1].questions,['5B']);
});

// These fixtures reproduce validator failure classes, not recovered live model
// payloads: live42/88 retained error paths but not the invalid response bodies.
for(const mode of ['missing_id','unknown_id','empty_reason','invalid_support'])test(`keyed verification repairs ${mode} once using identical full inputs`,async()=>{
 let attempts=0,first;const {options,requestPolicy}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification'){
   const ids=supplied(request),result=verified(ids);
   assert.deepEqual(request.schema.properties.decisions.required,ids.map(String));
   assert.equal(request.schema.properties.decisions.additionalProperties,false);
   if(ids[0]===1){attempts++;if(attempts===1){first=JSON.stringify(request.content);
    if(mode==='missing_id')delete result.decisions['1'];
    if(mode==='unknown_id')result.decisions['999']=result.decisions['1'];
    if(mode==='empty_reason')result.decisions['1'].reason=' ';
    if(mode==='invalid_support')result.decisions['1'].support[0].master_pages=[999];
   }else{assert.equal(JSON.stringify(request.content),first);assert.match(request.instructions,/SCHEMA REPAIR/);assert.match(request.instructions,/1|999/);}}
   return result;
  }return joint(request,1);
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(attempts,2);assert.equal(result.bank_comparison.schema_repair_count,1);assert.equal(requestPolicy.snapshot().attempts,6);
});
for(const mode of ['unknown','duplicate','conflicting','blank_with_support','anchor_override','missing_page'])test(`joint support selection repairs ${mode} without retyping source anchors`,async()=>{
 let attempts=0,first;const {options,requestPolicy}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification')return verified(supplied(request));
  attempts++;const result=joint(request,1),decision=result.answer_pages['1'];
  if(attempts===1){first=JSON.stringify(request.content);
   if(mode==='unknown')decision.support_ids=['p999s1_unknown'];
   if(mode==='duplicate')decision.support_ids.push(decision.support_ids[0]);
   if(mode==='conflicting')decision.support_ids.push(...joint(request,2).answer_pages['1'].support_ids);
   if(mode==='blank_with_support')decision.has_answers=false;
   if(mode==='anchor_override')decision.master_pages=[99];
   if(mode==='missing_page')delete result.answer_pages['1'];
  }else{assert.equal(JSON.stringify(request.content),first);assert.match(request.instructions,/SCHEMA REPAIR/);}
  return result;
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(attempts,2);assert.equal(result.bank_comparison.schema_repair_count,1);assert.equal(requestPolicy.snapshot().attempts,6);assert.deepEqual(result.papers[0].master_pages,[1]);
});
test('same PDF contained-paper alternatives survive selecting one verified support',async()=>{
 const {options}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification'){const result=verified(supplied(request));if(result.decisions['1'])result.decisions['1'].support.push({...result.decisions['1'].support[0],master_pages:[2],question_labels:['9A']});return result;}
  const result=joint(request,1);result.answer_pages['1'].support_ids.splice(1);return result;
 },{indexCache:createContentBankIndex({extractPdf:bytes=>extraction([`${bytes} page1`,`${bytes} page2`])})});
 const result=await compareContentFirstQuestionBank(options);assert.equal(result.papers[0].confidence,'low');assert.deepEqual(result.papers[0].master_pages,[1]);assert.deepEqual(result.papers[0].alternative_supports[0].master_pages,[2]);
});
test('multiple supported questions on one answer page expand without losing either label or anchor',async()=>{
 const {options}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification'){const result=verified(supplied(request));for(const candidate of Object.values(result.decisions))candidate.support.push({...candidate.support[0],master_pages:[2],question_labels:['5B']});return result;}
  return joint(request,1);
 },{indexCache:createContentBankIndex({extractPdf:bytes=>extraction([`${bytes} page1`,`${bytes} page2`])})});
 const result=await compareContentFirstQuestionBank(options);assert.deepEqual(result.pages[0].questions,['5A','5B']);assert.deepEqual(result.papers[0].master_pages,[1,2]);
});
test('verification repair cannot exceed the original shared request cap',async()=>{
 const requestPolicy=createMatchingBudget({maxProviderAttempts:3});let verificationCalls=0;
 const {options}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  verificationCalls++;return {decisions:{},pages:[{page:1,has_answers:true}]};
 },{requestPolicy});
 await assert.rejects(compareContentFirstQuestionBank(options));assert.equal(verificationCalls,1);assert.equal(requestPolicy.snapshot().attempts,3);
});
test('unresolved joint decisions do not fabricate matches or retry valid uncertainty',async()=>{
 let joints=0;const {options}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification')return verified(supplied(request));
  joints++;return {answer_pages:{'1':{support_ids:[],has_answers:true,reason:'The shared question evidence cannot resolve the administered source.'}}};
 });
 const result=await compareContentFirstQuestionBank(options);assert.equal(joints,1);assert.equal(result.pages[0].paper_id,0);assert.deepEqual(result.papers,[]);assert.equal(result.bank_comparison.full_pdf_verification_evidence.flatMap(batch=>batch.candidates).length,30);
});
test('invalid private response reaches diagnostic sink but unknown strings never enter public errors or repair prompts',async()=>{
 const secret='PRIVATE_RESPONSE_TEXT';let diagnostics=0;
 const {options}=fixture(30,async request=>{
  assert.ok(!request.instructions.includes(secret));
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification'){const result=verified(supplied(request));result.decisions[secret]=result.decisions['1'];return result;}
  throw new Error('No joint request allowed');
 },{onInvalidEvidence:record=>{diagnostics++;assert.ok(JSON.stringify(record.payload).includes(secret));assert.ok(!record.error_message.includes(secret));}});
 await assert.rejects(compareContentFirstQuestionBank(options),error=>!error.message.includes(secret)&&/unknown key count/.test(error.message));assert.equal(diagnostics,2);
});
test('unexpected verification page fields cannot enter retained evidence',async()=>{
 const {options}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  const result=verified(supplied(request));result.pages[0].unexpected='extra payload';return result;
 });
 await assert.rejects(compareContentFirstQuestionBank(options),/only page and has_answers/);
});
test('reconciliation schema only offers page-local support IDs and refuses oversized contracts',()=>{
 const verification=[{candidates:[{support:[{support_id:'a',answer_pages:[1]},{support_id:'b',answer_pages:[2]}]}]}];
 const schema=contentReconciliationSchema(verification,2);
 assert.deepEqual(schema.properties.answer_pages.properties['1'].properties.support_ids.items.enum,['a']);
 assert.deepEqual(schema.properties.answer_pages.properties['2'].properties.support_ids.items.enum,['b']);
 const many=[{candidates:[{support:Array.from({length:501},(_,i)=>({support_id:`s${i}`,answer_pages:[1]}))}]}];
 assert.throws(()=>contentReconciliationSchema(many,1),/bounded size/);
});
for(const mode of ['cancel','budget'])test(`joint structural repair obeys ${mode} before another provider call`,async()=>{
 const requestPolicy=createMatchingBudget({maxProviderAttempts:5});let jointCalls=0;
 const {options}=fixture(30,async request=>{
  if(request.schema===CONTENT_SCREEN_SCHEMA)return screened(supplied(request),supplied(request));
  if(request.name==='question_bank_full_pdf_verification')return verified(supplied(request));
  jointCalls++;if(mode==='cancel')requestPolicy.cancel();return {answer_pages:{}};
 },{requestPolicy});
 await assert.rejects(compareContentFirstQuestionBank(options));assert.equal(jointCalls,1);assert.equal(requestPolicy.snapshot().attempts,5);
});
