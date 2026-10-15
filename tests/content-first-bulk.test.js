import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-first-'));
process.env.DATA_DIR = dir;
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const bulk = await import('../server/bulk.js');
await new Promise(resolve => setImmediate(resolve));
after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
db.prepare('INSERT INTO schools(id,name) VALUES(1,?)').run('Synthetic school');
db.prepare('INSERT INTO tests(id,school_id,name) VALUES(1,1,?)').run('Synthetic test');
db.prepare('INSERT INTO teachers(id,school_id,name,grade,subjects) VALUES(1,1,?,?,?)').run('Synthetic Teacher', 'Grade 2', 'Science');
for (const [id, subject, level] of [[1,'Science','primary'],[2,'Biology','secondary']]) {
  db.prepare('INSERT INTO papers(id,title,sections,subject,levels,stored_name,original_name) VALUES(?,?,?,?,?,?,?)').run(id,`Master${id}`,'B',subject,level,`master${id}.pdf`,`master${id}.pdf`);
  await fs.writeFile(path.join(UPLOADS_DIR,`master${id}.pdf`),`%PDF synthetic${id}`);
}
async function packet(teacherId = null) {
  const filename = `scan${Math.random()}.png`; await fs.writeFile(path.join(UPLOADS_DIR,filename),'synthetic source bytes');
  const id = bulk.addItem({id:1},{id:1},'Synthetic answers.pdf',[{filename,mimetype:'image/png',size:22}]);
  db.prepare("UPDATE bulk_items SET teacher_id=?, sort_status='needs_teacher' WHERE id=?").run(teacherId,id);
  return id;
}
const comparison = () => ({ pages:[{page:1,section:'B',paper_id:2,questions:['2A'],has_answers:true,header_evidence:{status:'not_present',reason:'No heading.'}}],
  papers:[{section:'B',paper_id:2,confidence:'high',reason:'Food chain prerequisite response matches Q2A.',matched_question_labels:['2A'],alternatives:[]}],
  considered_candidate_ids:[1,2],bank_comparison:{complete:true,candidate_count:2,final_compared:true,finalist_ids:[2]} });
const row = id => bulk.presentItem(bulk.itemFor(id));
test('content matching ignores missing identity and incompatible class/subject eligibility', async () => {
  for (const teacherId of [null,1]) {
    const id=await packet(teacherId); let calls=0;
    await bulk.sortContentItem(id,{configured:()=>true,compare:async args=>{
      calls++; assert.deepEqual(args.candidates.map(p=>p.id),[1,2]);
      assert.ok(!JSON.stringify(args.content).includes('Synthetic Teacher'));
      return comparison();
    }});
    const shown=row(id);
    assert.equal(calls,1); assert.equal(shown.content_match.status,'complete');
    assert.equal(shown.content_match.sections[0].paper_id,2);
    assert.equal(shown.identity_review.status,'needs_review'); assert.equal(shown.ready,false);
    assert.equal(shown.teacher?.id ?? null,teacherId); assert.equal(shown.pages.length,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM assessments').get().n,0);
  }
});
test('byte-identical content result reuse avoids all new model work and changed bytes invalidate it', async()=>{
  const id=await packet(1); let calls=0;
  const options={configured:()=>true,compare:async()=>{calls++;return comparison();}};
  await bulk.sortContentItem(id,options);
  await bulk.sortContentItem(id,options);
  assert.equal(calls,1);assert.equal(row(id).content_match.reused,true);
  const page=db.prepare('SELECT * FROM bulk_pages WHERE item_id=?').get(id);
  await fs.writeFile(path.join(UPLOADS_DIR,page.stored_name),'replaced source bytes');
  await bulk.sortContentItem(id,options);assert.equal(calls,2);
  await fs.writeFile(path.join(UPLOADS_DIR,'master2.pdf'),'%PDF revised master2');
  await bulk.sortContentItem(id,options);assert.equal(calls,3);
});
test('partial bank completion never becomes a content match or ready item',async()=>{
  const id=await packet(1);
  await assert.rejects(bulk.sortContentItem(id,{configured:()=>true,compare:async()=>({...comparison(),bank_comparison:{complete:false}})}),/entire supplied bank/);
  assert.equal(row(id).content_match.status,'failed');assert.equal(row(id).ready,false);
});
test('changing source bytes during comparison rejects stale evidence and retains pages',async()=>{
  const id=await packet(1), page=db.prepare('SELECT * FROM bulk_pages WHERE item_id=?').get(id);
  await assert.rejects(bulk.sortContentItem(id,{configured:()=>true,compare:async()=>{
    await fs.writeFile(path.join(UPLOADS_DIR,page.stored_name),'changed during request');return comparison();
  }}),/changed during comparison/);
  assert.equal(row(id).pages[0].id,page.id);assert.equal(row(id).content_match.status,'failed');
});
test('content plan includes identity-blocked items and the whole bank without restarting completed content review',async()=>{
  const id=await packet(1);
  assert.ok(bulk.matchingPlan(1,1).packets.some(p=>p.item_id===id&&p.compatible_candidates===2));
  await bulk.sortContentItem(id,{configured:()=>true,compare:async()=>comparison()});
  assert.ok(!bulk.matchingPlan(1,1).packets.some(p=>p.item_id===id));
});

test('matching preview approval digest changes when a full master changes in place',async()=>{
  await packet(1);
  const before=bulk.matchingPlan(1,1);
  await fs.writeFile(path.join(UPLOADS_DIR,'master1.pdf'),'%PDF changed preview bytes');
  const next=bulk.matchingPlan(1,1);
  assert.notEqual(before.id,next.id);
  assert.notEqual(before.bank_manifest[0].sha256,next.bank_manifest[0].sha256);
});

test('completed content evidence becomes stale on source or bank mutation without rematching',async()=>{
  const id=await packet(1);
  await bulk.sortContentItem(id,{configured:()=>true,compare:async()=>comparison()});
  const page=db.prepare('SELECT * FROM bulk_pages WHERE item_id=?').get(id);
  await fs.writeFile(path.join(UPLOADS_DIR,page.stored_name),'later changed bytes');
  assert.equal(row(id).content_match.status,'stale');
  assert.equal(row(id).ready,false);
  assert.match(bulk.choosePapers(bulk.itemFor(id),{B:2}),/changed/);
  assert.equal(bulk.fileReady(1,1,[id]).filed.length,0);
});
test('unbound legacy identity cannot gain a fresh identity source binding from content matching',async()=>{
  const id=await packet(1), pages=db.prepare('SELECT * FROM bulk_pages WHERE item_id=?').all(id);
  const identity={complete:true,pages:pages.map(p=>({page_id:p.id,source_page:p.position,teacher_id:1,name_written:'Synthetic Teacher',name_confidence:'certain',grade_written:'Grade 2',subjects_written:'Science'}))};
  db.prepare('UPDATE bulk_items SET result=? WHERE id=?').run(JSON.stringify({identity}),id);
  await bulk.sortContentItem(id,{configured:()=>true,compare:async()=>comparison()});
  assert.equal(row(id).identity_review.status,'needs_review');
  assert.equal(JSON.parse(bulk.itemFor(id).result).identity.stale_source,true);
});

test('explicit all-scans scope includes completed content while default retries stale evidence only', async()=>{
  const id=await packet(1);
  await bulk.sortContentItem(id,{configured:()=>true,compare:async()=>comparison()});
  const normal=bulk.matchingPlan(1,1,[id]);
  const all=bulk.matchingPlan(1,1,[id],{includeReady:true});
  assert.equal(normal.packet_count,0); assert.equal(all.packet_count,1);
  assert.equal(all.scope,'all_scans'); assert.notEqual(normal.id,all.id);
  const source=bulk.contentSourceBasis(db.prepare('SELECT * FROM bulk_pages WHERE item_id=?').all(id),db.prepare('SELECT * FROM papers ORDER BY id').all());
  assert.match(source.engine_signature,/^[a-f0-9]{64}$/);
  assert.equal(source.request_settings.maxRetries,1); assert.equal(source.request_settings.screeningConcurrency,2);
  assert.equal(source.request_settings.limits.maxProviderAttempts,40);
  await fs.writeFile(path.join(UPLOADS_DIR,'master1.pdf'),'%PDF changed after completed content');
  assert.equal(row(id).content_match.status,'stale');
  assert.equal(bulk.matchingPlan(1,1,[id]).packet_count,1);
  assert.match(bulk.choosePapers(bulk.itemFor(id),{B:2}),/changed/);
  const queued=[];bulk.matchAll(1,1,{queue:id=>queued.push(id)});assert.ok(queued.includes(id));
});

test('failed final retains screening checkpoint for a new explicit attempt without treating it as complete',async()=>{
  const id=await packet(1), checkpoint={version:1,key:'synthetic-key',batches:[{id:1,complete:true}]};
  await assert.rejects(bulk.sortContentItem(id,{configured:()=>true,compare:async args=>{
    assert.equal(args.screeningCheckpoint,undefined);
    assert.equal(args.checkpointContext.provider,'openai');
    assert.match(args.checkpointContext.source_key,/^[a-f0-9]{64}$/);
    args.onScreeningCheckpoint(checkpoint);
    throw new Error('Synthetic final timeout');
  }}),/Synthetic final timeout/);
  assert.equal(row(id).content_match.status,'failed');assert.equal(row(id).ready,false);
  assert.equal(row(id).content_match.screening_checkpoint,undefined,'internal checkpoint must not leak into UI response');
  assert.deepEqual(JSON.parse(bulk.itemFor(id).result).content_match.screening_checkpoint,checkpoint);
  let called=0;
  await bulk.sortContentItem(id,{configured:()=>true,compare:async args=>{
    called++; assert.deepEqual(args.screeningCheckpoint,checkpoint);return comparison();
  }});
  assert.equal(called,1,'final comparison must still execute');
  assert.equal(row(id).content_match.status,'complete');
});
test('failed content attempts replace stale legacy candidate counts before comparison',async()=>{
 const id=await packet(1);
 db.prepare('UPDATE bulk_items SET result=? WHERE id=?').run(JSON.stringify({candidate_paper_ids:Array.from({length:120},(_,i)=>i+1),bank_comparison:{candidate_count:120}}),id);
 await assert.rejects(bulk.sortContentItem(id,{configured:()=>true,compare:async args=>{assert.equal(args.candidates.length,2);throw new Error('Synthetic malformed coverage');}}),/Synthetic/);
 assert.equal(row(id).compared_candidates,2);assert.equal(row(id).bank_comparison,null);
});
