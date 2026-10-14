import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tta-identity-flow-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.GEMINI_API_KEY = '';
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const bulk = await import('../server/bulk.js');
await new Promise(resolve => setImmediate(resolve));
after(async () => { db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
const school = { id: 1, name: 'Synthetic School' };
const owner = { id: 1, name: 'Arun Rao', grade: 'I & II PU', subjects: 'Electronics' };
db.prepare('INSERT INTO schools(id,name) VALUES(1,?)').run(school.name);
db.prepare('INSERT INTO tests(id,school_id,name) VALUES(1,1,?)').run('Synthetic Test');
db.prepare('INSERT INTO teachers(id,school_id,name,grade,subjects) VALUES(1,1,?,?,?)').run(owner.name, owner.grade, owner.subjects);
db.prepare('INSERT INTO teachers(id,school_id,name,grade,subjects) VALUES(2,1,?,?,?)').run('Beena Shah', owner.grade, owner.subjects);
for (const p of [{ id: 1, title: 'PU Communication and Computing', sections: 'A,C', subject: '' }, { id: 2, title: 'PU Electronics', sections: 'B', subject: 'Electronics' }]) {
  db.prepare('INSERT INTO papers(id,title,sections,levels,subject,stored_name,original_name) VALUES(?,?,?,?,?,?,?)').run(p.id,p.title,p.sections,'senior-secondary',p.subject,`paper-${p.id}.pdf`,`paper-${p.id}.pdf`);
  await fs.writeFile(path.join(UPLOADS_DIR, `paper-${p.id}.pdf`), '%PDF-1.7 synthetic full master');
}
const origin = value => ({ origin: value, reason: 'Synthetic visual role evidence.' });
function observation(page, extra = {}) {
  return { page, name_written: owner.name, teacher_id: 1, grade_written: '', subjects_written: '', paper_title_written: '', name_confidence: 'certain', language: 'english', languages: ['English'],
    field_evidence: { name_written: origin('identity_header'), grade_written: origin('absent'), subjects_written: origin('absent'), paper_title_written: origin('absent') }, ...extra };
}
async function packet() {
  const files = await Promise.all(Array.from({length:24}, async (_,i) => {
    const filename = `source-${Math.random()}-${i}.jpg`;
    await fs.writeFile(path.join(UPLOADS_DIR,filename), `synthetic source ${i+1}`);
    return {filename,mimetype:'image/jpeg',size:20};
  }));
  const id = bulk.addItem(school,{id:1},`${owner.name}.pdf`,files);
  db.prepare("UPDATE bulk_items SET teacher_id=1, matched_by='you' WHERE id=?").run(id);
  return id;
}
const mapping = request => [...request.content.filter(x=>x.type==='input_text').map(x=>x.text).join('\n').matchAll(/local page (\d+) -> original page (\d+)/g)].map(m=>({local:+m[1],original:+m[2]}));
function matched() {
  return { pages: Array.from({length:24},(_,i)=>({page:i+1,section:i<6?'A':i<18?'B':'C',paper_id:i>=6&&i<18?2:1,questions:['5A'],has_answers:true,header_evidence:{status:'not_present',reason:'No administered title.'}})),
    papers:['A','B','C'].map(section=>({section,paper_id:section==='B'?2:1,confidence:'high',reason:'Concrete question and response correspondence.',matched_question_labels:['5A'],alternatives:[]})) };
}

test('24-page sort corrects answer-body metadata through focused rereads and reaches bank matching', async()=>{
  const id=await packet(), calls=[], focused=[];
  await bulk.sortItem(id,{configured:()=>true,request:async request=>{
    calls.push(request.name);
    assert.equal(request.maxRetries,1);
    assert.equal(request.timeoutMs,90000);
    const attempt=request.requestPolicy.beginAttempt({provider:'synthetic',model:'fixture',task:request.task,timeoutMs:request.timeoutMs});
    attempt.finish({status:'success',usage:{inputTokens:10,outputTokens:5,totalTokens:15,cachedTokens:0}});
    if(request.name==='answer_sheets_sorted') return matched();
    return {pages:mapping(request).map(({local,original})=>{
      if(request.name==='answer_sheets_identity_reread') { focused.push(original); return observation(local); }
      const seen=observation(local);
      if(original===15) { seen.name_confidence='uncertain';seen.grade_written='Vc = 60V';seen.field_evidence.grade_written=origin('uncertain'); }
      if(original===5) { seen.paper_title_written='First Pre Board assessment of class ABC';seen.field_evidence.paper_title_written=origin('document_heading'); }
      return seen;
    })};
  }});
  const result=bulk.presentItem(bulk.itemFor(id));
  assert.equal(result.ready,true,JSON.stringify(result.problems));
  assert.deepEqual(focused,[5,15]);
  assert.deepEqual(calls,['answer_sheets_first_look','answer_sheets_first_look','answer_sheets_first_look','answer_sheets_identity_reread','answer_sheets_sorted']);
  assert.equal(result.pages[14].identity.grade_written,'');
  assert.equal(result.pages[4].identity.paper_title_written,'');
  assert.deepEqual(result.pages.map(p=>p.section),Array(6).fill('A').concat(Array(12).fill('B'),Array(6).fill('C')));
  assert.equal(result.matching_metrics.attempts,5);
  assert.equal(result.compared_candidates,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM assessments').get().n,0);
});

test('a certain different teacher cannot be erased by the focused reread',async()=>{
  const id=await packet(); let bankCalls=0;
  await bulk.sortItem(id,{configured:()=>true,request:async request=>{
    if(request.name==='answer_sheets_sorted') {bankCalls++;return matched();}
    return {pages:mapping(request).map(({local,original})=>observation(local,original===15&&request.name==='answer_sheets_first_look'?{name_written:'Beena Shah',teacher_id:2}:{}))};
  }});
  const result=bulk.presentItem(bulk.itemFor(id));
  assert.equal(result.ready,false);
  assert.equal(bulk.itemFor(id).sort_status,'needs_teacher');
  assert.equal(result.pages[14].identity.name_written,'Beena Shah');
  assert.equal(bankCalls,0);
  assert.match(result.problems.join(' '),/identity verification/);
  assert.doesNotMatch(result.problems.join(' '),/incomplete page map|no Section/);
});

test('matching preview is read-only and includes batched identity cost',()=>{
  const before=db.prepare('SELECT * FROM bulk_items').all();
  const plan=bulk.matchingPlan(1,1);
  assert.deepEqual(db.prepare('SELECT * FROM bulk_items').all(),before);
  for(const packet of plan.packets) assert.equal(packet.calls.identityCalls,3);
});

test('a focused reread cannot erase a disambiguating namesake class',async()=>{
  db.prepare('INSERT INTO teachers(id,school_id,name,grade,subjects) VALUES(3,1,?,?,?)').run(owner.name,'Class 5',owner.subjects);
  for(const freshGrade of ['',owner.grade]) {
    const id=await packet();
    db.prepare("UPDATE bulk_items SET matched_by='you' WHERE id=?").run(id);
    let bankCalls=0;
    await bulk.sortItem(id,{configured:()=>true,request:async request=>{
      if(request.name==='answer_sheets_sorted') {bankCalls++;return matched();}
      return {pages:mapping(request).map(({local,original})=>{
        const seen=observation(local);
        // Give ordinary pages enough class context to resolve the namesake.
        seen.grade_written=owner.grade;seen.field_evidence.grade_written=origin('identity_header');
        if(original===15) {
          seen.grade_written=request.name==='answer_sheets_first_look'?'Class 5':freshGrade;
          seen.field_evidence.grade_written=origin(seen.grade_written?'identity_header':'absent');
        }
        return seen;
      })};
    }});
    const result=bulk.presentItem(bulk.itemFor(id));
    assert.equal(result.ready,false);
    assert.equal(result.pages[14].identity.grade_written,'Class 5');
    assert.equal(bankCalls,0);
  }
});

test('exact master contradictions survive focused reads unless explicitly identified as answer content',async()=>{
  for(const answerBody of [false,true]) {
    const id=await packet();let bankCalls=0;
    await bulk.sortItem(id,{configured:()=>true,request:async request=>{
      if(request.name==='answer_sheets_sorted') {bankCalls++;return matched();}
      return {pages:mapping(request).map(({local,original})=>{
        const seen=observation(local,{grade_written:owner.grade});
        seen.field_evidence.grade_written=origin('identity_header');
        if(original===5) {
          seen.paper_title_written=request.name==='answer_sheets_first_look'?'PU Electronics':'PU Communication and Computing';
          seen.field_evidence.paper_title_written=origin(request.name==='answer_sheets_identity_reread'&&answerBody?'answer_content':'document_heading');
        }
        return seen;
      })};
    }});
    const result=bulk.presentItem(bulk.itemFor(id));
    assert.equal(result.ready,answerBody,JSON.stringify(result.problems));
    assert.equal(bankCalls,answerBody?1:0);
    assert.equal(result.pages[4].identity.paper_title_written,answerBody?'':'PU Electronics');
  }
});

test('changing a selected teacher profile invalidates a matching preview',async()=>{
  const id=await packet();
  const before=bulk.matchingPlan(1,1,[id]);
  db.prepare('UPDATE teachers SET subjects=? WHERE id=1').run('Physics');
  const after=bulk.matchingPlan(1,1,[id]);
  assert.notEqual(after.id,before.id);
  db.prepare('UPDATE teachers SET subjects=? WHERE id=1').run(owner.subjects);
});

test('certain identity-header context cannot disappear even before a teacher is selected',async()=>{
  for(const selected of [true,false]) {
    const id=await packet();
    if(!selected) db.prepare("UPDATE bulk_items SET teacher_id=NULL, matched_by=NULL, file_name='neutral.pdf' WHERE id=?").run(id);
    let bankCalls=0;
    await bulk.sortItem(id,{configured:()=>true,request:async request=>{
      if(request.name==='answer_sheets_sorted') {bankCalls++;return matched();}
      return {pages:mapping(request).map(({local,original})=>{
        const seen=observation(local,{grade_written:owner.grade});
        seen.field_evidence.grade_written=origin('identity_header');
        if(original===15&&request.name==='answer_sheets_first_look') {
          seen.grade_written='Class 9';
          seen.paper_title_written='Communication skills';
          seen.field_evidence.paper_title_written=origin('document_heading');
        }
        return seen;
      })};
    }});
    const result=bulk.presentItem(bulk.itemFor(id));
    assert.equal(result.ready,false);
    assert.equal(result.pages[14].identity.grade_written,'Class 9');
    assert.equal(bankCalls,0);
  }
});

test('independent source verification corrects the observed 6th misread without overriding true class evidence',async()=>{
  db.prepare('DELETE FROM teachers WHERE id=3').run();
  for(const verdict of ['answer_content','uncertain','confirmed','unavailable']) {
    const id=await packet();let verificationCalls=0,bankCalls=0;
    await bulk.sortItem(id,{configured:()=>true,verificationConfigured:()=>true,
      verifyIdentity:async options=>{
        verificationCalls++;assert.equal(options.observation.grade_written,'6th');assert.equal(options.observation.field_evidence.grade_written.origin,'identity_header');
        assert.deepEqual(options.bounds,{x:0.45,y:0.01,width:0.4,height:0.08});assert.ok(options.requestPolicy);assert.equal(options.observation.name_written,owner.name);
        if(verdict==='unavailable') throw Object.assign(new Error('Synthetic unavailable verifier'),{code:'SYNTHETIC_UNAVAILABLE'});
        return {status:verdict==='uncertain'?'unresolved':'verified',name_verified:true,
          evidence:{grade:{status:verdict,value:verdict==='confirmed'?'6th':'',label_quote:'CLASS',adjacent_quote:verdict==='answer_content'?'Vc = 60V':'',reason:verdict==='answer_content'?'Voltage notation crosses the border; no independent class is written.':'Independent source observation.'},
            subject:{status:verdict==='uncertain'?'uncertain':'absent',value:'',label_quote:'SUBJECT',adjacent_quote:'',reason:'No class inference from answers.'}},
          audit:{provider:'synthetic',name_verified:true}};
      },request:async request=>{
        if(request.name==='answer_sheets_sorted') {bankCalls++;return matched();}
        return {pages:mapping(request).map(({local,original})=>{
          const seen=observation(local);
          if(original===15) {seen.grade_written='6th';seen.field_evidence.grade_written={origin:'identity_header',reason:'6th is handwritten in the Class field.'};seen.identity_panel_bounds={x:0.45,y:0.01,width:0.4,height:0.08};}
          return seen;
        })};
      }});
    const result=bulk.presentItem(bulk.itemFor(id)), clears=['answer_content','uncertain'].includes(verdict);
    assert.equal(verificationCalls,1);assert.equal(bankCalls,clears?1:0);assert.equal(result.ready,clears,JSON.stringify(result.problems));
    assert.equal(result.pages[14].identity.grade_written,clears?'':'6th');
    if(clears) {assert.equal(result.pages[14].identity.teacher_id,1);assert.equal(result.pages[14].identity.field_observations.grade_written,'6th');assert.equal(result.pages[14].identity.context_verification.fields.grade_written.status,verdict);}
  }
});

test('independent context clearance cannot disambiguate namesakes or different full names',()=>{
  const source={name_written:owner.name,name_confidence:'certain',grade_written:'6th',subjects_written:''};
  assert.equal(bulk.uniqueContextTarget(source,[owner,{...owner,id:7,grade:'Class 6'}],1),null);
  assert.equal(bulk.uniqueContextTarget({...source,name_written:'Arun'},[owner],1),null);
  assert.equal(bulk.uniqueContextTarget(source,[owner],2),null);
  assert.equal(bulk.uniqueContextTarget({...source,name_confidence:'uncertain'},[owner],1),null);
  assert.equal(bulk.uniqueContextTarget(source,[owner],1).id,1);
});

test('a later namesake invalidates independent context clearance at readiness and filing',()=>{
 const verified=db.prepare('SELECT * FROM bulk_items').all().filter(item=>JSON.parse(item.result||'{}').identity?.pages.some(page=>page.context_verification?.status==='verified_unique_name'));
 const ready=verified.filter(item=>bulk.presentItem(item).ready);
 assert.ok(ready.length>=2);
 db.prepare('INSERT INTO teachers(id,school_id,name,grade,subjects) VALUES(9,1,?,?,?)').run(owner.name,'Class 6',owner.subjects);
 for(const item of ready) {
  const view=bulk.presentItem(bulk.itemFor(item.id));assert.equal(view.ready,false);assert.match(view.problems.join(' '),/unique-name context check/);
  assert.equal(bulk.fileReady(1,1,[item.id]).filed.length,0);assert.ok(bulk.itemFor(item.id));
 }
 db.prepare('DELETE FROM teachers WHERE id=9').run();
});

test('independent verification retires compatible context reread disputes without a stale flag', async()=>{
  const id=await packet();let calls=0;
  await bulk.sortItem(id,{configured:()=>true,verificationConfigured:()=>true,
    verifyIdentity:async()=>{calls++;return {status:'verified',name_verified:true,evidence:{
      grade:{status:'confirmed',value:owner.grade,reason:'Explicit handwritten class header.'},
      subject:{status:'absent',value:'',reason:'No subject label value.'}},audit:{provider:'synthetic'}};},
    request:async request=>request.name==='answer_sheets_sorted'?matched():{pages:mapping(request).map(({local,original})=>{
      const seen=observation(local);
      if(original===15){seen.identity_panel_bounds={x:0.45,y:0.01,width:0.4,height:0.08};
        if(request.name==='answer_sheets_first_look'){seen.grade_written=owner.grade;seen.field_evidence.grade_written=origin('identity_header');seen.paper_title_written='Communication skills';seen.field_evidence.paper_title_written=origin('document_heading');}}
      return seen;
    })}});
  const result=bulk.presentItem(bulk.itemFor(id));
  assert.equal(calls,1);assert.equal(result.ready,true,JSON.stringify(result.problems));
  const identity=result.pages[14].identity;
  assert.equal(identity.field_review_required,false);
  assert.ok(identity.reread_disputes.some(d=>d.kind==='context_change'&&d.resolved));
  assert.equal(identity.reread_disputes[0].original.grade_written.value,owner.grade);
  assert.equal(identity.reread_disputes[0].attempted.grade_written.value,'');
});

test('unnamed continuation field verification clears only conclusive false metadata and never assigns its name',async()=>{
  for(const verdict of ['absent','confirmed','uncertain']){
    const id=await packet();let calls=0;
    await bulk.sortItem(id,{configured:()=>true,verificationConfigured:()=>true,
      verifyIdentity:async options=>{calls++;assert.equal(options.mode,'unnamed_fields');assert.equal(options.observation.name_written,'');return {
        status:verdict==='uncertain'?'unresolved':'verified',name_verified:false,fields_verified:verdict!=='uncertain',
        evidence:{grade:{status:verdict,value:verdict==='confirmed'?'1':'',reason:'Independent field inspection.'},subject:{status:'absent',value:'',reason:'Empty subject.'}},audit:{provider:'synthetic'}};},
      request:async request=>request.name==='answer_sheets_sorted'?matched():{pages:mapping(request).map(({local,original})=>{
        const seen=observation(local);if(original===15){seen.name_written='';seen.name_confidence='none';seen.teacher_id=0;seen.field_evidence.name_written=origin('absent');seen.grade_written='1';seen.field_evidence.grade_written=origin('identity_header');seen.identity_panel_bounds={x:0.45,y:0.01,width:0.4,height:0.08};}return seen;
      })}});
    const result=bulk.presentItem(bulk.itemFor(id));assert.equal(calls,1);assert.equal(result.ready,verdict==='absent',JSON.stringify(result.problems));
    assert.equal(result.pages[14].identity.name_written,'');assert.equal(result.pages[14].identity.teacher_id,null);
    if(verdict==='absent'){
      db.prepare('INSERT INTO teachers(id,school_id,name,grade,subjects) VALUES(9,1,?,?,?)').run(owner.name,'Class 1',owner.subjects);
      const changed=bulk.presentItem(bulk.itemFor(id));assert.equal(changed.ready,false);assert.match(changed.problems.join(' '),/unnamed-page metadata check/);
      db.prepare('DELETE FROM teachers WHERE id=9').run();
      const rawItem=bulk.itemFor(id), saved=JSON.parse(rawItem.result);
      const activeOnly=bulk.presentItem(rawItem).pages.map(page=>({id:page.id,section:page.position===15?'B':null}));
      assert.match(bulk.identityProblems(rawItem,activeOnly,saved,[owner]).join(' '),/unnamed-page metadata check/);
    }
  }
});

test('unnamed continuation eligibility rejects mixed, ambiguous and namesake packet anchors',()=>{
  const blank={name_written:'',name_confidence:'none'}, anchor={name_written:owner.name,name_confidence:'certain'};
  assert.equal(bulk.unnamedContextTarget(blank,[blank,anchor],[owner],1)?.id,1);
  for(const pages of [[blank],[blank,{...anchor,field_review_required:true}],[blank,{...anchor,name_confidence:'uncertain'}],[blank,anchor,{name_written:'Beena Shah',name_confidence:'certain'}],[blank,anchor,{...blank,name_confidence:'uncertain'}]])
    assert.equal(bulk.unnamedContextTarget(blank,pages,[owner],1),null);
  assert.equal(bulk.unnamedContextTarget(blank,[blank,anchor],[owner,{...owner,id:9}],1),null);
  assert.equal(bulk.unnamedContextTarget(blank,[blank,anchor],[owner],null),null);
});

test('a corrected named anchor is refreshed before checking an earlier unnamed continuation',async()=>{
  const id=await packet(), modes=[];
  await bulk.sortItem(id,{configured:()=>true,verificationConfigured:()=>true,
    verifyIdentity:async options=>{modes.push(options.mode);return {status:'verified',name_verified:options.mode==='named_identity',fields_verified:true,evidence:{
      grade:{status:options.mode==='named_identity'?'confirmed':'absent',value:options.mode==='named_identity'?owner.grade:'',reason:'Visible source header verification.'},
      subject:{status:'absent',value:'',reason:'Empty subject.'}},audit:{provider:'synthetic'}};},
    request:async request=>request.name==='answer_sheets_sorted'?matched():{pages:mapping(request).map(({local,original})=>{
      const seen=observation(local,{name_written:'',name_confidence:'none',teacher_id:0});seen.field_evidence.name_written=origin('absent');
      if(original===15||original===16)seen.identity_panel_bounds={x:0.45,y:0.01,width:0.4,height:0.08};
      if(original===15){seen.grade_written='1';seen.field_evidence.grade_written=origin('identity_header');}
      if(original===16){seen.name_written=owner.name;seen.name_confidence='certain';seen.teacher_id=1;seen.field_evidence.name_written=origin('identity_header');
        if(request.name==='answer_sheets_first_look'){seen.paper_title_written='Communication skills';seen.field_evidence.paper_title_written=origin('document_heading');seen.grade_written=owner.grade;seen.field_evidence.grade_written=origin('identity_header');}}
      return seen;
    })}});
  assert.deepEqual(modes,['named_identity','unnamed_fields']);
  const result=bulk.presentItem(bulk.itemFor(id));assert.equal(result.ready,true,JSON.stringify(result.problems));
  assert.equal(result.pages[14].identity.teacher_id,null);
});
