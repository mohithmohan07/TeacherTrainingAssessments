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
    let result;
    if (name === 'answer_language') result = { language:'english', languages:['English'], pages_swapped:false };
    else if (name === 'grounded_question_ledger') result = f.paper;
    else if (name === 'grounded_response_extraction') result = options.response ? options.response() : f.response;
    else if (name === 'grounded_criterion_marks') { options.beforeMarks?.(); result = f.marks; }
    else if (name === 'written_expression') result = { sections:[{ section:'Section B',judged:false,sentence_formation:1,grammar:1,spelling_punctuation:1,vocabulary:1,summary:'' }], errors:[] };
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
  assert.deepEqual([row.score,row.max_score],[3,10]);
  assert.deepEqual(result.questions.map(q=>q.response_status),['partial','unanswered','unreadable']);
  assert.deepEqual(sittingSections(result).map(s=>[s.key,s.awarded,s.max,s.grade]),[['B',3,10,'D']]);
  assert.equal(result.audit.source_digest,digest(currentSourceBasis(f.id)));
  assert.equal(result.questions[0].audit.rubric_policy,'provisional-inferred-v1');
  assert.match(result.questions[0].feedback,/handwriting is unclear/);
  assert.deepEqual(calls,['answer_language','grounded_question_ledger','grounded_response_extraction','grounded_criterion_marks','written_expression']);
  const corrected=normalise({...result,questions:result.questions.map((q,i)=>({...q,marks_awarded:i===0?3.5:0}))});
  assert.equal(corrected.audit.source_digest,result.audit.source_digest);
  assert.deepEqual(corrected.questions[0].question_source,result.questions[0].question_source);
});

test('failed response match resumes validated prior stages only for the same content', async () => {
  const f=fixture(); let bad=true;
  const calls=mock(f,{response:()=>bad?{...f.response,paper_match:'mismatch'}:f.response});
  startEvaluation(f.id); let row=await finished(f.id);
  assert.equal(row.ai_status,'failed'); assert.match(row.ai_error,/alignment.*mismatch/); assert.equal(row.ai_result,null);
  bad=false; startEvaluation(f.id); row=await finished(f.id);
  assert.equal(row.ai_status,'done',row.ai_error);
  assert.equal(calls.filter(n=>n==='grounded_question_ledger').length,1);
  fs.appendFileSync(path.join(UPLOADS_DIR,`${f.id}-response.png`),'changed');
  startEvaluation(f.id); row=await finished(f.id); assert.equal(row.ai_status,'done',row.ai_error);
  assert.equal(calls.filter(n=>n==='grounded_question_ledger').length,2);
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

test('individual evaluation rejects an incompatible level or subject before model calls', () => {
  const f=fixture();
  fs.writeFileSync(path.join(UPLOADS_DIR,'incompatible.pdf'),'%PDF-synthetic');
  const paperId=Number(db.prepare("INSERT INTO papers(title,sections,subject,levels,stored_name,original_name) VALUES ('Synthetic Secondary Science','B','Science','secondary','incompatible.pdf','incompatible.pdf')").run().lastInsertRowid);
  db.prepare('INSERT INTO assessment_papers(assessment_id,paper_id,position) VALUES (?,?,0)').run(f.id,paperId);
  const calls=mock(f);
  assert.match(startEvaluation(f.id),/different school level/); assert.equal(calls.length,0);
  db.prepare("UPDATE papers SET levels='primary',subject='History' WHERE id=?").run(paperId);
  assert.match(startEvaluation(f.id),/different subject/); assert.equal(calls.length,0);
});

test('a contradictory written name cannot be certified by model status consistent', async () => {
  const f=fixture(); f.response.page_identity[0].name='Completely Different'; mock(f);
  startEvaluation(f.id); const row=await finished(f.id);
  assert.equal(row.ai_status,'failed'); assert.match(row.ai_error,/different teacher/); assert.equal(row.ai_result,null);
});
