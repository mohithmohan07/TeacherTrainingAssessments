import assert from 'node:assert/strict';
import test from 'node:test';
import { IDENTITY_BATCH_SIZE, IDENTITY_REREAD_BATCH_SIZE, readIdentityPages, rereadIdentityPages } from '../server/identity-reading.js';

// Synthetic, injected scans and requests only. No provider, database or live
// assessment files are loaded by this test suite.
const fields = ['name_written', 'grade_written', 'subjects_written', 'paper_title_written'];
const evidence = (overrides = {}) => Object.fromEntries(fields.map((key) => [key, {
  origin: key === 'name_written' ? 'identity_header' : 'absent', reason: 'Synthetic visible field.', ...overrides[key],
}]));
const page = (number, name = '', extra = {}) => ({ page: number, name_written: name, teacher_id: name ? 11 : 0,
  grade_written: '', subjects_written: '', paper_title_written: '', name_confidence: name ? 'certain' : 'none',
  language: 'english', languages: ['English'], field_evidence: evidence(), ...extra });
const files = Array.from({ length: 24 }, (_, i) => Object.freeze({ id: i + 101, stored_name: `synthetic-page-${i + 1}.png`, position: i + 1 }));
const content = Object.freeze([Object.freeze({ type: 'input_text', text: 'SYNTHETIC ROSTER AND FILE CONTEXT ONLY' })]);
const schema = { type: 'object', required: ['pages'], properties: { pages: { type: 'array' } } };
const pageInputs = async (selected) => selected.flatMap((file, i) => [
  { type: 'input_text', text: `ANSWER SHEETS, page ${i + 1} of ${selected.length}:` },
  { type: 'input_image', image_url: `synthetic:${file.position}`, detail: 'high' },
]);
const suppliedPages = (request) => request.content.filter((item) => item.type === 'input_image').map((item) => Number(item.image_url.split(':')[1]));
const reply = (pages) => ({ name_written: 'Do not inherit this summary', teacher_id: 999, pages });
const options = (request, extra = {}) => ({ files, request, content, schema, instructions: 'Original independent-reading instructions.', pageInputs, ...extra });
const makePrevious = () => ({ name_written: 'Earlier summary', teacher_id: 11, pages: files.map((_, i) => page(i + 1, i === 14 ? 'Teacher A' : '')),
  audit: { batches: [], focused_pages: [] } });

test('24 pages use three eight-page calls and preserve original pages across every boundary', async () => {
  const calls = [];
  const policy = { synthetic: true };
  const result = await readIdentityPages(options(async (request) => {
    calls.push(request);
    const originals = suppliedPages(request);
    assert.equal(originals.length, 8);
    assert.equal(request.requestPolicy, policy);
    assert.equal(request.schema, schema);
    assert.equal(request.timeoutMs, 12345);
    assert.equal(request.maxRetries, 2);
    assert.ok(request.instructions.startsWith('Original independent-reading instructions.'));
    for (let index = 0; index < originals.length; index++) {
      assert.ok(request.content.some((item) => item.text?.includes(`local page ${index + 1} -> original page ${originals[index]}`)));
    }
    return reply(originals.map((original, i) => page(i + 1, `Source ${original}`)).reverse());
  }, { requestPolicy: policy, timeoutMs: 12345, maxRetries: 2 }));
  assert.equal(IDENTITY_BATCH_SIZE, 8);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(suppliedPages), [files.slice(0, 8), files.slice(8, 16), files.slice(16)].map((batch) => batch.map((file) => file.position)));
  assert.deepEqual(result.pages.map((p) => p.page), files.map((file) => file.position));
  for (const index of [8, 9, 16, 17, 24]) assert.equal(result.pages[index - 1].name_written, `Source ${index}`);
  assert.equal(result.name_written, '');
  assert.equal(result.teacher_id, 0);
  assert.deepEqual(result.audit.batches.map((batch) => batch.original_pages), calls.map(suppliedPages));
});

test('last partial batch includes every page with no arbitrary page cutoff', async () => {
  const longer = Array.from({ length: 27 }, (_, i) => ({ position: i + 1 }));
  const sizes = [];
  const result = await readIdentityPages(options(async (request) => {
    const originals = suppliedPages(request);
    sizes.push(originals.length);
    return reply(originals.map((_, i) => page(i + 1)));
  }, { files: longer }));
  assert.deepEqual(sizes, [8, 8, 8, 3]);
  assert.equal(result.pages.at(-1).page, 27);
});

test('mixed teachers and unnamed pages remain page-specific without summary inheritance', async () => {
  const result = await readIdentityPages(options(async (request) => reply(suppliedPages(request).map((original, i) =>
    page(i + 1, original === 8 ? 'Teacher A' : original === 9 ? 'Teacher B' : original === 15 ? 'Teacher C' : '')))));
  assert.equal(result.pages[7].name_written, 'Teacher A');
  assert.equal(result.pages[8].name_written, 'Teacher B');
  assert.equal(result.pages[14].name_written, 'Teacher C');
  assert.equal(result.pages[15].name_written, '');
  assert.equal(result.pages[15].teacher_id, 0);
});

for (const [name, corrupt] of [
  ['duplicate', (pages) => { pages[1].page = 1; }],
  ['missing', (pages) => { pages.pop(); }],
  ['out-of-range', (pages) => { pages[1].page = 9; }],
  ['non-integer', (pages) => { pages[1].page = '2'; }],
  ['malformed evidence', (pages) => { pages[1].field_evidence.name_written.origin = 'made_up'; }],
  ['incomplete evidence', (pages) => { delete pages[1].field_evidence.grade_written; }],
]) test(`${name} observations fail closed instead of losing source pages`, async () => {
  let calls = 0;
  await assert.rejects(readIdentityPages(options(async () => {
    calls += 1;
    const pages = Array.from({ length: 8 }, (_, i) => page(i + 1));
    corrupt(pages);
    return reply(pages);
  })), { code: 'IDENTITY_INVALID_EVIDENCE' });
  assert.equal(calls, 1);
});

test('focused reread sends only flagged pages, at most four per call, and merges only those pages', async () => {
  const previous = makePrevious();
  const before = structuredClone(previous);
  const calls = [], mergedPages = [];
  const selected = [1, 8, 9, 16, 17, 24];
  const result = await rereadIdentityPages({ ...options(async (request) => {
    calls.push(request);
    assert.match(request.instructions, /FOCUSED IDENTITY REREAD/);
    assert.match(request.instructions, /Vc = 60V/);
    assert.match(request.instructions, /report\/assessment titles/);
    return reply(suppliedPages(request).map((original, i) => page(i + 1, `Reread ${original}`)));
  }), previous, pageNumbers: selected, mergeObservation: (old, fresh) => {
    assert.equal(old.page, fresh.page);
    mergedPages.push(old.page);
    return fresh;
  } });
  assert.equal(IDENTITY_REREAD_BATCH_SIZE, 4);
  assert.deepEqual(calls.map(suppliedPages), [[1, 8, 9, 16], [17, 24]]);
  assert.deepEqual(mergedPages, selected);
  assert.deepEqual(result.audit.focused_pages, selected);
  for (const old of previous.pages) {
    if (selected.includes(old.page)) assert.equal(result.pages[old.page - 1].name_written, `Reread ${old.page}`);
    else assert.deepEqual(result.pages[old.page - 1], old);
  }
  assert.deepEqual(previous, before);
});

test('all 24 flagged pages are reread in six bounded batches', async () => {
  const batches = [];
  const result = await rereadIdentityPages({ ...options(async (request) => {
    batches.push(suppliedPages(request));
    return reply(suppliedPages(request).map((_, i) => page(i + 1)));
  }), previous: makePrevious(), pageNumbers: files.map((file) => file.position) });
  assert.equal(batches.length, 6);
  assert.ok(batches.every((batch) => batch.length === 4));
  assert.deepEqual(result.audit.focused_pages, files.map((file) => file.position));
});

test('default merge preserves a genuinely different certain name and both observations', async () => {
  const previous = makePrevious();
  const result = await rereadIdentityPages({ ...options(async () => reply([page(1, 'Teacher B')])), previous, pageNumbers: [15] });
  assert.equal(result.pages[14].name_written, 'Teacher A');
  assert.equal(result.pages[14].identity_conflict, true);
  assert.deepEqual(result.pages[14].field_evidence, previous.pages[14].field_evidence);
  assert.equal(result.pages[14].reread_observation.name_written, 'Teacher B');
  assert.equal(previous.pages[14].identity_conflict, undefined);
});

test('a weaker focused observation cannot erase a previously certain name', async () => {
  const result = await rereadIdentityPages({ ...options(async () => reply([page(1)])), previous: makePrevious(), pageNumbers: [15] });
  assert.equal(result.pages[14].name_written, 'Teacher A');
  assert.equal(result.pages[14].name_confidence, 'certain');
  assert.equal(result.pages[14].reread_observation.name_written, '');
});

test('malformed later focused batch never mutates or partly erases previous observations', async () => {
  const previous = makePrevious();
  const before = structuredClone(previous);
  let calls = 0, merges = 0;
  await assert.rejects(rereadIdentityPages({ ...options(async (request) => {
    calls += 1;
    const pages = suppliedPages(request).map((_, i) => page(i + 1, 'Fresh name'));
    if (calls === 2) pages.pop();
    return reply(pages);
  }), previous, pageNumbers: [1, 2, 3, 4, 15], mergeObservation: (_old, fresh) => { merges += 1; return fresh; } }), { code: 'IDENTITY_INVALID_EVIDENCE' });
  assert.equal(calls, 2);
  assert.equal(merges, 0);
  assert.deepEqual(previous, before);
});

test('successful focus cannot reread the same page a second time', async () => {
  let calls = 0;
  const configuration = options(async () => { calls += 1; return reply([page(1)]); });
  const previous = await rereadIdentityPages({ ...configuration, previous: makePrevious(), pageNumbers: [1, 1] });
  await assert.rejects(rereadIdentityPages({ ...configuration, previous, pageNumbers: [1] }), { code: 'IDENTITY_INVALID_EVIDENCE' });
  assert.equal(calls, 1);
});

test('source files, content, observations, and merge inputs never share writable state with callers', async () => {
  const previous = makePrevious();
  const before = structuredClone({ previous, files, content });
  await rereadIdentityPages({ ...options(async (request) => {
    request.content[0].text = 'changed by injected request';
    return reply([page(1, 'Synthetic fresh name')]);
  }, { pageInputs: async (selected) => {
    selected[0].stored_name = 'changed by injected input builder';
    return pageInputs(selected);
  } }), previous, pageNumbers: [1], mergeObservation: (old, fresh) => {
    old.field_evidence.name_written.reason = 'changed by injected merger';
    return fresh;
  } });
  assert.deepEqual({ previous, files, content }, before);
});

test('unbatched images in shared context are rejected before any request', async () => {
  await assert.rejects(readIdentityPages(options(() => assert.fail('must not request'), {
    content: [...content, { type: 'input_image', image_url: 'unbatched' }],
  })), /roster\/filename text/);
});
