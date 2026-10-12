import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-evaluation-flow-'));
process.env.DATA_DIR = dir;
process.env.OPENAI_API_KEY = 'synthetic-test-only';
process.env.OPENAI_BASE_URL = 'https://synthetic.invalid/v1';
delete process.env.GEMINI_API_KEY;
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const { startEvaluation, normalise, scopeToSection } = await import('../server/evaluate.js');
const { sittingSections, gradeFor, counts, resultsBasis } = await import('../server/results.js');
const { currentSourceBasis, digest } = await import('../server/provenance.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const school = Number(db.prepare("INSERT INTO schools(name) VALUES ('Synthetic school')").run().lastInsertRowid);
const teacher = Number(db.prepare("INSERT INTO teachers(school_id, name, grade, subjects) VALUES (?, 'Example Teacher', 'Grade 5', 'Science')").run(school).lastInsertRowid);

function fixture() {
  const id = Number(db.prepare("INSERT INTO assessments(school_id, teacher_id, title, section) VALUES (?, ?, 'Synthetic sitting', 'B')").run(school, teacher).lastInsertRowid);
  for (const kind of ['question_paper', 'response']) {
    const name = `${id}-${kind}.png`;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), 'synthetic-image-bytes');
    db.prepare('INSERT INTO assessment_files(assessment_id,kind,stored_name,original_name,mime_type,position) VALUES (?,?,?,?,?,1)').run(id, kind, name, name, 'image/png');
  }
  const paperId = db.prepare("SELECT id FROM assessment_files WHERE assessment_id=? AND kind='question_paper'").get(id).id;
  const qs = [5,3,2].map((max, i) => ({ section: 'B', question: `${i + 1}`, question_text: 'Describe a classroom learning practice.', max_marks: max, source_id: `scan:${paperId}`, source_page: 1, printed_marks: `[${max}]`, expected_answer: 'Check understanding with a relevant practical example.', criteria: [{ criterion: 'Supported relevant explanation', max_marks: max }], assumptions: ['No approved scheme supplied; provisional source-based criterion.'] }));
  const response = { paper_match: 'matched', match_reason: 'Question numbers and response content align with the selected master.', page_identity: [{ page: 1, name: 'Example Teacher', status: 'consistent' }], sections: [{ section: 'B', status: 'supplied_complete', source_pages: [1], reason: 'All supplied Section B answers are present.' }], answers: [
    { row: 1, status: 'partial', teacher_answer: 'Ask pupils to explain the idea. [illegible]', source_pages: [1], uncertainty: 'Part of the handwriting is unclear.' },
    { row: 2, status: 'unanswered', teacher_answer: '', source_pages: [], uncertainty: '' },
    { row: 3, status: 'unreadable', teacher_answer: '[illegible]', source_pages: [1], uncertainty: 'The handwriting could not be read reliably.' },
  ] };
  const marks = { questions: qs.map((q,i) => ({ row:i+1, marks_awarded:i===0?3:0, feedback:i===0?'Relevant practical step; add detail.':'No readable answer to credit.', credits:[{criterion:1,marks_awarded:i===0?3:0,evidence_quote:i===0?'Ask pupils to explain the idea.':'',reason:'Supported by the extracted response.'}] })), summary:'Practice fuller explanations.', strengths:['Practical classroom step.'], areas_to_improve:['Explain the purpose of each step.'] };
  return { id, paper: { issues: [], questions: qs }, response, marks };
}
function mock(f, options = {}) {
  const calls = [];
  globalThis.fetch = async (url, req) => {
    assert.equal(String(url), 'https://synthetic.invalid/v1/responses');
    const body = JSON.parse(req.body), name = body.text.format.name;
    calls.push(name);
    if (options.fail?.(name, calls)) return new Response(JSON.stringify({error:{message:'Synthetic provider unavailable'}}), {status:401,headers:{'content-type':'application/json'}});
    let result;
    if (name === 'answer_language') result = options.language ?? { language:'english', languages:['English'], pages_swapped:false };
    else if (name === 'grounded_question_ledger') result = f.paper;
    else if (name === 'grounded_response_extraction') result = options.response ? options.response() : f.response;
    else if (name === 'grounded_criterion_marks') { options.beforeMarks?.(); result = options.marks ? options.marks() : f.marks; }
    else if (name === 'written_expression') result = options.writing ?? { sections:[{ section:'Section B',judged:false,sentence_formation:1,grammar:1,spelling_punctuation:1,vocabulary:1,summary:'' }], errors:[] };
    else throw new Error(`Unexpected model call ${name}`);
    return new Response(JSON.stringify({ status:'completed', output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}] }),{status:200,headers:{'content-type':'application/json'}});
  };
  return calls;
}
async function finished(id) {
  for (let i=0;i<300;i++) {
    const row=db.prepare('SELECT * FROM assessments WHERE id=?').get(id);
    if (row.ai_status!=='running') return row;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error('Synthetic evaluation did not finish');
}

test('actual evaluation path preserves partial/unreadable/blank distinction and source audit', async () => {
  const f=fixture(); const calls=mock(f);
  assert.equal(startEvaluation(f.id),null);
  const row=await finished(f.id); assert.equal(row.ai_status,'done',row.ai_error);
  const result=JSON.parse(row.ai_result);
  assert.deepEqual([row.score,row.max_score],[3,8]);
  assert.deepEqual(result.questions.map(q=>q.response_status),['partial','unanswered','unreadable']);
  assert.deepEqual(sittingSections(result).map(s=>[s.key,s.awarded,s.max,s.grade]),[['B',3,8,null]]);
  assert.equal(result.audit.source_digest,digest(currentSourceBasis(f.id)));
  assert.equal(result.questions[0].audit.rubric_policy,'provisional-inferred-v1');
  assert.equal(result.questions[0].qualification,'limited_readability');
  assert.equal(result.questions[2].marks_awarded,null);
  assert.equal(result.outcome,'qualified');
  assert.doesNotMatch(result.questions[0].feedback,/Source|OpenAI|extraction/i);
  assert.deepEqual(calls,['answer_language','grounded_question_ledger','grounded_response_extraction','grounded_response_extraction','grounded_criterion_marks','written_expression']);
  const corrected=normalise({...result,questions:result.questions.map((q,i)=>({...q,marks_awarded:i===0?3.5:0}))});
  assert.equal(corrected.audit.source_digest,result.audit.source_digest);
  assert.deepEqual(corrected.questions[0].question_source,result.questions[0].question_source);
});

test('unmatched responses reach a terminal no-score outcome; explicit retries read current sources afresh', async () => {
  const f=fixture(); let bad=true;
  const calls=mock(f,{response:()=>bad?{...f.response,paper_match:'mismatch'}:f.response});
  startEvaluation(f.id); let row=await finished(f.id);
  assert.equal(row.ai_status,'done'); assert.equal(row.status,'finalized'); assert.equal(row.score,null);
  assert.equal(JSON.parse(row.ai_result).outcome,'no_assessment');
  assert.equal(calls.filter(n=>n==='grounded_response_extraction').length,2);
  bad=false; startEvaluation(f.id); row=await finished(f.id);
  assert.equal(row.ai_status,'done',row.ai_error);
  assert.equal(calls.filter(n=>n==='grounded_question_ledger').length,2);
  fs.appendFileSync(path.join(UPLOADS_DIR,`${f.id}-response.png`),'changed');
  startEvaluation(f.id); row=await finished(f.id); assert.equal(row.ai_status,'done',row.ai_error);
  assert.equal(calls.filter(n=>n==='grounded_question_ledger').length,3);
});

test('source or teacher edits during the request cannot certify stale inputs', async () => {
  const f=fixture(); mock(f,{beforeMarks:()=>db.prepare("UPDATE teachers SET subjects='Mathematics' WHERE id=?").run(teacher)});
  startEvaluation(f.id); const row=await finished(f.id);
  assert.equal(row.ai_status,'failed'); assert.match(row.ai_error,/changed during evaluation/); assert.equal(row.ai_result,null);
  db.prepare("UPDATE teachers SET subjects='Science' WHERE id=?").run(teacher);
});

test('supplied all-blank section scores zero; entire absent section is excluded consistently', () => {
  const result=normalise({marking:'standard',submission:{sections:[{section:'A',status:'supplied_complete',source_pages:[1]},{section:'B',status:'not_supplied',source_pages:[]}]},questions:[
    {section:'Section A',question:'1',teacher_answer:'',max_marks:10,marks_awarded:0,response_status:'unanswered'},
    {section:'Section B',question:'1',teacher_answer:'',max_marks:35,marks_awarded:0,response_status:'section_not_supplied'},
  ]});
  assert.deepEqual([result.total_score,result.max_score],[0,10]);
  assert.deepEqual(sittingSections(result).map(s=>[s.key,s.percent,s.grade]),[['A',0,'D']]);
  assert.equal(counts(result.questions[0],'lenient'),true);
  assert.equal(counts(result.questions[1],'standard'),false);
});

test('section mismatch is rejected, grade boundaries and cache basis remain consistent', () => {
  assert.throws(()=>scopeToSection([{section:'Section A'}],'B'),/No questions identify/);
  assert.equal(gradeFor(84.99).grade,'B'); assert.equal(gradeFor(85).grade,'A');
  const result=normalise({questions:[{section:'Section A',question:'1',teacher_answer:'Answer',max_marks:100,marks_awarded:84.6}]});
  const sections=sittingSections(result); assert.equal(sections[0].percent,84.6); assert.equal(sections[0].grade,'B');
  const before=digest(resultsBasis(sections)); sections[0].questions[0].expected_answer='New guidance';
  assert.notEqual(digest(resultsBasis(sections)),before);
});

test('incompatible level or subject yields a terminal artifact with no model calls or invented marks', () => {
  const f=fixture();
  fs.writeFileSync(path.join(UPLOADS_DIR,'incompatible.pdf'),'%PDF-synthetic');
  const paperId=Number(db.prepare("INSERT INTO papers(title,sections,subject,levels,stored_name,original_name) VALUES ('Synthetic Secondary Science','B','Science','secondary','incompatible.pdf','incompatible.pdf')").run().lastInsertRowid);
  db.prepare('INSERT INTO assessment_papers(assessment_id,paper_id,position) VALUES (?,?,0)').run(f.id,paperId);
  const calls=mock(f);
  assert.equal(startEvaluation(f.id),null); assert.equal(calls.length,0);
  let saved=JSON.parse(db.prepare('SELECT ai_result FROM assessments WHERE id=?').get(f.id).ai_result);
  assert.equal(saved.outcome,'no_assessment'); assert.match(saved.audit.diagnostics[0],/different school level/);
  db.prepare("UPDATE papers SET levels='primary',subject='History' WHERE id=?").run(paperId);
  assert.equal(startEvaluation(f.id),null); assert.equal(calls.length,0);
  saved=JSON.parse(db.prepare('SELECT ai_result FROM assessments WHERE id=?').get(f.id).ai_result);
  assert.match(saved.audit.diagnostics[0],/different subject/);
});

test('a contradictory written name cannot be certified by model status consistent', async () => {
  const f=fixture(); f.response.page_identity[0].name='Completely Different'; mock(f);
  startEvaluation(f.id); const row=await finished(f.id);
  assert.equal(row.ai_status,'done'); assert.equal(row.status,'finalized'); assert.equal(row.score,null);
  const result=JSON.parse(row.ai_result);
  assert.deepEqual(result.audit.excluded_response_pages,[1]);
  assert.ok(result.questions.every(q=>q.marks_awarded===null && q.teacher_answer===''));
  assert.deepEqual(result.writing.sections,[]);
});


test('focused reread can resolve uncertainty but never erase a definite teacher conflict', async () => {
  for (const status of ['uncertain','conflict']) {
    const f=fixture(); let pass=0;
    mock(f,{response:()=>{
      const r=structuredClone(f.response);
      if (++pass===1) r.page_identity[0]={page:1,name:status==='conflict'?'Other Person':'',status};
      return r;
    }});
    startEvaluation(f.id); const row=await finished(f.id); const result=JSON.parse(row.ai_result);
    assert.equal(pass,2);
    assert.equal(row.score,status==='conflict'?null:3);
    assert.deepEqual(result.audit.excluded_response_pages,status==='conflict'?[1]:[]);
  }
});

test('malformed focused output retains prior safe evidence, with newly discovered conflicts applied', async () => {
  for (const conflict of [false,true]) {
    const f=fixture(); let pass=0;
    mock(f,{response:()=>{
      const r=structuredClone(f.response);
      if (++pass===2) { r.answers=[]; if(conflict)r.page_identity[0]={page:1,name:'Other Person',status:'conflict'}; }
      return r;
    }});
    startEvaluation(f.id); const row=await finished(f.id); const result=JSON.parse(row.ai_result);
    assert.equal(row.ai_status,'done'); assert.equal(row.score,conflict?null:3);
    assert.equal(result.audit.resolution_attempts.length,2);
    if(conflict)assert.ok(result.questions.every(q=>!q.teacher_answer&&q.marks_awarded===null));
  }
});

test('a weaker reread preserves supported content but cannot revive it under a definite mismatch', async () => {
  for(const mismatch of [false,true]) {
    const f=fixture(); let pass=0;
    mock(f,{response:()=>{
      const r=structuredClone(f.response);
      if(++pass===2){r.answers[0].status='unreadable';r.answers[0].teacher_answer='[illegible]';if(mismatch)r.paper_match='mismatch';}
      return r;
    }});
    startEvaluation(f.id);const row=await finished(f.id), result=JSON.parse(row.ai_result);
    assert.equal(row.score,mismatch?null:3);
    assert.equal(sittingSections(result)[0].grade,null);
    if(mismatch)assert.ok(result.questions.every(q=>q.teacher_answer===''));
    else assert.match(result.questions[0].teacher_answer,/Ask pupils/);
  }
});

test('answered with an illegible marker remains qualified, not a complete grade', async()=>{
  const f=fixture();f.response.answers[0].status='answered';mock(f);
  startEvaluation(f.id);const result=JSON.parse((await finished(f.id)).ai_result);
  assert.equal(result.questions[0].qualification,'limited_readability');
  assert.equal(sittingSections(result)[0].grade,null);
});

test('all-provider failure finishes with a metadata-only no-assessment outcome',async()=>{
  const f=fixture();const calls=mock(f,{fail:()=>true});
  startEvaluation(f.id);const row=await finished(f.id),result=JSON.parse(row.ai_result);
  assert.equal(row.ai_status,'done');assert.equal(row.status,'finalized');
  assert.equal(row.score,null);assert.equal(row.max_score,null);assert.deepEqual(result.questions,[]);
  assert.equal(result.completion.state,'no_assessment');assert.ok(result.audit.diagnostics.length);
  assert.equal(calls.length,2); // Language fails once, paper fails once; no invented downstream calls.
});

test('marking outage preserves verified blanks but never turns readable responses into zero',async()=>{
  const f=fixture();mock(f,{fail:name=>name==='grounded_criterion_marks'});
  startEvaluation(f.id);const row=await finished(f.id),result=JSON.parse(row.ai_result);
  assert.deepEqual(result.questions.map(q=>q.marks_awarded),[null,0,null]);
  assert.deepEqual([row.score,row.max_score],[0,3]);assert.equal(sittingSections(result)[0].grade,null);
});

test('missing multilingual reader falls back to original images instead of abandoning evidence',async()=>{
  const f=fixture();mock(f,{language:{language:'not_english',languages:['Hindi'],pages_swapped:false}});
  startEvaluation(f.id);const row=await finished(f.id),result=JSON.parse(row.ai_result);
  assert.equal(row.score,3);assert.equal(result.reading.read_by,'openai');
  assert.ok(result.audit.diagnostics.some(x=>/Gemini/.test(x)));
});

test('writing survives mixed answered, blank and unreadable rows using the full immutable basis',async()=>{
  const f=fixture();f.response.answers[0].teacher_answer='They is ready. Ask pupils to explain the idea using examples from their own daily experiences and encourage every learner to discuss a practical solution with classmates before sharing a clear explanation with the whole class.';
  f.marks.questions[0].credits[0].evidence_quote='Ask pupils to explain the idea';
  const writing={sections:[{section:'Section B',judged:true,sentence_formation:4,grammar:4,spelling_punctuation:4,vocabulary:4,summary:'Clear explanations with one agreement error.'}],errors:[{section:'Section B',question:'1',type:'Grammar',wrote:'They is ready.',problem:'Subject and verb agreement.',correction:'They are ready.'}]};
  mock(f,{writing});startEvaluation(f.id);const result=JSON.parse((await finished(f.id)).ai_result);
  assert.equal(result.writing.problem,undefined);assert.equal(result.writing.sections[0].score,8);
  assert.equal(result.writing.errors[0].wrote,'They is ready.');
});

test('unresolved sibling pages prevent apparent omitted answers being graded as complete blanks',async()=>{
  const f=fixture();db.prepare("UPDATE assessment_files SET source_metadata=? WHERE assessment_id=? AND kind='response'").run(JSON.stringify({unresolved_sibling_pages:[{source_page:2,reason_code:'unassigned'}]}),f.id);
  mock(f);startEvaluation(f.id);const row=await finished(f.id),result=JSON.parse(row.ai_result);
  assert.equal(result.questions[1].response_status,'missing_page');assert.equal(result.questions[1].marks_awarded,null);
  assert.deepEqual([row.score,row.max_score],[3,5]);assert.equal(sittingSections(result)[0].grade,null);
});


test('inconsistent inferred rubric cannot rescale printed maxima or erase valid other rows',async()=>{
  const f=fixture();f.paper.questions[1].criteria[0].max_marks=99;
  f.response.answers[1]={row:2,status:'answered',teacher_answer:'A practical classroom activity.',source_pages:[1],uncertainty:''};
  const calls=mock(f);startEvaluation(f.id);const row=await finished(f.id),result=JSON.parse(row.ai_result);
  assert.equal(calls.filter(n=>n==='grounded_question_ledger').length,2);
  assert.deepEqual(result.questions.map(q=>q.max_marks),[5,3,2]);
  assert.deepEqual(result.questions.map(q=>q.marks_awarded),[3,null,null]);
  assert.equal(result.questions[1].response_status,'paper_unavailable');assert.equal(result.questions[1].teacher_answer,'');
  assert.match(result.questions[1].audit.paper_issue,/rubric/);
  assert.deepEqual([row.score,row.max_score],[3,5]);assert.equal(sittingSections(result)[0].grade,null);
});

test('invalid scoring in one row cannot manufacture zero or erase independent valid credit',async()=>{
  const f=fixture();f.response.answers[1]={row:2,status:'answered',teacher_answer:'Use a worked example.',source_pages:[1],uncertainty:''};
  f.marks.questions[1]={row:2,marks_awarded:2,feedback:'A useful example.',credits:[{criterion:1,marks_awarded:2,evidence_quote:'Use a worked example.',reason:''}]};
  f.marks.questions[0].credits[0].evidence_quote='Invented answer not in transcription';
  const calls=mock(f);startEvaluation(f.id);const row=await finished(f.id),result=JSON.parse(row.ai_result);
  assert.equal(calls.filter(n=>n==='grounded_criterion_marks').length,2);
  assert.deepEqual(result.questions.map(q=>q.marks_awarded),[null,2,null]);
  assert.deepEqual([row.score,row.max_score],[2,3]);assert.equal(sittingSections(result)[0].grade,null);
});
