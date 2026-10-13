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
