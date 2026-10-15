import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'matching-bank-'));process.env.DATA_DIR=dir;
const {default:db,UPLOADS_DIR}=await import('../server/db.js');
const {importMatchingBank,matchingBankInfo,matchingBankPapers}=await import('../server/matching-bank.js');
const bulk=await import('../server/bulk.js');
await new Promise(resolve=>setImmediate(resolve));
after(async()=>{db.close();await fs.rm(dir,{recursive:true,force:true});});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pdf=id=>Buffer.from(`%PDF-1.7\nsynthetic paper ${id}\n%%EOF`);
db.prepare('INSERT INTO schools(id,name) VALUES(1,?)').run('Test school');
for(let id=1;id<=12;id++)db.prepare('INSERT INTO tests(id,school_id,name) VALUES(?,1,?)').run(id,`Test${id}`);
async function pack(ids,modify=()=>{}) {
 const zip=new JSZip();const files=ids.map((id,index)=>{const bytes=pdf(id),pdf_path=`papers/${id}.pdf`;zip.file(pdf_path,bytes);return {source_id:`source${index}`,source_url:`https://drive.google.com/file/d/source${index}/view`,source_name:`Source${index}.pdf`,source_sha256:hash(bytes),source_size_bytes:bytes.length,pdf_path,pdf_sha256:hash(bytes),page_count:1,conversion_method:'original_pdf',validation_status:'validated'};});
 const manifest={schema_version:1,source_root:'https://drive.google.com/drive/folders/confirmed',source_file_count:files.length,files};modify(manifest,zip);zip.file('manifest.json',JSON.stringify(manifest));return zip.generateAsync({type:'nodebuffer'});
}
test('exact confirmed bank excludes unrelated library masters and preserves duplicate provenance',async()=>{
 const imported=await importMatchingBank(await pack([1,1,2]),{schoolId:1,testId:1});
 assert.equal(imported.source_file_count,3);assert.equal(imported.canonical_pdf_count,2);assert.equal(imported.added,2);
 await importMatchingBank(await pack([3]),{schoolId:1,testId:2});
 assert.equal(matchingBankPapers(1,1).length,2);assert.equal(matchingBankPapers(1,3).length,3);
 assert.equal(matchingBankInfo(1,1).manifest.files.length,3);
 assert.ok(matchingBankPapers(1,1).every(p=>p.sections===''),'New matching sources cannot invent grading section labels.');
 const before=db.prepare('SELECT * FROM papers ORDER BY id').all();
 const again=await importMatchingBank(await pack([1,1,2]),{schoolId:1,testId:1,expectedBankId:imported.id});
 assert.equal(again.added,0);assert.deepEqual(db.prepare('SELECT * FROM papers ORDER BY id').all(),before);
});
test('invalid or partial pack writes nothing and retains current bank',async()=>{
 const before=db.prepare('SELECT * FROM papers ORDER BY id').all(),old=matchingBankInfo(1,1);
 await assert.rejects(importMatchingBank(await pack([4,5],(m,z)=>z.remove(m.files[1].pdf_path)),{schoolId:1,testId:1,expectedBankId:old.id}),/Missing canonical/);
 assert.equal(matchingBankInfo(1,1).id,old.id);assert.deepEqual(db.prepare('SELECT * FROM papers ORDER BY id').all(),before);
 await assert.rejects(importMatchingBank(await pack([4]),{schoolId:1,testId:1}),/bank changed/);
});
test('transaction failure rolls back new masters and files, and retry recovers',async()=>{
 const before=await fs.readdir(UPLOADS_DIR);
 db.exec("CREATE TRIGGER fail_second_matching_source BEFORE INSERT ON papers WHEN NEW.title='Source1.pdf' BEGIN SELECT RAISE(ABORT,'synthetic insertion failure'); END;");
 try {await assert.rejects(importMatchingBank(await pack([6,7]),{schoolId:1,testId:4}),/synthetic insertion failure/);} finally {db.exec('DROP TRIGGER fail_second_matching_source');}
 assert.equal(matchingBankInfo(1,4),null);assert.deepEqual(await fs.readdir(UPLOADS_DIR),before);
 const result=await importMatchingBank(await pack([6,7]),{schoolId:1,testId:4});assert.equal(result.added,2);
});
test('missing or changed configured source fails closed without all-library fallback',async()=>{
 await importMatchingBank(await pack([8]),{schoolId:1,testId:5});
 const paper=matchingBankPapers(1,5)[0],filename=path.join(UPLOADS_DIR,paper.stored_name);
 await fs.writeFile(filename,pdf(99));assert.throws(()=>matchingBankPapers(1,5),/changed/);
 assert.throws(()=>bulk.matchingPlan(1,5),/changed/);
 await fs.unlink(filename);assert.throws(()=>matchingBankPapers(1,5),/no readable PDF/);
 await fs.writeFile(filename,pdf(8));assert.equal(matchingBankPapers(1,5).length,1);
});
test('unknown bank and corrupt manifest fail closed',async()=>{
 await importMatchingBank(await pack([9]),{schoolId:1,testId:6});
 const info=matchingBankInfo(1,6);
 db.prepare('UPDATE matching_banks SET manifest_json=? WHERE id=?').run('{}',info.id);
 assert.throws(()=>matchingBankPapers(1,6),/manifest changed/);
 db.pragma('foreign_keys=OFF');db.prepare('UPDATE matching_bank_selections SET bank_id=? WHERE test_id=6').run('unknown');db.pragma('foreign_keys=ON');
 assert.throws(()=>matchingBankPapers(1,6),/missing/);
});
test('source and conversion provenance require complete verified inventory',async()=>{
 for(const modify of [m=>m.source_file_count++,m=>m.files[0].validation_status='pending',m=>m.files[0].source_sha256='f'.repeat(64),m=>m.files[0].source_id='',m=>m.files[0].pdf_path='../outside.pdf']) {
   await assert.rejects(importMatchingBank(await pack([10],modify),{schoolId:1,testId:7}));
 }
 assert.equal(matchingBankInfo(1,7),null);
});
test('selected bank and manifest hash are explicit in approval plans, and changes invalidate plan keys',async()=>{
 const first=await importMatchingBank(await pack([11]),{schoolId:1,testId:8});const plan1=bulk.matchingPlan(1,8);
 assert.equal(plan1.selected_bank.id,first.id);assert.equal(plan1.selected_bank.source_file_count,1);assert.equal(plan1.bank_manifest.length,1);
 await importMatchingBank(await pack([11,12]),{schoolId:1,testId:8,expectedBankId:first.id});const plan2=bulk.matchingPlan(1,8);
 assert.notEqual(plan1.id,plan2.id);assert.equal(plan2.bank_manifest.length,2);
});
test('bank activation invalidates completed content and checkpoint keys without changing original scans',async()=>{
 const one=await importMatchingBank(await pack([13]),{schoolId:1,testId:9});
 await fs.writeFile(path.join(UPLOADS_DIR,'answers.png'),'original answer bytes');
 const item=bulk.addItem({id:1},{id:9},'Answers.pdf',[{filename:'answers.png',mimetype:'image/png',size:21}]);
 const keys=[];
 const options={configured:()=>true,compare:async args=>{
   keys.push(args.checkpointContext.source_key);const id=args.candidates[0].id;
   return {pages:[{page:1,section:'B',paper_id:id,questions:['1'],has_answers:true}],papers:[{section:'B',paper_id:id,confidence:'high',reason:'Distinct content.',matched_question_labels:['1'],alternatives:[]}],considered_candidate_ids:args.candidates.map(p=>p.id),bank_comparison:{complete:true,candidate_count:args.candidates.length,final_compared:true,finalist_ids:[id]}};
 }};
 await bulk.sortContentItem(item,options);assert.equal(bulk.presentItem(bulk.itemFor(item)).content_match.status,'complete');
 await importMatchingBank(await pack([13,14]),{schoolId:1,testId:9,expectedBankId:one.id});
 assert.equal(bulk.presentItem(bulk.itemFor(item)).content_match.status,'stale');
 await bulk.sortContentItem(item,options);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
 assert.equal(await fs.readFile(path.join(UPLOADS_DIR,'answers.png'),'utf8'),'original answer bytes');
});
test('competing imports cannot silently overwrite an activation admitted during decompression',async()=>{
 const [a,b]=await Promise.all([pack([15]),pack([16])]);
 const results=await Promise.allSettled([importMatchingBank(a,{schoolId:1,testId:10}),importMatchingBank(b,{schoolId:1,testId:10})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/bank changed/);
});
test('matching started during decompression blocks activation before writes',async()=>{
 const bytes=await pack([17]);
 await fs.writeFile(path.join(UPLOADS_DIR,'queue.png'),'source');
 const item=bulk.addItem({id:1},{id:11},'Queued.pdf',[{filename:'queue.png',mimetype:'image/png',size:6}]);
 const pending=importMatchingBank(bytes,{schoolId:1,testId:11});
 db.prepare("UPDATE bulk_items SET sort_status='waiting' WHERE id=?").run(item);
 await assert.rejects(pending,/Matching started/);assert.equal(matchingBankInfo(1,11),null);
 db.prepare("UPDATE bulk_items SET sort_status='new' WHERE id=?").run(item);
});
test('oversized compressed manifest and false original size are rejected before import',async()=>{
 const zip=new JSZip();zip.file('manifest.json',' '.repeat(2*1024*1024+1));
 await assert.rejects(importMatchingBank(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),{schoolId:1,testId:12}),/manifest/);
 await assert.rejects(importMatchingBank(await pack([18],m=>m.files[0].source_size_bytes++),{schoolId:1,testId:12}),/Invalid or changed/);
 assert.equal(matchingBankInfo(1,12),null);
});
test('official Docs-backed DOCX links retain the source ID and reject unrelated destinations',async()=>{
 const bytes=await pack([19],m=>{m.files[0].source_name='Source.docx';m.files[0].source_url='https://docs.google.com/document/d/source0/edit?usp=drivesdk';m.files[0].conversion_method='LibreOffice verified';});
 const result=await importMatchingBank(bytes,{schoolId:1,testId:12});assert.equal(result.source_file_count,1);
 for(const source_url of ['https://docs.google.com:8443/document/d/source0/edit','https://docs.google.com/document/d/other/edit','https://docs.google.com.evil.example/document/d/source0/edit','https://drive.google.com/file/d/other/view']){
   await assert.rejects(importMatchingBank(await pack([20],m=>m.files[0].source_url=source_url),{schoolId:1,testId:12,expectedBankId:result.id}),/matching original/);
 }
});
