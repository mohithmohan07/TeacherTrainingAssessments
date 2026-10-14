import assert from 'node:assert/strict';
import test from 'node:test';
import { IDENTITY_VERIFICATION_SCHEMA, IDENTITY_VERIFICATION_TIMEOUT_MS, verifyIdentityHeader } from '../server/identity-verification.js';
import { createMatchingBudget } from '../server/matching-budget.js';

// Only synthetic JSON and injected image/transport adapters. No private scan,
// roster, database, external network or live model is used by these tests.
const source = Buffer.from('synthetic-original-image');
const croppedSource = Buffer.from('synthetic-cropped-image');
const bounds = { x: 0.1, y: 0.02, width: 0.8, height: 0.2 };
const geometry = () => ({ sourceWidth: 1000, sourceHeight: 1500,
  pixelBounds: { x: 50, y: 0, width: 900, height: 405 },
  normalizedBounds: { x: 0.05, y: 0, width: 0.9, height: 0.27 }, panelBounds: { ...bounds } });
const crop = async () => ({ buffer: Buffer.from(croppedSource), mimeType: 'image/png', ...geometry() });
const observation = (extra = {}) => ({ name_written: 'Maya Desai', name_confidence: 'certain',
  grade_written: '6th', subjects_written: '', ...extra });
const field = (status = 'absent', extra = {}) => ({ status, value: '', label_quote: 'Class', adjacent_quote: '',
  reason: 'The printed Class label is at the upper right; its full adjacent writing area is visible and blank.', ...extra });
const reply = (extra = {}) => ({ name_written: 'Maya Desai', name_confidence: 'certain', grade: field('answer_content', {
  adjacent_quote: 'Vc = 60V', reason: 'The printed Class label is at upper right. Its writing area is blank; the voltage equation extends upward from the answer below across the box edge.',
}), subject: field('absent', { label_quote: 'Subject', reason: 'The printed Subject label and its blank writing area are visible below Class.' }), ...extra });
const options = (response = reply(), extra = {}) => ({ buffer: Buffer.from(source), mimeType: 'image/jpeg', bounds: { ...bounds },
  observation: observation(), crop, generate: async () => structuredClone(response), ...extra });
const unnamedReply = (extra = {}) => reply({ name_written: '', name_confidence: 'none', ...extra });
const unnamedOptions = (response = unnamedReply(), extra = {}) => options(response, { mode: 'unnamed_fields',
  observation: observation({ name_written: '', name_confidence: 'none', grade_written: '1', teacher_id: null }), ...extra });

test('independent evidence corrects a false class from an answer crossing the panel edge', async () => {
  const input = options();
  const before = structuredClone(input.observation);
  const result = await verifyIdentityHeader(input);
  assert.equal(result.status, 'verified');
  assert.equal(result.mode, 'named_identity');
  assert.equal(result.name_verified, true);
  assert.equal(result.fields_verified, true);
  assert.deepEqual(result.corrections, { grade_written: '' });
  assert.equal(result.evidence.grade.status, 'answer_content');
  assert.equal(result.evidence.grade.adjacent_quote, 'Vc = 60V');
  assert.equal(result.evidence.subject.status, 'absent');
  assert.deepEqual(result.audit.changed_fields, ['grade_written']);
  assert.deepEqual(result.audit.fields.grade_written, { status: 'answer_content', applicable: true, changed: true });
  assert.deepEqual(input.observation, before);
});

test('a real Class 6th remains confirmed even when an adjacent answer crosses the panel', async () => {
  const result = await verifyIdentityHeader(options(reply({ grade: field('confirmed', { value: '6th', adjacent_quote: 'Vc = 60V',
    reason: '6th is written directly after the printed Class label; the separate voltage equation crosses below that value.' }) })));
  assert.equal(result.name_verified, true);
  assert.equal(result.evidence.grade.status, 'confirmed');
  assert.equal(result.evidence.grade.value, '6th');
  assert.deepEqual(result.corrections, {});
  assert.equal(result.audit.fields.grade_written.applicable, true);
  assert.equal(result.audit.fields.grade_written.changed, false);
});

test('confirmed new values are copied exactly without roster substitution', async () => {
  const result = await verifyIdentityHeader(options(reply({ grade: field('confirmed', { value: 'Class VII' }),
    subject: field('confirmed', { value: 'Environmental Studies', label_quote: 'Subject' }) })));
  assert.deepEqual(result.corrections, { grade_written: 'Class VII', subjects_written: 'Environmental Studies' });
});

test('a genuine handwritten header subject outside a blank printed box is preserved', async () => {
  const response = reply({ subject: field('confirmed', { value: 'English', label_quote: 'SUBJECT-HANDLING',
    reason: 'The explicit handwritten SUBJECT-HANDLING label at the top left has English immediately after it. The printed Subject box at the upper right is blank; the handwritten label and value are header metadata, separate from the answers below.' }) });
  const result = await verifyIdentityHeader(options(response, { generate: async (request) => {
    assert.match(request.prompt, /explicit handwritten HEADER metadata labels/);
    assert.match(request.prompt, /outside the printed boxes/);
    assert.match(request.prompt, /Do not prioritize an empty printed box over genuine handwritten header metadata/);
    assert.match(request.prompt, /If genuine header entries disagree.*use uncertain/);
    assert.match(request.prompt, /semantic and physical continuity/);
    return response;
  } }));
  assert.equal(result.evidence.subject.status, 'confirmed');
  assert.equal(result.evidence.subject.label_quote, 'SUBJECT-HANDLING');
  assert.equal(result.corrections.subjects_written, 'English');
});

for (const status of ['absent', 'answer_content']) test(`unnamed fields can clear a class only with conclusive ${status} evidence`, async () => {
  const input = unnamedOptions(unnamedReply({ grade: status === 'absent' ? field('absent') : reply().grade }));
  const before = structuredClone(input.observation);
  const result = await verifyIdentityHeader(input);
  assert.equal(result.mode, 'unnamed_fields');
  assert.equal(result.status, 'verified');
  assert.equal(result.name_verified, false);
  assert.equal(result.fields_verified, true);
  assert.deepEqual(result.corrections, { grade_written: '' });
  assert.equal(result.evidence.name_written, '');
  assert.equal(result.evidence.name_confidence, 'none');
  assert.equal(result.audit.name_check, 'same_empty_name');
  assert.equal(result.audit.mode, 'unnamed_fields');
  assert.equal(result.audit.name_verified, false);
  assert.equal(result.audit.fields_verified, true);
  assert.deepEqual(input.observation, before);
  assert.equal(input.observation.teacher_id, null);
  assert.equal(Object.hasOwn(result, 'teacher_id'), false);
  assert.equal(Object.hasOwn(result.corrections, 'name_written'), false);
  assert.equal(Object.hasOwn(result.corrections, 'teacher_id'), false);
});

test('unnamed fields preserve a genuine confirmed class instead of clearing its conflict', async () => {
  const result = await verifyIdentityHeader(unnamedOptions(unnamedReply({ grade: field('confirmed', { value: '1',
    reason: 'The printed Class label is visible at the upper right, with a clearly written 1 in its associated writing area.' }) })));
  assert.equal(result.status, 'verified');
  assert.equal(result.fields_verified, true);
  assert.equal(result.name_verified, false);
  assert.equal(result.evidence.grade.status, 'confirmed');
  assert.equal(result.evidence.grade.value, '1');
  assert.deepEqual(result.corrections, {});
});

for (const reason of ['The Class value is covered and unreadable.', 'A faint vertical mark may be writing or bleed-through; its role cannot be established.']) {
  test(`unnamed fields remain unresolved: ${reason}`, async () => {
    const result = await verifyIdentityHeader(unnamedOptions(unnamedReply({ grade: field('uncertain', { reason }) }), {
      observation: observation({ name_written: '', name_confidence: 'none', grade_written: '1', subjects_written: 'Physics', teacher_id: null }),
    }));
    assert.equal(result.status, 'unresolved');
    assert.equal(result.name_verified, false);
    assert.equal(result.fields_verified, false);
    assert.deepEqual(result.corrections, {});
    assert.ok(Object.values(result.audit.fields).every((decision) => !decision.applicable && !decision.changed));
  });
}

test('an uncertain subject cannot authorize unnamed class clearance either', async () => {
  const result = await verifyIdentityHeader(unnamedOptions(unnamedReply({ subject: field('uncertain', {
    label_quote: '', reason: 'The possible handwritten subject heading is cut off.',
  }) })));
  assert.equal(result.status, 'unresolved');
  assert.equal(result.fields_verified, false);
  assert.deepEqual(result.corrections, {});
});

for (const [description, observed, verified] of [
  ['a name newly appears', {}, { name_written: 'Nisha Mehta', name_confidence: 'certain' }],
  ['a possible name appears', {}, { name_written: 'Nisha', name_confidence: 'uncertain' }],
  ['independent name region is unreadable', {}, { name_confidence: 'uncertain' }],
  ['original name is uncertain', { name_confidence: 'uncertain' }, {}],
  ['original name is present', { name_written: 'Maya Desai', name_confidence: 'certain' }, {}],
  ['both observations name the same person', { name_written: 'Maya Desai', name_confidence: 'certain' }, { name_written: 'Maya Desai', name_confidence: 'certain' }],
  ['original name is whitespace', { name_written: ' ' }, {}],
  ['independent name is whitespace', {}, { name_written: ' ' }],
]) test(`unnamed mode fails closed when ${description}`, async () => {
  const input = unnamedOptions(unnamedReply(verified));
  Object.assign(input.observation, observed);
  const result = await verifyIdentityHeader(input);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.name_verified, false);
  assert.equal(result.fields_verified, false);
  assert.deepEqual(result.corrections, {});
  assert.ok(Object.values(result.audit.fields).every((decision) => !decision.applicable));
});

test('unnamed mode keeps the source, bounds and owner-free observation immutable', async () => {
  const input = unnamedOptions();
  const before = structuredClone(input.observation);
  input.crop = async (request) => {
    request.buffer.fill(0);
    request.bounds.x = 0.9;
    return crop();
  };
  input.generate = async (request) => {
    assert.equal(request.parts[1].inlineData.data, source.toString('base64'));
    assert.equal(request.maxRetries, 0);
    const sent = JSON.stringify(request);
    assert.ok(!sent.includes('teacher_id'));
    assert.ok(!sent.includes('unnamed_fields')); // The model is not primed to omit a name.
    return unnamedReply();
  };
  assert.equal((await verifyIdentityHeader(input)).fields_verified, true);
  assert.deepEqual(input.buffer, source);
  assert.deepEqual(input.bounds, bounds);
  assert.deepEqual(input.observation, before);
});

test('unknown verification modes fail before crop or provider use', async () => {
  for (const mode of ['unnamed', '', null, 1]) {
    await assert.rejects(verifyIdentityHeader(options(undefined, { mode,
      crop: async () => assert.fail('crop must not run'), generate: async () => assert.fail('provider must not run'),
    })), /verification mode/);
  }
});

test('one bounded call uses the shared policy, full image and contextual crop, without prior OCR or roster context', async () => {
  const requestPolicy = { marker: 'shared-packet-budget' };
  const input = options(undefined, { requestPolicy });
  input.observation = observation({ name_written: 'Unrelated Fullname', grade_written: 'prior-grade-sentinel',
    subjects_written: 'prior-subject-sentinel', teacher_id: 928361, expected_grade: 'roster-grade-sentinel' });
  let calls = 0, crops = 0;
  input.crop = async (request) => {
    crops += 1;
    assert.deepEqual(request.buffer, source);
    assert.equal(request.mimeType, 'image/jpeg');
    assert.deepEqual(request.bounds, bounds);
    assert.equal(request.contextMargin, 0.10);
    request.buffer.fill(0); // The caller and full image must retain their bytes.
    request.bounds.x = 0.9;
    return crop();
  };
  input.generate = async (request) => {
    calls += 1;
    assert.equal(request.requestPolicy, requestPolicy);
    assert.equal(request.timeoutMs, 90_000);
    assert.equal(request.maxRetries, 0);
    assert.equal(request.task, 'verify_identity_header');
    assert.deepEqual(request.schema, IDENTITY_VERIFICATION_SCHEMA);
    assert.notEqual(request.schema, IDENTITY_VERIFICATION_SCHEMA);
    const images = request.parts.filter((part) => part.inlineData).map((part) => part.inlineData);
    assert.deepEqual(images, [
      { mimeType: 'image/jpeg', data: source.toString('base64') },
      { mimeType: 'image/png', data: croppedSource.toString('base64') },
    ]);
    const sent = JSON.stringify(request);
    for (const secret of ['Unrelated Fullname', 'prior-grade-sentinel', 'prior-subject-sentinel', '928361', 'roster-grade-sentinel']) assert.ok(!sent.includes(secret));
    assert.match(request.prompt, /PRINTED field label/);
    assert.match(request.prompt, /semantic and physical continuity/);
    assert.match(request.prompt, /uncertain, never absent/);
    return reply();
  };
  await verifyIdentityHeader(input);
  assert.equal(calls, 1);
  assert.equal(crops, 1);
  assert.equal(IDENTITY_VERIFICATION_TIMEOUT_MS, 90_000);
  assert.deepEqual(input.buffer, source);
  assert.deepEqual(input.bounds, bounds);
});

for (const [description, observed, verified] of [
  ['uncertain original name', { name_confidence: 'uncertain' }, {}],
  ['absent original name', { name_written: '', name_confidence: 'none' }, {}],
  ['uncertain verification name', {}, { name_confidence: 'uncertain' }],
  ['absent verification name', {}, { name_written: '', name_confidence: 'none' }],
  ['different certain name', {}, { name_written: 'Nisha Mehta' }],
  ['missing surname', {}, { name_written: 'Maya' }],
  ['initial-only given name', {}, { name_written: 'M. Desai' }],
  ['only initials on both observations', { name_written: 'M. D.' }, { name_written: 'M. D.' }],
  ['missing roster initial', { name_written: 'Maya G. Desai' }, { name_written: 'Maya Desai' }],
  ['changed roster initial', { name_written: 'Maya G. Desai' }, { name_written: 'Maya K. Desai' }],
  ['honorific plus one name', { name_written: 'Ms. Maya' }, { name_written: 'Ms. Maya' }],
  ['fuzzy similar name', {}, { name_written: 'Mayaa Desai' }],
]) test(`${description} cannot authorize any metadata correction`, async () => {
  const result = await verifyIdentityHeader(options(reply(verified), { observation: observation(observed) }));
  assert.equal(result.status, 'unresolved');
  assert.equal(result.name_verified, false);
  assert.deepEqual(result.corrections, {});
  assert.deepEqual(result.audit.changed_fields, []);
  assert.ok(Object.values(result.audit.fields).every((decision) => !decision.applicable));
});

test('full name comparison tolerates case, Unicode compatibility and punctuation, not missing parts', async () => {
  const result = await verifyIdentityHeader(options(reply({ name_written: 'ＭＡＹＡ   DESAI' }), { observation: observation({ name_written: 'Maya, Desai' }) }));
  assert.equal(result.name_verified, true);
});

for (const name of ['Maya G.', 'M. Desai', 'Maya G. Desai']) test(`exact certain initials-bearing complete name ${name} retains every initial`, async () => {
  const result = await verifyIdentityHeader(options(reply({ name_written: name }), { observation: observation({ name_written: name }) }));
  assert.equal(result.name_verified, true);
  assert.deepEqual(result.corrections, { grade_written: '' });
});

test('unknown fields stay unknown and do not become blank corrections', async () => {
  const unknown = field('uncertain', { label_quote: '', reason: 'The field label and its writing area are cut off.' });
  const result = await verifyIdentityHeader(options(reply({ grade: unknown, subject: unknown }), {
    observation: observation({ subjects_written: 'Physics' }),
  }));
  assert.equal(result.name_verified, true);
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.corrections, {});
  assert.equal(result.evidence.grade.status, 'uncertain');
  assert.equal(result.evidence.subject.status, 'uncertain');
  assert.deepEqual(result.audit.fields.grade_written, { status: 'uncertain', applicable: false, changed: false });
});

test('an uncertain grade does not authorize erasing it alongside a conclusive subject', async () => {
  const result = await verifyIdentityHeader(options(reply({ grade: field('uncertain', { label_quote: '', reason: 'Class writing is obscured.' }) }), {
    observation: observation({ subjects_written: 'Physics' }),
  }));
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.corrections, { subjects_written: '' });
  assert.equal(result.evidence.grade.status, 'uncertain');
});

for (const mode of ['named_identity', 'unnamed_fields']) for (const [description, corrupt] of [
  ['null result', () => null],
  ['array result', () => []],
  ['missing field', (raw) => { delete raw.subject; return raw; }],
  ['extra root field', (raw) => ({ ...raw, teacher_id: 100 })],
  ['unknown confidence', (raw) => ({ ...raw, name_confidence: 'probably' })],
  ['empty certain name', (raw) => ({ ...raw, name_written: ' ', name_confidence: 'certain' })],
  ['written name with no confidence', (raw) => ({ ...raw, name_written: 'Maya Desai', name_confidence: 'none' })],
  ['overlong name', (raw) => ({ ...raw, name_written: 'a'.repeat(301) })],
  ['unknown status', (raw) => ({ ...raw, grade: field('clear') })],
  ['array evidence', (raw) => ({ ...raw, grade: [] })],
  ['extra evidence field', (raw) => ({ ...raw, grade: { ...raw.grade, inferred: true } })],
  ['missing evidence field', (raw) => { delete raw.grade.reason; return raw; }],
  ['numeric value', (raw) => ({ ...raw, grade: field('confirmed', { value: 6 }) })],
  ['empty confirmed value', (raw) => ({ ...raw, grade: field('confirmed') })],
  ['value in absent field', (raw) => ({ ...raw, grade: field('absent', { value: '6th' }) })],
  ['whitespace value in absent field', (raw) => ({ ...raw, grade: field('absent', { value: ' ' }) })],
  ['value in answer content', (raw) => ({ ...raw, grade: field('answer_content', { value: '60', adjacent_quote: 'Vc=60V' }) })],
  ['value in uncertain field', (raw) => ({ ...raw, grade: field('uncertain', { value: '6th' }) })],
  ['missing confirmed label', (raw) => ({ ...raw, grade: field('confirmed', { value: '6th', label_quote: '' }) })],
  ['missing absent label', (raw) => ({ ...raw, grade: field('absent', { label_quote: ' ' }) })],
  ['missing answer-content label', (raw) => ({ ...raw, grade: { ...raw.grade, label_quote: '' } })],
  ['missing adjacent answer', (raw) => ({ ...raw, grade: { ...raw.grade, adjacent_quote: '' } })],
  ['empty reason', (raw) => ({ ...raw, grade: { ...raw.grade, reason: ' ' } })],
  ['overlong quote', (raw) => ({ ...raw, grade: { ...raw.grade, label_quote: 'x'.repeat(301) } })],
  ['overlong reason', (raw) => ({ ...raw, grade: { ...raw.grade, reason: 'x'.repeat(1201) } })],
]) test(`${description} fails closed before returning corrections in ${mode} mode`, async () => {
  let calls = 0;
  const makeOptions = mode === 'unnamed_fields' ? unnamedOptions : options;
  const input = makeOptions(undefined, { generate: async () => {
    calls += 1;
    return corrupt(mode === 'unnamed_fields' ? unnamedReply() : reply());
  } });
  const before = structuredClone(input.observation);
  await assert.rejects(verifyIdentityHeader(input), { code: 'IDENTITY_VERIFICATION_INVALID_EVIDENCE' });
  assert.equal(calls, 1);
  assert.deepEqual(input.observation, before);
});

for (const mode of ['named_identity', 'unnamed_fields']) test(`${mode} provider failures and packet-budget failures propagate unchanged without retries`, async () => {
  for (const code of ['SYNTHETIC_PROVIDER_FAILURE', 'MATCHING_BUDGET_EXHAUSTED', 'MATCHING_BUDGET_PERSISTENCE_FAILED']) {
    const failure = Object.assign(new Error('Synthetic failure.'), { code });
    let calls = 0;
    const makeOptions = mode === 'unnamed_fields' ? unnamedOptions : options;
    const input = makeOptions(undefined, { generate: async () => { calls += 1; throw failure; } });
    const before = structuredClone(input.observation);
    await assert.rejects(verifyIdentityHeader(input), (error) => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(input.observation, before);
  }
});

for (const mode of ['named_identity', 'unnamed_fields']) test(`${mode} uses the same finite packet budget and rejects the next attempt`, async () => {
  const requestPolicy = createMatchingBudget({ maxProviderAttempts: 1 });
  let calls = 0, admitted = 0;
  const makeOptions = mode === 'unnamed_fields' ? unnamedOptions : options;
  const input = makeOptions(undefined, { requestPolicy, generate: async (request) => {
    calls += 1;
    const attempt = request.requestPolicy.beginAttempt({ provider: 'gemini', model: 'synthetic-model', task: request.task, timeoutMs: request.timeoutMs });
    admitted += 1;
    attempt.finish({ status: 'success', usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
    return mode === 'unnamed_fields' ? unnamedReply() : reply();
  } });
  assert.equal((await verifyIdentityHeader(input)).fields_verified, true);
  await assert.rejects(verifyIdentityHeader(input), { code: 'MATCHING_BUDGET_EXHAUSTED' });
  assert.equal(calls, 2);
  assert.equal(admitted, 1);
  assert.equal(requestPolicy.snapshot().attempts, 1);
  assert.equal(requestPolicy.snapshot().usage.totalTokens, 15);
});

test('crop failure propagates unchanged and does not call the provider', async () => {
  const failure = Object.assign(new Error('Synthetic unsupported crop.'), { code: 'IDENTITY_CROP_UNSUPPORTED' });
  await assert.rejects(verifyIdentityHeader(options(undefined, {
    crop: async () => { throw failure; }, generate: async () => assert.fail('provider must not run'),
  })), (error) => error === failure);
});

test('invalid source geometry is rejected before crop or provider use', async () => {
  for (const invalid of [null, {}, { ...bounds, x: NaN }, { ...bounds, x: -0.1 }, { ...bounds, width: 0 },
    { ...bounds, x: 0.9 }, { ...bounds, height: Infinity }, { ...bounds, prompt: 'untrusted extra' }]) {
    await assert.rejects(verifyIdentityHeader(options(undefined, { bounds: invalid,
      crop: async () => assert.fail('crop must not run'), generate: async () => assert.fail('provider must not run'),
    })), /normalized identity-panel bounds/);
  }
});

test('malformed crop geometry is rejected before provider use', async () => {
  for (const bad of [{ sourceWidth: 0 }, { mimeType: 'image/jpeg' }, { buffer: Buffer.alloc(0) },
    { pixelBounds: { x: 50, y: 0, width: 1000, height: 405 } }, { normalizedBounds: { ...bounds, width: 2 } },
    { panelBounds: { ...bounds, x: -1 } }]) {
    await assert.rejects(verifyIdentityHeader(options(undefined, { crop: async () => ({ ...await crop(), ...bad }),
      generate: async () => assert.fail('provider must not run'),
    })), { code: 'IDENTITY_VERIFICATION_INVALID_EVIDENCE' });
  }
});

test('audit is bounded and excludes images, prompts, crop adapter extras and shared mutable evidence', async () => {
  const raw = reply();
  const result = await verifyIdentityHeader(options(undefined, { generate: async () => raw,
    crop: async () => ({ ...await crop(), sourceBuffer: source, apiKey: 'synthetic-secret', extra: 'x'.repeat(100000) }),
  }));
  assert.deepEqual(result.audit.pixel_bounds, geometry().pixelBounds);
  assert.deepEqual(result.audit.normalized_bounds, geometry().normalizedBounds);
  assert.deepEqual(result.audit.panel_bounds, bounds);
  assert.equal(result.audit.provider, 'gemini');
  const saved = JSON.stringify(result.audit);
  for (const forbidden of ['synthetic-secret', source.toString('base64'), croppedSource.toString('base64'), 'inlineData', 'prompt', 'sourceBuffer']) {
    assert.ok(!saved.includes(forbidden), `audit must exclude ${forbidden}`);
  }
  assert.ok(saved.length < 10000);
  raw.grade.reason = 'changed after validation';
  result.evidence.grade.status = 'uncertain';
  assert.notEqual(result.audit.evidence.grade.reason, raw.grade.reason);
  assert.equal(result.audit.evidence.grade.status, 'answer_content');
});
