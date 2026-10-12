import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tta-writing-coverage-'));
process.env.DATA_DIR=dir;
const {default:db}=await import('../server/db.js');
const {teacherWriting,schoolWriting,writingExamples,WRITING_CRITERIA}=await import('../server/writing.js');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
const section=(state,score)=>({coverage:{state},grade_eligible:state==='complete',writing:{judged:true,score,criteria:WRITING_CRITERIA.map(c=>({label:c.label,score:score/2})),errors:[{type:'Grammar',problem:`${state} issue`,wrote:'They is',correction:'They are'}]}});
test('partial writing remains available individually but cannot bias comparative writing aggregates',()=>{
 const complete=section('complete',8), partial=section('partial',2);
 assert.equal(partial.writing.score,2);
 assert.equal(teacherWriting([partial]),null);
 assert.equal(teacherWriting([complete,partial]).score,8);
 const school=schoolWriting([{name:'A',sections:[complete,partial]},{name:'B',sections:[partial]}]);
 assert.equal(school.teachers,1);assert.equal(school.average,8);
 assert.ok(school.criteria.every(c=>c.average===4));
 assert.deepEqual(school.types,[{type:'Grammar',errors:1,teachers:1}]);
 assert.ok(writingExamples([{sections:[complete,partial]}]).every(x=>!x.includes('partial')));
});
test('legacy writing aggregate behavior is retained without typed coverage',()=>{
 const legacy=section('complete',8);delete legacy.coverage;delete legacy.grade_eligible;
 assert.equal(teacherWriting([legacy]).score,8);
});
