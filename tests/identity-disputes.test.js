import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasBlockingIdentityDisputes, MAX_IDENTITY_DISPUTES, mergeIdentityObservations, resolveContextDisputes } from '../server/identity-disputes.js';

const evidence = (origin, reason = 'Synthetic source field evidence.') => ({ origin, reason });
function observation(extra = {}) {
  return {
    page: 1, name_written: 'Maya B. Desai', teacher_id: 7, name_confidence: 'certain',
    grade_written: 'Class 6', subjects_written: 'Electronics', paper_title_written: '',
    language: 'english', languages: ['English'],
    field_evidence: {
      name_written: evidence('identity_header'), grade_written: evidence('identity_header'),
      subjects_written: evidence('identity_header'), paper_title_written: evidence('absent'),
    }, ...extra,
  };
}
function changed(old, values, fieldEvidence = {}) {
  return { ...structuredClone(old), ...values, field_evidence: { ...structuredClone(old.field_evidence), ...fieldEvidence } };
}
function normalized(raw, teacherId = raw.teacher_id) {
  const result = { ...raw, teacher_id: teacherId };
  for (const key of ['name_written', 'grade_written', 'subjects_written', 'paper_title_written']) {
    if (['answer_content', 'absent'].includes(raw.field_evidence?.[key]?.origin)) result[key] = '';
  }
  return result;
}
function merge(old, fresh, options = {}) {
  return mergeIdentityObservations({ old, fresh, first: normalized(old), next: normalized(fresh), ...options });
}
const kinds = result => result.reread_disputes.map(dispute => dispute.kind);

test('context-only rejection retains both readings and no stale generic name flag after independent correction', () => {
  const old = observation({ grade_written: '6th' });
  const fresh = changed(old, { grade_written: '' }, { grade_written: evidence('absent', 'The Class box appears blank.') });
  const result = merge(old, fresh, { first: normalized(old, null) });
  assert.equal(result.grade_written, '6th');
  assert.deepEqual(result.field_evidence.grade_written, old.field_evidence.grade_written);
  assert.deepEqual(kinds(result), ['context_change']);
  assert.equal(result.reread_name_conflict, undefined);
  assert.equal(hasBlockingIdentityDisputes(result), true);
  assert.deepEqual(result.reread_disputes[0].original.grade_written, {
    value: '6th', origin: 'identity_header', reason: 'Synthetic source field evidence.', name_confidence: 'certain',
  });
  assert.deepEqual(result.reread_disputes[0].attempted.grade_written, {
    value: '', origin: 'absent', reason: 'The Class box appears blank.', name_confidence: 'certain',
  });
  const independentlyCorrected = changed(result, {}, { grade_written: evidence('answer_content', 'Voltage writing crosses the empty Class box.') });
  const cleared = resolveContextDisputes(independentlyCorrected, { grade_written: { status: 'answer_content' } });
  assert.equal(hasBlockingIdentityDisputes(cleared), false);
  assert.equal(cleared.reread_disputes[0].resolved, true);
  assert.equal(cleared.grade_written, '6th', 'raw original text remains available even when its role is corrected');
  assert.equal(cleared.reread_disputes[0].attempted.grade_written.value, '');
  assert.equal(result.reread_disputes[0].resolved, false, 'resolution must not mutate the old audit');
});

test('a changed class or subject remains disputed even when both readings fit the same teacher', () => {
  const old = observation();
  const fresh = changed(old, { grade_written: 'Classes 6 and 7', subjects_written: 'Physics / Electronics' });
  const result = merge(old, fresh);
  assert.equal(result.grade_written, old.grade_written);
  assert.equal(result.subjects_written, old.subjects_written);
  assert.deepEqual(kinds(result), ['context_change', 'context_change']);
  assert.equal(hasBlockingIdentityDisputes(result), true);
  const gradeOnly = resolveContextDisputes(result, ['grade_written']);
  assert.equal(gradeOnly.reread_disputes[0].resolved, true);
  assert.equal(gradeOnly.reread_disputes[1].resolved, false);
  assert.equal(hasBlockingIdentityDisputes(gradeOnly), true);
  assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(gradeOnly, new Set(['subjects_written']))), false);
});

test('context-only resolved-identity changes need explicit unique-name verification and every affected field', () => {
  const old = observation();
  const fresh = changed(old, { grade_written: 'Class 7', subjects_written: 'Physics', teacher_id: 8 });
  const result = merge(old, fresh);
  const dispute = result.reread_disputes.find(entry => entry.kind === 'resolved_identity_changed');
  assert.equal(dispute.context_only, true);
  assert.deepEqual(dispute.fields, ['grade_written', 'subjects_written']);
  assert.equal(dispute.before_teacher_id, 7);
  assert.equal(dispute.after_teacher_id, 8);
  assert.equal(result.teacher_id, 7);
  assert.equal(result.name_written, old.name_written);
  assert.equal(result.grade_written, old.grade_written);
  assert.equal(result.subjects_written, old.subjects_written);
  assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(result, ['grade_written', 'subjects_written'])), true);
  assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(result, ['grade_written'], { uniqueNameVerified: true })), true);
  const cleared = resolveContextDisputes(result, ['grade_written', 'subjects_written'], { uniqueNameVerified: true });
  assert.equal(hasBlockingIdentityDisputes(cleared), false);
  assert.equal(cleared.reread_disputes[2].resolution.unique_name_verified, true);
});

test('independent class/subject adjudication cannot erase mixed name, resolved identity and exact-master disputes', () => {
  const old = observation({ paper_title_written: 'Electronics version 1' });
  old.field_evidence.paper_title_written = evidence('document_heading');
  const fresh = changed(old, {
    name_written: 'Maya D. Desai', teacher_id: 8, grade_written: 'Class 7', paper_title_written: 'Electronics version 2',
  });
  const result = merge(old, fresh, { firstMasterId: 31, nextMasterId: 32 });
  assert.deepEqual(kinds(result), ['context_change', 'master_changed', 'resolved_identity_changed', 'name_changed']);
  assert.equal(result.name_written, old.name_written);
  assert.equal(result.teacher_id, old.teacher_id);
  assert.equal(result.paper_title_written, old.paper_title_written);
  const master = result.reread_disputes.find(entry => entry.kind === 'master_changed');
  assert.equal(master.original.paper_title_written.value, 'Electronics version 1');
  assert.equal(master.attempted.paper_title_written.value, 'Electronics version 2');
  assert.equal(master.before_master_id, 31);
  assert.equal(master.after_master_id, 32);
  const cleared = resolveContextDisputes(result, ['grade_written', 'subjects_written', 'name_written', 'paper_title_written'], { uniqueNameVerified: true });
  assert.equal(cleared.reread_disputes[0].resolved, true);
  assert.ok(cleared.reread_disputes.slice(1).every(dispute => !dispute.resolved));
  assert.equal(hasBlockingIdentityDisputes(cleared), true);
});

test('weakened certain names retain original confidence and survive all context resolution', () => {
  for (const [name, confidence, origin] of [['Maya B. Desai', 'uncertain', 'uncertain'], ['', 'none', 'absent']]) {
    const old = observation();
    const fresh = changed(old, { name_written: name, name_confidence: confidence, teacher_id: 0 }, { name_written: evidence(origin) });
    const result = merge(old, fresh, { next: normalized(fresh, null) });
    assert.equal(result.name_written, old.name_written);
    assert.equal(result.name_confidence, 'certain');
    const weakened = result.reread_disputes.find(dispute => dispute.kind === 'name_weakened');
    assert.equal(weakened.attempted.name_written.value, name);
    assert.equal(weakened.attempted.name_written.name_confidence, confidence);
    assert.equal(weakened.attempted.name_written.origin, origin);
    assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(result, ['grade_written', 'subjects_written'], { uniqueNameVerified: true })), true);
  }
});

test('safe punctuation and Unicode presentation are equivalent without dropping or expanding initials', () => {
  const old = observation();
  for (const name of ['MAYA B DESAI', 'Maya-B.Desai', 'Ｍａｙａ Ｂ． Ｄｅｓａｉ']) {
    const result = merge(old, changed(old, { name_written: name }));
    assert.equal(hasBlockingIdentityDisputes(result), false, name);
    assert.equal(result.name_written, name);
  }
  for (const name of ['Maya D. Desai', 'Maya Desai', 'Maya Bala Desai', 'Maya B. Desay']) {
    const result = merge(old, changed(old, { name_written: name }));
    assert.deepEqual(kinds(result), ['name_changed'], name);
    assert.equal(result.name_written, old.name_written);
    assert.equal(hasBlockingIdentityDisputes(result), true);
  }
  const kannada = observation({ name_written: 'ಮಾಯಾ ಬಿ. ದೇಸಾಯಿ' });
  assert.equal(hasBlockingIdentityDisputes(merge(kannada, changed(kannada, { name_written: 'ಮಾಯಾ ಬಿ ದೇಸಾಯಿ' }))), false);
});

test('explicit answer-content context and master corrections retain the existing permitted path', () => {
  const old = observation({ paper_title_written: 'Electronics version 1' });
  old.field_evidence.paper_title_written = evidence('document_heading');
  const fresh = changed(old, { grade_written: 'Vc = 60V', paper_title_written: 'Class report' }, {
    grade_written: evidence('answer_content'), paper_title_written: evidence('answer_content'),
  });
  const result = merge(old, fresh, { firstMasterId: 31, nextMasterId: null });
  assert.equal(result.grade_written, 'Vc = 60V');
  assert.equal(result.paper_title_written, 'Class report');
  assert.equal(hasBlockingIdentityDisputes(result), false);
});

test('legacy flags and unknown/malformed disputes fail closed without unsupported clearance', () => {
  for (const extra of [{ reread_name_conflict: true }, { reread_header_conflict: true }, { identity_conflict: true },
    { reread_disputes: [{ kind: 'future_guard', resolved: true, provider_prompt: 'Do not copy this.' }] }, { reread_disputes: 'unknown' }]) {
    const old = observation(extra), fresh = observation();
    const result = merge(old, fresh);
    assert.equal(hasBlockingIdentityDisputes(result), true);
    assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(result, ['grade_written', 'subjects_written'], { uniqueNameVerified: true })), true);
    assert.doesNotMatch(JSON.stringify(result.reread_disputes ?? []), /Do not copy this/);
  }
});

test('unsupported verification fields/statuses and fabricated resolutions cannot clear guards', () => {
  const old = observation(), result = merge(old, changed(old, { grade_written: 'Class 7' }));
  for (const verified of [undefined, [], ['name_written'], ['grade'], { grade_written: { status: 'unavailable' } }, { grade_written: true }]) {
    assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(result, verified, { uniqueNameVerified: true })), true);
  }
  const nameDispute = merge(old, changed(old, { name_written: 'Maya D. Desai' }));
  nameDispute.reread_disputes[0].resolved = true;
  nameDispute.reread_disputes[0].resolution = { source: 'independent_context_verification', fields: ['name_written'], unique_name_verified: true };
  assert.equal(hasBlockingIdentityDisputes(nameDispute), true);
});

test('audit data is allowlisted and bounded; truncated or unclassified evidence keeps blocking', () => {
  const old = observation({ grade_written: '6'.repeat(900) });
  old.field_evidence.grade_written = { origin: 'identity_header', reason: 'r'.repeat(1600),
    image: 'data:image/png;base64,AA==', prompt: 'Hidden provider prompt', credentials: { api_key: 'never-copy' } };
  const fresh = changed(old, { grade_written: 'Class 7' }, { grade_written: {
    origin: 'identity_header', reason: 'Bearer secret-token; api_key=secret-token; data:image/png;base64,AA==',
  } });
  const result = merge(old, fresh), serialized = JSON.stringify(result.reread_disputes);
  assert.equal(result.reread_disputes[0].original.grade_written.value.length, 500);
  assert.equal(result.reread_disputes[0].original.grade_written.reason.length, 1200);
  assert.doesNotMatch(serialized, /Hidden provider prompt|credentials|never-copy|secret-token|data:image|AA==/);
  const many = observation({ reread_disputes: Array.from({ length: MAX_IDENTITY_DISPUTES + 4 }, (_, index) => {
    const dispute = structuredClone(result.reread_disputes[0]);
    dispute.original.grade_written.value = `Class ${index}`;
    return dispute;
  }) });
  const bounded = merge(many, observation());
  assert.equal(bounded.reread_disputes.length, MAX_IDENTITY_DISPUTES);
  assert.equal(bounded.reread_disputes_truncated, true);
  assert.equal(hasBlockingIdentityDisputes(resolveContextDisputes(bounded, ['grade_written'], { uniqueNameVerified: true })), true);
});

test('merge and resolution leave all inputs unchanged and return detached nested data', () => {
  const old = observation(), fresh = changed(old, { grade_written: 'Class 7' });
  const first = normalized(old), next = normalized(fresh);
  const inputs = { old, fresh, first, next }, before = structuredClone(inputs);
  const result = mergeIdentityObservations(inputs);
  const cleared = resolveContextDisputes(result, ['grade_written']);
  assert.deepEqual(inputs, before);
  assert.equal(result.reread_disputes[0].resolved, false);
  cleared.field_evidence.grade_written.reason = 'Changed in returned copy.';
  cleared.languages.push('Synthetic');
  assert.deepEqual(inputs, before);
  assert.equal(result.field_evidence.grade_written.reason, old.field_evidence.grade_written.reason);
  assert.deepEqual(result.languages, ['English']);
  assert.deepEqual(merge(old, old), old, 'an unchanged observation needs no audit decoration');
});
