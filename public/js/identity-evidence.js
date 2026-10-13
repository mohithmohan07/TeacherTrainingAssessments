// Read-only operator diagnostics from the existing authenticated bulk response.
// Explicit allowlist: never render provider prompts, credentials, answer text,
// or arbitrary nested result fields. This module is not used by reports.
const FIELDS = [['name_written', 'Name'], ['grade_written', 'Class'], ['subjects_written', 'Subject'], ['paper_title_written', 'Paper heading']];
const shown = value => typeof value !== 'string' ? 'Not recorded' : value.trim() || '(blank)';
export function sourceIdentityEvidence(page) {
  const identity = page?.identity;
  if (!identity) return { page: page?.position ?? null, available: false, summary: 'No stored identity reading for this page.', fields: [] };
  const fields = FIELDS.map(([key, label]) => ({
    label,
    accepted: shown(identity[key]),
    observed: identity.field_observations && Object.hasOwn(identity.field_observations, key) ? shown(identity.field_observations[key]) : 'Not recorded',
    origin: typeof identity.field_evidence?.[key]?.origin === 'string' ? identity.field_evidence[key].origin : 'Not recorded',
    reason: typeof identity.field_evidence?.[key]?.reason === 'string' ? identity.field_evidence[key].reason : 'Not recorded',
  }));
  return {
    page: page.position ?? identity.source_page ?? null,
    available: true,
    summary: `Name confidence: ${shown(identity.name_confidence)}. Resolved teacher ID: ${identity.teacher_id === null ? 'none' : Number.isSafeInteger(identity.teacher_id) && identity.teacher_id > 0 ? identity.teacher_id : 'not recorded'}. Field review required: ${identity.field_review_required === true ? 'yes' : identity.field_review_required === false ? 'no' : 'not recorded'}.`,
    guard: identity.field_review_required ? 'A field-role uncertainty or protected reread disagreement remains. Detailed guard path and discarded reread values were not recorded in this run.' : 'No retained field-role/reread review flag is recorded. Profile and teacher-name checks may still block filing.',
    fields,
  };
}
