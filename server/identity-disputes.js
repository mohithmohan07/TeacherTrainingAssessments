// Preserve the observations rejected by a focused identity reread. These
// helpers are pure: provider calls, roster eligibility and independent source
// verification belong to the caller, not to this audit/merge layer.
export const MAX_IDENTITY_DISPUTES = 16;
const VALUE_LIMIT = 500;
const REASON_LIMIT = 1200;
const fields = ['name_written', 'grade_written', 'subjects_written', 'paper_title_written'];
const contextFields = ['grade_written', 'subjects_written'];
const kinds = new Set(['context_change', 'name_weakened', 'name_changed', 'resolved_identity_changed', 'master_changed']);
const origins = new Set(['identity_header', 'document_heading', 'answer_content', 'absent', 'uncertain']);
const confidences = new Set(['certain', 'uncertain', 'none']);
const verificationStatuses = new Set(['confirmed', 'absent', 'answer_content', 'board_metadata', 'uncertain']);
const legacyFlags = ['reread_name_conflict', 'reread_header_conflict', 'identity_conflict',
  'reread_disputes_unclassified', 'reread_disputes_truncated'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
// Punctuation/case/Unicode presentation can differ; initials and all name
// tokens remain significant. There is deliberately no fuzzy name matching.
const comparable = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

function auditText(value, limit) {
  if (typeof value !== 'string') return '';
  // Audit records never copy arbitrary provider objects. Also suppress common
  // transport-secret/data-URL forms if they arrive inside an allowed string.
  return value.replace(/data:[^,\s]*;base64,[a-z\d+/=\s]+/gi, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_ -]?key|password|access[_ -]?token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\bsk-(?:proj-|svcacct-)?[a-z\d_-]{16,}/gi, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, limit);
}

function snapshot(observation, keys) {
  return Object.fromEntries(keys.map(key => [key, {
    value: auditText(observation[key], VALUE_LIMIT),
    origin: origins.has(observation.field_evidence?.[key]?.origin) ? observation.field_evidence[key].origin : null,
    reason: auditText(observation.field_evidence?.[key]?.reason, REASON_LIMIT),
    name_confidence: confidences.has(observation.name_confidence) ? observation.name_confidence : null,
  }]));
}

function validDispute(dispute) {
  return object(dispute) && kinds.has(dispute.kind) && Array.isArray(dispute.fields) && dispute.fields.length > 0 &&
    dispute.fields.every(key => fields.includes(key)) && object(dispute.original) && object(dispute.attempted) &&
    dispute.fields.every(key => object(dispute.original[key]) && object(dispute.attempted[key]));
}

function contextResolvable(dispute) {
  return validDispute(dispute) && dispute.fields.every(key => contextFields.includes(key)) &&
    (dispute.kind === 'context_change' || (dispute.kind === 'resolved_identity_changed' && dispute.context_only === true));
}

function isResolved(dispute) {
  const resolution = dispute?.resolution;
  return contextResolvable(dispute) && dispute.resolved === true && resolution?.source === 'independent_context_verification' &&
    Array.isArray(resolution.fields) && dispute.fields.every(key => resolution.fields.includes(key)) &&
    (dispute.kind !== 'resolved_identity_changed' || resolution.unique_name_verified === true);
}

function sanitizeDispute(dispute) {
  const keys = [...new Set(dispute.fields)];
  const side = value => Object.fromEntries(keys.map(key => [key, {
    value: auditText(value[key].value, VALUE_LIMIT),
    origin: origins.has(value[key].origin) ? value[key].origin : null,
    reason: auditText(value[key].reason, REASON_LIMIT),
    name_confidence: confidences.has(value[key].name_confidence) ? value[key].name_confidence : null,
  }]));
  const safe = {
    kind: dispute.kind, fields: keys,
    original: side(dispute.original), attempted: side(dispute.attempted),
    before_teacher_id: id(dispute.before_teacher_id), after_teacher_id: id(dispute.after_teacher_id),
    before_master_id: id(dispute.before_master_id), after_master_id: id(dispute.after_master_id),
    resolved: isResolved(dispute),
  };
  if (dispute.kind === 'resolved_identity_changed') safe.context_only = dispute.context_only === true;
  if (safe.resolved) safe.resolution = {
    source: 'independent_context_verification', fields: keys,
    unique_name_verified: dispute.resolution.unique_name_verified === true,
  };
  return safe;
}

// Unknown/overflow audit evidence fails closed instead of silently disappearing
// when a bounded audit is rebuilt or a newer read lacks an old legacy flag.
function collectDisputes(result, observations) {
  const disputes = [], seen = new Set();
  for (const observation of observations) {
    for (const flag of legacyFlags) if (observation?.[flag]) result[flag] = true;
    if (observation?.reread_disputes === undefined) continue;
    if (!Array.isArray(observation.reread_disputes)) {
      result.reread_disputes_unclassified = true;
      continue;
    }
    for (const raw of observation.reread_disputes) {
      if (!validDispute(raw)) {
        result.reread_disputes_unclassified = true;
        continue;
      }
      const safe = sanitizeDispute(raw), key = JSON.stringify(safe);
      if (seen.has(key)) continue;
      seen.add(key);
      if (disputes.length < MAX_IDENTITY_DISPUTES) disputes.push(safe);
      else result.reread_disputes_truncated = true;
    }
  }
  return disputes;
}

/** All active disputes and unclassified legacy guards continue to block filing. */
export function hasBlockingIdentityDisputes(observation) {
  if (legacyFlags.some(flag => observation?.[flag])) return true;
  if (observation?.reread_disputes === undefined) return false;
  return !Array.isArray(observation.reread_disputes) || observation.reread_disputes.some(dispute => !isResolved(dispute));
}

/**
 * first/next are the normalized inspectIdentity page objects, while old/fresh
 * are the raw observations. The original guards retain raw values/evidence;
 * a separate bounded record preserves the attempted, discarded observation.
 */
export function mergeIdentityObservations({ old, fresh, first, next, firstMasterId, nextMasterId }) {
  const merged = structuredClone(fresh);
  const disputes = collectDisputes(merged, [old, fresh]);
  const append = (kind, keys, extra = {}) => {
    const dispute = {
      kind, fields: keys, original: snapshot(old, keys), attempted: snapshot(fresh, keys),
      before_teacher_id: id(first.teacher_id), after_teacher_id: id(next.teacher_id),
      before_master_id: id(firstMasterId), after_master_id: id(nextMasterId),
      resolved: false, ...extra,
    };
    if (disputes.length < MAX_IDENTITY_DISPUTES) disputes.push(dispute);
    else merged.reread_disputes_truncated = true;
  };
  const retain = keys => {
    for (const key of keys) {
      merged[key] = structuredClone(old[key]);
      merged.field_evidence = { ...merged.field_evidence, [key]: structuredClone(old.field_evidence?.[key]) };
    }
  };
  const changedContext = contextFields.filter(key => comparable(first[key]) !== comparable(next[key]));
  for (const key of contextFields) {
    if (old.field_evidence?.[key]?.origin === 'identity_header' && String(old[key] ?? '').trim() &&
        changedContext.includes(key) && fresh.field_evidence?.[key]?.origin !== 'answer_content') {
      append('context_change', [key]);
      retain([key]);
    }
  }
  if (id(firstMasterId) && fresh.field_evidence?.paper_title_written?.origin !== 'answer_content' &&
      id(nextMasterId) !== id(firstMasterId)) {
    append('master_changed', ['paper_title_written']);
    retain(['paper_title_written']);
  }
  const certainOriginal = first.name_confidence === 'certain';
  if (first.teacher_id && next.teacher_id !== first.teacher_id && certainOriginal) {
    const contextOnly = Boolean(first.name_written && next.name_written && next.name_confidence === 'certain' &&
      comparable(first.name_written) === comparable(next.name_written) && changedContext.length);
    append('resolved_identity_changed', contextOnly ? changedContext : ['name_written', ...changedContext], { context_only: contextOnly });
    retain(['name_written', 'grade_written', 'subjects_written']);
    merged.teacher_id = old.teacher_id;
    merged.name_confidence = old.name_confidence;
  }
  if (certainOriginal && first.name_written) {
    const weakened = !next.name_written || next.name_confidence !== 'certain';
    const changed = next.name_written && comparable(first.name_written) !== comparable(next.name_written);
    if (weakened) append('name_weakened', ['name_written']);
    if (changed) append('name_changed', ['name_written']);
    if (weakened || changed) {
      retain(['name_written']);
      merged.teacher_id = old.teacher_id;
      merged.name_confidence = old.name_confidence;
    }
  }
  if (disputes.length || Object.hasOwn(old, 'reread_disputes') || Object.hasOwn(fresh, 'reread_disputes')) merged.reread_disputes = disputes;
  return merged;
}

/**
 * The caller must independently adjudicate these fields and apply its source
 * evidence first. Arrays/Sets contain explicitly verified keys; an evidence map
 * may instead contain the verifier's supported status for each field. Only a
 * separate unique-name check can retire a context-only resolved-ID change.
 */
export function resolveContextDisputes(observation, verifiedFields, { uniqueNameVerified = false } = {}) {
  const result = structuredClone(observation);
  const verified = new Set((Array.isArray(verifiedFields) || verifiedFields instanceof Set)
    ? [...verifiedFields].filter(key => contextFields.includes(key))
    : Object.entries(object(verifiedFields) ? verifiedFields : {})
      .filter(([key, evidence]) => contextFields.includes(key) && verificationStatuses.has(evidence?.status)).map(([key]) => key));
  const disputes = collectDisputes(result, [observation]);
  for (const dispute of disputes) {
    if (!contextResolvable(dispute) || !dispute.fields.every(key => verified.has(key)) ||
        (dispute.kind === 'resolved_identity_changed' && !uniqueNameVerified)) continue;
    dispute.resolved = true;
    dispute.resolution = { source: 'independent_context_verification', fields: [...dispute.fields], unique_name_verified: uniqueNameVerified === true };
  }
  if (Object.hasOwn(observation, 'reread_disputes')) result.reread_disputes = disputes;
  return result;
}
