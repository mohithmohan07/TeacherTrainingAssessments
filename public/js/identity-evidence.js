// Read-only operator diagnostics from the existing authenticated bulk response.
// Explicit allowlist: never render provider prompts, credentials, answer text,
// or arbitrary nested result fields. This module is not used by reports.
const FIELDS = [['name_written', 'Name'], ['grade_written', 'Class'], ['subjects_written', 'Subject'], ['paper_title_written', 'Paper heading']];
const shown = value => typeof value !== 'string' ? 'Not recorded' : value.trim() || '(blank)';
export const IDENTITY_DISPUTE_LIMITS = Object.freeze({ disputes: 16, value: 200, reason: 300 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const disputeKinds = new Map([
  ['context_change', 'Class or subject changed'], ['name_weakened', 'Name reading weakened'],
  ['name_changed', 'Name changed'], ['resolved_identity_changed', 'Resolved teacher changed'],
  ['master_changed', 'Exact master changed'],
]);
const origins = new Set(['identity_header', 'document_heading', 'answer_content', 'absent', 'uncertain']);
const confidences = new Set(['certain', 'uncertain', 'none']);
const fieldLabels = new Map(FIELDS);
const identifier = value => Number.isSafeInteger(value) && value > 0 ? String(value) : value === null ? 'none' : 'Not recorded';

function auditText(value, limit) {
  if (typeof value !== 'string') return 'Not recorded';
  // Defence in depth for legacy audit strings; never expose transport secrets
  // or image data even if they were accidentally stored in an allowed field.
  const safe = value.replace(/data:[^,\s]*;base64,[a-z\d+/=\s]+/gi, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_ -]?key|password|access[_ -]?token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\bsk-(?:proj-|svcacct-)?[a-z\d_-]{16,}/gi, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return `${safe.slice(0, limit) || '(blank)'}${safe.length > limit ? '… [truncated]' : ''}`;
}

function snapshot(value) {
  return {
    value: auditText(value.value, IDENTITY_DISPUTE_LIMITS.value),
    origin: origins.has(value.origin) ? value.origin : 'Not recorded',
    reason: auditText(value.reason, IDENTITY_DISPUTE_LIMITS.reason),
    nameConfidence: confidences.has(value.name_confidence) ? value.name_confidence : 'Not recorded',
  };
}

// Display stored resolution facts, without independently clearing any guard or
// making the browser a second implementation of server-side adjudication.
export function identityRereadDisputes(identity) {
  const stored = identity?.reread_disputes;
  const available = Array.isArray(stored);
  const view = {
    available, malformed: stored !== undefined && !available, disputes: [],
    omitted: available ? Math.max(0, stored.length - IDENTITY_DISPUTE_LIMITS.disputes) : 0, invalid: 0,
    unclassified: identity?.reread_disputes_unclassified === true,
    truncated: identity?.reread_disputes_truncated === true,
    legacyConflict: ['reread_name_conflict', 'reread_header_conflict', 'identity_conflict'].some(key => identity?.[key] === true),
  };
  if (!available) return view;
  for (const dispute of stored.slice(0, IDENTITY_DISPUTE_LIMITS.disputes)) {
    if (!record(dispute) || !disputeKinds.has(dispute.kind) || !Array.isArray(dispute.fields) ||
        !dispute.fields.length || dispute.fields.length > FIELDS.length ||
        !dispute.fields.every(key => fieldLabels.has(key)) || !record(dispute.original) || !record(dispute.attempted) ||
        !dispute.fields.every(key => record(dispute.original[key]) && record(dispute.attempted[key]))) {
      view.invalid += 1;
      continue;
    }
    const keys = [...new Set(dispute.fields)];
    const resolution = record(dispute.resolution) ? dispute.resolution : {};
    view.disputes.push({
      kind: dispute.kind, label: disputeKinds.get(dispute.kind),
      fields: keys.map(key => ({ key, label: fieldLabels.get(key), original: snapshot(dispute.original[key]), attempted: snapshot(dispute.attempted[key]) })),
      beforeTeacherId: identifier(dispute.before_teacher_id), afterTeacherId: identifier(dispute.after_teacher_id),
      beforeMasterId: identifier(dispute.before_master_id), afterMasterId: identifier(dispute.after_master_id),
      resolution: {
        status: dispute.resolved === true ? 'resolved' : dispute.resolved === false ? 'unresolved' : 'Not recorded',
        source: resolution.source === 'independent_context_verification' ? resolution.source : 'Not recorded',
        fields: Array.isArray(resolution.fields) && resolution.fields.length <= FIELDS.length
          ? [...new Set(resolution.fields.filter(key => fieldLabels.has(key)))].map(key => fieldLabels.get(key)) : [],
        uniqueNameVerified: typeof resolution.unique_name_verified === 'boolean' ? resolution.unique_name_verified : null,
      },
    });
  }
  return view;
}

function rereadGuard(identity, audit) {
  const lines = [identity.field_review_required === true
    ? 'A field-role uncertainty or protected reread disagreement remains.'
    : identity.field_review_required === false
      ? 'No retained field-role/reread review flag is recorded. Profile and teacher-name checks may still block filing.'
      : 'Field-role/reread review status was not recorded. Profile and teacher-name checks may still block filing.'];
  if (!audit.available && !audit.malformed) lines.push('Detailed guard path and discarded reread values were not recorded in this run.');
  if (audit.malformed) lines.push('Stored protected reread audit is malformed; detailed readings are unavailable.');
  if (audit.available && !audit.disputes.length && !audit.invalid && !audit.omitted) lines.push('The stored typed reread-dispute list is empty.');
  if (audit.legacyConflict) lines.push('A legacy protected reread conflict flag remains.');
  if (audit.unclassified) lines.push('The stored audit flags unclassified dispute evidence.');
  if (audit.truncated) lines.push('The stored audit flags additional dispute evidence omitted by its storage limit.');
  if (audit.invalid) lines.push(`${audit.invalid} malformed or unrecognized recorded ${audit.invalid === 1 ? 'dispute is' : 'disputes are'} not displayed.`);
  if (audit.omitted) lines.push(`${audit.omitted} more recorded ${audit.omitted === 1 ? 'dispute is' : 'disputes are'} not displayed (display limit).`);
  if (audit.disputes.length) lines.push('Stored protected reread audit; resolution flags below do not determine filing eligibility:');
  audit.disputes.forEach((dispute, index) => {
    const resolution = dispute.resolution;
    lines.push(`${index + 1}. ${dispute.label} (${dispute.kind}). Resolution status (stored): ${resolution.status}.`);
    if (dispute.kind === 'resolved_identity_changed') lines.push(`Teacher ID: original ${dispute.beforeTeacherId}; attempted ${dispute.afterTeacherId}.`);
    if (dispute.kind === 'master_changed') lines.push(`Master ID: original ${dispute.beforeMasterId}; attempted ${dispute.afterMasterId}.`);
    for (const field of dispute.fields) {
      const side = reading => `“${reading.value}”; origin ${reading.origin}; reason ${reading.reason}${field.key === 'name_written' ? `; name confidence ${reading.nameConfidence}` : ''}`;
      lines.push(`${field.label}: original ${side(field.original)}. Attempted ${side(field.attempted)}.`);
    }
    if (resolution.status === 'resolved') lines.push(`Recorded resolution source: ${resolution.source}; fields: ${resolution.fields.length ? resolution.fields.join(', ') : 'Not recorded'}; unique name verified: ${resolution.uniqueNameVerified === null ? 'Not recorded' : resolution.uniqueNameVerified ? 'yes' : 'no'}.`);
  });
  return lines.join('\n');
}

function storedCrop(audit) {
  const { source_width: sourceWidth, source_height: sourceHeight, pixel_bounds: bounds } = audit ?? {};
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0 ||
      !bounds || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key])) ||
      bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.x + bounds.width > sourceWidth || bounds.y + bounds.height > sourceHeight) return null;
  return { sourceWidth, sourceHeight, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}
export function sourceIdentityEvidence(page) {
  const identity = page?.identity;
  if (!identity) return { page: page?.position ?? null, available: false, summary: 'No stored identity reading for this page.', fields: [] };
  const rereadDisputes = identityRereadDisputes(identity);
  const fields = FIELDS.map(([key, label]) => ({
    label,
    accepted: identity.context_verification?.fields?.[key]?.status === 'uncertain' ? 'Unknown (not established)' : shown(identity[key]),
    observed: identity.field_observations && Object.hasOwn(identity.field_observations, key) ? shown(identity.field_observations[key]) : 'Not recorded',
    origin: typeof identity.field_evidence?.[key]?.origin === 'string' ? identity.field_evidence[key].origin : 'Not recorded',
    reason: typeof identity.field_evidence?.[key]?.reason === 'string' ? identity.field_evidence[key].reason : 'Not recorded',
    verification: identity.context_verification?.fields?.[key] ? {
      status: shown(identity.context_verification.fields[key].status),
      label: shown(identity.context_verification.fields[key].label_quote),
      adjacent: shown(identity.context_verification.fields[key].adjacent_quote),
      reason: shown(identity.context_verification.fields[key].reason),
    } : null,
  }));
  return {
    page: page.position ?? identity.source_page ?? null,
    available: true,
    crop: storedCrop(identity.context_verification?.audit),
    summary: `Name confidence: ${shown(identity.name_confidence)}. Resolved teacher ID: ${identity.teacher_id === null ? 'none' : Number.isSafeInteger(identity.teacher_id) && identity.teacher_id > 0 ? identity.teacher_id : 'not recorded'}. Field review required: ${identity.field_review_required === true ? 'yes' : identity.field_review_required === false ? 'no' : 'not recorded'}.`,
    guard: rereadGuard(identity, rereadDisputes),
    rereadDisputes,
    fields,
  };
}
