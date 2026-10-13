import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { sourceIdentityEvidence } from '../public/js/identity-evidence.js';

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
