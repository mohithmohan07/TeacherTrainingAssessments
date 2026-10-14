import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { IDENTITY_DISPUTE_LIMITS, identityRereadDisputes, sourceIdentityEvidence } from '../public/js/identity-evidence.js';
import { h } from '../public/js/ui.js';
import { installReportDom } from './report-dom-helper.js';

test('operator evidence displays actual accepted, observed, and role values without changing them',()=>{
 const page={position:15,identity:{name_written:'Synthetic Teacher',grade_written:'',subjects_written:'',paper_title_written:'',name_confidence:'uncertain',teacher_id:null,field_review_required:true,field_observations:{grade_written:'Vc = 60V'},field_evidence:{grade_written:{origin:'answer_content',reason:'Equation below the empty Class field.'}}}};
 const before=JSON.stringify(page), view=sourceIdentityEvidence(page);
 assert.equal(view.page,15);assert.equal(view.fields[1].accepted,'(blank)');assert.equal(view.fields[1].observed,'Vc = 60V');assert.equal(view.fields[1].origin,'answer_content');assert.match(view.summary,/review required: yes/);assert.match(view.guard,/not recorded/);assert.equal(JSON.stringify(page),before);
});
test('legacy and missing readings remain explicitly unknown',()=>{
 assert.equal(sourceIdentityEvidence({position:1}).available,false);
 const view=sourceIdentityEvidence({position:2,identity:{}});
 assert.match(view.summary,/Resolved teacher ID: not recorded/);assert.equal(view.fields[0].accepted,'Not recorded');assert.equal(view.fields[0].observed,'Not recorded');assert.equal(view.fields[0].origin,'Not recorded');
});
test('diagnostics are allowlisted and are not imported by report code',()=>{
 const result=JSON.stringify(sourceIdentityEvidence({position:1,identity:{name_written:'Safe Name',provider_prompt:'PRIVATE PROMPT',api_key:'SECRET',answer_text:'PRIVATE ANSWER',extra:{secret:'PRIVATE NESTED'}}}));
 for(const privateValue of ['PRIVATE PROMPT','SECRET','PRIVATE ANSWER','PRIVATE NESTED']) assert.ok(!result.includes(privateValue));
 for(const filename of ['server/reports.js','server/report-html.js'].filter(f=>fs.existsSync(f))) assert.ok(!fs.readFileSync(filename,'utf8').includes('identity-evidence'));
 const bulk=fs.readFileSync('public/js/views/bulk.js','utf8');assert.match(bulk,/sourceIdentityEvidence/);assert.ok(!bulk.includes('innerHTML = evidence'));
});

test('independent crop view exposes only valid coordinates from the same stored source',()=>{
 const page={position:15,identity:{context_verification:{audit:{source_width:1000,source_height:1500,pixel_bounds:{x:200,y:0,width:700,height:300},buffer:'PRIVATE_BYTES'},fields:{grade_written:{status:'answer_content',label_quote:'CLASS',adjacent_quote:'Vc = 60V',reason:'Crossing notation.'}}}}};
 const view=sourceIdentityEvidence(page);
 assert.deepEqual(view.crop,{sourceWidth:1000,sourceHeight:1500,x:200,y:0,width:700,height:300});assert.equal(view.fields[1].verification.adjacent,'Vc = 60V');assert.ok(!JSON.stringify(view).includes('PRIVATE_BYTES'));
 page.identity.context_verification.audit.pixel_bounds.width=2000;
 assert.equal(sourceIdentityEvidence(page).crop,null);
});

test('independently uncertain context is unknown rather than a recorded blank',()=>{
 const view=sourceIdentityEvidence({identity:{grade_written:'',context_verification:{fields:{grade_written:{status:'uncertain'}}}}});
 assert.equal(view.fields[1].accepted,'Unknown (not established)');
});

const reading = (value, origin = 'identity_header', reason = 'Synthetic field evidence.') => ({ value, origin, reason, name_confidence: 'certain' });
const dispute = (extra = {}) => ({
 kind: 'context_change', fields: ['grade_written'],
 original: { grade_written: reading('Class 6') }, attempted: { grade_written: reading('', 'absent', 'The Class box appears blank.') },
 before_teacher_id: 7, after_teacher_id: null, before_master_id: null, after_master_id: null, resolved: false,
 ...extra,
});

test('typed reread audit displays retained and attempted observations with actual origins and reasons', () => {
 const page = { position: 15, identity: { field_review_required: true, reread_disputes: [dispute()] } };
 const before = JSON.stringify(page), view = sourceIdentityEvidence(page);
 assert.equal(view.rereadDisputes.available, true);
 assert.equal(view.rereadDisputes.disputes[0].kind, 'context_change');
 assert.deepEqual(view.rereadDisputes.disputes[0].fields[0], {
  key: 'grade_written', label: 'Class',
  original: { value: 'Class 6', origin: 'identity_header', reason: 'Synthetic field evidence.', nameConfidence: 'certain' },
  attempted: { value: '(blank)', origin: 'absent', reason: 'The Class box appears blank.', nameConfidence: 'certain' },
 });
 assert.match(view.guard, /Class or subject changed \(context_change\)/);
 assert.match(view.guard, /Resolution status \(stored\): unresolved/);
 assert.match(view.guard, /Class: original “Class 6”; origin identity_header/);
 assert.match(view.guard, /Attempted “\(blank\)”; origin absent; reason The Class box appears blank/);
 assert.doesNotMatch(view.guard, /discarded reread values were not recorded/);
 assert.equal(JSON.stringify(page), before);
});

test('stored resolution details remain distinguishable from eligibility and unresolved flags', () => {
 const resolved = dispute({ resolved: true, resolution: { source: 'independent_context_verification', fields: ['grade_written'], unique_name_verified: false } });
 const view = sourceIdentityEvidence({ identity: { field_review_required: true, reread_disputes: [resolved] } });
 assert.match(view.guard, /disagreement remains/);
 assert.match(view.guard, /Resolution status \(stored\): resolved/);
 assert.match(view.guard, /resolution flags below do not determine filing eligibility/);
 assert.match(view.guard, /source: independent_context_verification; fields: Class; unique name verified: no/);
 const missing = sourceIdentityEvidence({ identity: { reread_disputes: [dispute({ resolved: 'true', resolution: { source: 'UNTRUSTED SOURCE', fields: ['api_key'], unique_name_verified: 'yes' } })] } });
 assert.match(missing.guard, /Resolution status \(stored\): Not recorded/);
 assert.doesNotMatch(missing.guard, /UNTRUSTED SOURCE|api_key|unique name verified: yes/);
 assert.match(missing.guard, /review status was not recorded/);
});

test('name, resolved-teacher and master disputes display bounded typed identifying changes', () => {
 const named = { name_written: reading('Synthetic A. Teacher') };
 const attempted = { name_written: { ...reading('Synthetic B. Teacher', 'uncertain'), name_confidence: 'uncertain' } };
 const view = sourceIdentityEvidence({ identity: { reread_disputes: [
  dispute({ kind: 'name_weakened', fields: ['name_written'], original: named, attempted }),
  dispute({ kind: 'name_changed', fields: ['name_written'], original: named, attempted }),
  dispute({ kind: 'resolved_identity_changed', fields: ['name_written'], original: named, attempted, after_teacher_id: 8 }),
  dispute({ kind: 'master_changed', fields: ['paper_title_written'], original: { paper_title_written: reading('Master 1', 'document_heading') }, attempted: { paper_title_written: reading('Master 2', 'document_heading') }, before_master_id: 31, after_master_id: 32 }),
 ] } });
 assert.equal(view.rereadDisputes.disputes.length, 4);
 assert.match(view.guard, /name confidence certain/);
 assert.match(view.guard, /name confidence uncertain/);
 assert.match(view.guard, /Teacher ID: original 7; attempted 8/);
 assert.match(view.guard, /Master ID: original 31; attempted 32/);
 assert.match(view.guard, /Paper heading: original “Master 1”/);
});

test('missing, empty, malformed and unknown reread audits are explicitly distinguished', () => {
 assert.equal(identityRereadDisputes({}).available, false);
 assert.match(sourceIdentityEvidence({ identity: {} }).guard, /discarded reread values were not recorded/);
 assert.match(sourceIdentityEvidence({ identity: { reread_disputes: [] } }).guard, /stored typed reread-dispute list is empty/);
 assert.match(sourceIdentityEvidence({ identity: { reread_disputes: {} } }).guard, /audit is malformed/);
 for (const invalid of [dispute({ kind: 'future_kind' }), dispute({ fields: ['api_key'] }), dispute({ original: [] }), dispute({ attempted: { grade_written: null } }), dispute({ fields: [] }), dispute({ fields: Array(5).fill('grade_written') })]) {
  const view = sourceIdentityEvidence({ identity: { reread_disputes: [invalid] } });
  assert.equal(view.rereadDisputes.disputes.length, 0);
  assert.equal(view.rereadDisputes.invalid, 1);
  assert.match(view.guard, /1 malformed or unrecognized recorded dispute is not displayed/);
  assert.doesNotMatch(view.guard, /reread-dispute list is empty/);
 }
 const flags = sourceIdentityEvidence({ identity: { reread_disputes: [], reread_disputes_unclassified: true, reread_disputes_truncated: true, reread_name_conflict: true } });
 assert.match(flags.guard, /legacy protected reread conflict flag remains/);
 assert.match(flags.guard, /unclassified dispute evidence/);
 assert.match(flags.guard, /omitted by its storage limit/);
});

test('reread display is bounded and exposes omitted records without copying extra payloads', () => {
 const large = dispute({
  original: { grade_written: reading('v'.repeat(10000), 'identity_header', 'r'.repeat(10000)) },
  provider_prompt: 'PRIVATE PROMPT', image_url: 'PRIVATE IMAGE', credentials: { api_key: 'PRIVATE KEY' }, extra: { nested: 'PRIVATE NESTED' },
 });
 const identity = { reread_disputes: Array(IDENTITY_DISPUTE_LIMITS.disputes + 4).fill(large) };
 const before = JSON.stringify(identity), view = sourceIdentityEvidence({ identity }), rendered = JSON.stringify(view);
 assert.equal(view.rereadDisputes.disputes.length, IDENTITY_DISPUTE_LIMITS.disputes);
 assert.equal(view.rereadDisputes.omitted, 4);
 assert.equal(view.rereadDisputes.disputes[0].fields[0].original.value.length, IDENTITY_DISPUTE_LIMITS.value + '… [truncated]'.length);
 assert.equal(view.rereadDisputes.disputes[0].fields[0].original.reason.length, IDENTITY_DISPUTE_LIMITS.reason + '… [truncated]'.length);
 assert.match(view.guard, /4 more recorded disputes are not displayed/);
 assert.ok(view.guard.length < 20000);
 for (const privateValue of ['PRIVATE PROMPT', 'PRIVATE IMAGE', 'PRIVATE KEY', 'PRIVATE NESTED']) assert.ok(!rendered.includes(privateValue));
 assert.equal(JSON.stringify(identity), before);
});

test('audit strings redact common transport secrets and nested readings remain unknown', () => {
 const view = sourceIdentityEvidence({ identity: { reread_disputes: [dispute({
  original: { grade_written: reading('api_key=private-key; password=private-password; Bearer private-token; data:image/png;base64,AA==') },
  attempted: { grade_written: { value: { prompt: 'PRIVATE NESTED' }, origin: { reason: 'PRIVATE ORIGIN' }, reason: 'sk-proj-abcdefghijklmnop1234567890', name_confidence: { value: 'PRIVATE CONFIDENCE' } } },
 })] } });
 const rendered = JSON.stringify(view);
 for (const secret of ['private-key', 'private-password', 'private-token', 'data:image', 'AA==', 'abcdefghijklmnop', 'PRIVATE NESTED', 'PRIVATE ORIGIN', 'PRIVATE CONFIDENCE']) assert.ok(!rendered.includes(secret), secret);
 assert.match(view.guard, /\[redacted\]/);
 assert.equal(view.rereadDisputes.disputes[0].fields[0].attempted.value, 'Not recorded');
 assert.equal(view.rereadDisputes.disputes[0].fields[0].attempted.origin, 'Not recorded');
});

test('existing guard text-node rendering keeps reread HTML inert and makes no requests', () => {
 const restore = installReportDom({});
 try {
  globalThis.fetch = () => { throw new Error('Read-only evidence must not make requests'); };
  const view = sourceIdentityEvidence({ identity: { reread_disputes: [dispute({ original: { grade_written: reading('<img src="/private-image" onerror="alert(1)"><script>alert(2)</script>') } })] } });
  const guard = h('p', {}, view.guard);
  assert.match(guard.outerHTML, /&lt;img/);
  assert.equal(guard.querySelectorAll('img').length, 0);
  assert.equal(guard.querySelectorAll('script').length, 0);
 } finally { restore(); }
});
