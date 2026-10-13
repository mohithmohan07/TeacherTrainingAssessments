// Read-only operator diagnostics from the existing authenticated bulk response.
// Explicit allowlist: never render provider prompts, credentials, answer text,
// or arbitrary nested result fields. This module is not used by reports.
const FIELDS = [['name_written', 'Name'], ['grade_written', 'Class'], ['subjects_written', 'Subject'], ['paper_title_written', 'Paper heading']];
const shown = value => typeof value !== 'string' ? 'Not recorded' : value.trim() || '(blank)';
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
    guard: identity.field_review_required ? 'A field-role uncertainty or protected reread disagreement remains. Detailed guard path and discarded reread values were not recorded in this run.' : 'No retained field-role/reread review flag is recorded. Profile and teacher-name checks may still block filing.',
    fields,
  };
}
