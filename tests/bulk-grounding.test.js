import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated synthetic data only. No network/model requests or production DB.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assessment-bulk-grounding-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.GEMINI_API_KEY = '';
const { default: db } = await import('../server/db.js');
const bulk = await import('../server/bulk.js');
await new Promise((resolve) => setImmediate(resolve));
after(async () => { db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });

const school = { id: 1, name: 'Synthetic School' };
const teacher = { id: 1, school_id: 1, name: 'Anita Rao', grade: 'Class 4', subjects: 'Mathematics' };
const other = { id: 2, school_id: 1, name: 'Beena Shah', grade: 'Class 4', subjects: 'Mathematics' };
const namesake = { id: 3, school_id: 1, name: 'Anita Rao', grade: 'Class 8', subjects: 'Science' };
const teachers = [teacher, other, namesake];
const paper = (id, extra = {}) => ({ id, title: `Primary Mathematics Section B Master ${id}`, sections: 'B', levels: 'primary', subject: 'Mathematics', board: '', language: 'English', priority: 0, stored_name: `master-${id}.pdf`, original_name: `master-${id}.pdf`, ...extra });
const library = [paper(1), paper(2), paper(3, { levels: 'secondary', priority: 100 }), paper(4, { sections: 'A', subject: '', title: 'Primary Section A' }), paper(5, { subject: 'Science' })];
db.prepare('INSERT INTO schools (id, name) VALUES (?, ?)').run(school.id, school.name);
db.prepare('INSERT INTO tests (id, school_id, name) VALUES (1, 1, ?)').run('Synthetic Test');
for (const t of teachers) db.prepare('INSERT INTO teachers (id, school_id, name, grade, subjects) VALUES (@id, @school_id, @name, @grade, @subjects)').run(t);
for (const p of library) db.prepare('INSERT INTO papers (id, title, sections, levels, subject, board, language, priority, stored_name, original_name) VALUES (@id, @title, @sections, @levels, @subject, @board, @language, @priority, @stored_name, @original_name)').run(p);
const pagesFor = (id) => db.prepare('SELECT * FROM bulk_pages WHERE item_id = ? ORDER BY position').all(id);
const view = (id) => bulk.presentItem(bulk.itemFor(id));
const pageLook = (number, t = teacher, extra = {}) => ({ page: number, name_written: t?.name ?? '', teacher_id: t?.id ?? 0, grade_written: t?.grade ?? '', subjects_written: t?.subjects ?? '', name_confidence: t ? 'certain' : 'none', paper_title_written: '', language: 'english', languages: ['English'], ...extra });
const sortPage = (number, extra = {}) => ({ page: number, section: 'B', paper_id: 1, questions: ['5A'], has_answers: true, ...extra });
const summary = (extra = {}) => ({ section: 'B', paper_id: 1, confidence: 'high', reason: 'The answer addresses the exact problem in question 5A.', matched_question_labels: ['5A'], alternatives: [], ...extra });
function resultFor(item, pages, looks = pages.map((_, i) => pageLook(i + 1)), extra = {}) {
  return { identity: bulk.inspectIdentity(item, pages, { pages: looks }, teachers), candidate_paper_ids: library.map((p) => p.id), paper_confirmations: {}, notes: [], sections: {}, ...extra };
}
function seedReady({ fileName = 'Anita Rao Class 4 Mathematics.pdf', owner = teacher, looks, sorted, extra } = {}) {
  const id = bulk.addItem(school, { id: 1 }, fileName, [1, 2].map((n) => ({ filename: `synthetic-${Math.random()}-p${n}.jpg`, mimetype: 'image/jpeg', size: 3 })));
  db.prepare("UPDATE bulk_items SET teacher_id = ?, sort_status = 'done', matched_by = 'file' WHERE id = ?").run(owner.id, id);
  const item = bulk.itemFor(id), pages = pagesFor(id);
  const result = resultFor(item, pages, looks, extra);
  bulk.saveSort(id, owner, school, library, pages, sorted ?? { pages: [sortPage(1), sortPage(2)], papers: [summary()] }, result);
  return { id, pages, result };
}

// Identity matching never makes a first-name/initial/fuzzy best guess.
test('full names and initials are mandatory for automatic filename identity', () => {
  const roster = [{ id: 10, name: 'Archana B M' }, { id: 11, name: 'Archana B N' }];
  assert.equal(bulk.teacherFromFileName('Archana answers.pdf', roster), null);
  assert.equal(bulk.teacherFromFileName('Archana_B.M answers.pdf', roster)?.id, 10);
  assert.equal(bulk.teacherFromFileName('Archna_B.M answers.pdf', roster), null);
  assert.equal(bulk.teacherFromFileName('Archana B M and Archana B N.pdf', roster), null);
  assert.equal(bulk.nameMatch('Archana B M', 'Archana answers bm.pdf'), 1);
});

test('namesakes require full name with matching class or subject context', () => {
  assert.equal(bulk.teacherFromFileName('Anita Rao.pdf', teachers), null);
  assert.equal(bulk.teacherFromFileName('Anita Rao Class 4 Mathematics.pdf', teachers)?.id, teacher.id);
  const sameLevel = [{ ...teacher }, { ...teacher, id: 9, grade: 'Class 5' }];
  assert.equal(bulk.teacherFromFileName('Anita Rao Class 4.pdf', sameLevel)?.id, teacher.id);
  const evidence = bulk.inspectIdentity({ file_name: 'scan.pdf' }, [{ id: 10, position: 7 }], { pages: [pageLook(1, namesake)] }, teachers);
  assert.equal(evidence.pages[0].teacher_id, namesake.id);
  assert.equal(evidence.pages[0].source_page, 7);
});

test('model ID cannot override the name written on an individual page', () => {
  const evidence = bulk.inspectIdentity({ file_name: 'scan.pdf' }, [{ id: 10, position: 1 }], { pages: [pageLook(1, other, { teacher_id: teacher.id })] }, teachers);
  assert.equal(evidence.pages[0].teacher_id, other.id);
  assert.equal(evidence.pages[0].reported_teacher_id, teacher.id);
});

test('mixed teachers are blocked by real filing path even after selecting one teacher', () => {
  const { id, pages } = seedReady({ looks: [pageLook(1), pageLook(2, other)] });
  assert.match(view(id).problems.join(' '), /different teachers/);
  assert.equal(bulk.chooseTeacher(bulk.itemFor(id), teacher.id), null);
  const denied = bulk.fileReady(1, 1, [id]);
  assert.equal(denied.filed.length, 0);
  assert.equal(denied.left.length, 1);
  assert.ok(bulk.itemFor(id));
  bulk.choosePageSections(bulk.itemFor(id), [{ id: pages[1].id, section: null }]);
  assert.equal(view(id).ready, true);
  const filed = bulk.fileReady(1, 1, [id]);
  assert.equal(filed.filed[0].pages, 1);
});

test('filename/sheet conflict blocks filing until explicit correct identity selection', () => {
  const { id } = seedReady({ looks: [pageLook(1, other), pageLook(2, other)] });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /different teacher/);
  bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
  assert.equal(view(id).ready, false);
  bulk.chooseTeacher(bulk.itemFor(id), other.id);
  assert.equal(view(id).ready, true);
});

test('ambiguous full name cannot be auto-filed; explicit namesake choice resolves it', () => {
  const { id } = seedReady({ fileName: 'Anita Rao.pdf', looks: [pageLook(1, teacher, { grade_written: '', subjects_written: '' }), pageLook(2, null)] });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /ambiguous|more than one/);
  bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
  assert.equal(view(id).ready, true);
});

test('missing or duplicated identity pages and legacy whole-PDF guesses cannot be waived', () => {
  for (const looks of [[pageLook(1)], [pageLook(1), pageLook(1)]]) {
    const { id } = seedReady({ looks });
    bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
    assert.match(view(id).problems.join(' '), /every source page/);
    assert.equal(bulk.fileReady(1, 1, [id]).filed.length, 0);
  }
  const { id } = seedReady();
  db.prepare('UPDATE bulk_items SET result = ? WHERE id = ?').run(JSON.stringify({ name_written: teacher.name, sheet_teacher_id: teacher.id }), id);
  assert.equal(view(id).ready, false);
});

test('candidate filtering rejects wrong levels, sections, subjects and boards regardless of priority', () => {
  assert.equal(bulk.candidatePapers(teacher, school, [library[2]]).length, 0);
  assert.match(bulk.paperCompatibilityProblem(library[2], teacher, school, 'B'), /school level/);
  assert.match(bulk.paperCompatibilityProblem(library[3], teacher, school, 'B'), /no Section B/);
  assert.match(bulk.paperCompatibilityProblem(library[4], teacher, school, 'B'), /different subject/);
  assert.match(bulk.paperCompatibilityProblem(paper(20, { board: 'ICSE' }), { ...teacher, grade: 'CBSE Class 4' }, school, 'B'), /different board/);
  assert.deepEqual(bulk.candidatePapers(teacher, school, library).map((p) => p.id).sort(), [1, 2, 4]);
});

test('every compatible master remains a candidate regardless of ranking', () => {
  const variants = Array.from({ length: 9 }, (_, i) => paper(i + 30, { priority: 20 - i }));
  assert.equal(bulk.candidatePapers(teacher, school, variants).length, 9);
  assert.equal(bulk.candidatePapers(teacher, school, variants).some((p) => p.id === 38), true);
  assert.equal(bulk.candidatePapers(teacher, school, variants, [38]).some((p) => p.id === 38), true);
  assert.equal(bulk.namedMaster(variants[8].title, variants).paper.id, 38);
  assert.equal(bulk.namedMaster('Mathematics', variants).ambiguous, true);
});

test('weak, ambiguous, incompatible and unseen paper choices are not auto-selected', () => {
  for (const scenario of [
    { papers: [summary({ confidence: 'medium' })] },
    { papers: [summary({ alternatives: [2] })] },
    { papers: [summary({ matched_question_labels: [] })] },
    { pages: [sortPage(1, { paper_id: 3 }), sortPage(2, { paper_id: 3 })], papers: [summary({ paper_id: 3 })] },
    { pages: [sortPage(1, { paper_id: 999 }), sortPage(2, { paper_id: 999 })], papers: [summary({ paper_id: 999 })] },
  ]) {
    const { id } = seedReady({ sorted: { pages: [sortPage(1), sortPage(2)], ...scenario } });
    assert.equal(JSON.parse(bulk.itemFor(id).papers).B, null);
    assert.equal(view(id).ready, false);
  }
  const { id } = seedReady({ extra: { candidate_paper_ids: [2] } });
  assert.equal(view(id).ready, false);
});

test('unresolved master retains its explanation without claiming an unsupplied paper was selected', () => {
  const reason = 'None of the supplied science masters contains these response questions.';
  const { id } = seedReady({ sorted: {
    pages: [sortPage(1, { paper_id: 0 }), sortPage(2, { paper_id: 0 })],
    papers: [summary({ paper_id: 0, confidence: 'low', reason, alternatives: [1, 2] })],
  } });
  const shown = view(id);
  for (const page of shown.pages) {
    assert.equal(page.match.paper_id, null);
    assert.equal(page.match.summary_count, 1);
    assert.equal(page.match.reason, reason);
    assert.equal(page.match.confidence, 'low');
    assert.deepEqual(page.match.alternatives, [1, 2]);
    assert.match(page.match.issues.join(' '), /master remains unresolved/);
    assert.doesNotMatch(page.match.issues.join(' '), /selected paper was not supplied/);
  }
  assert.equal(shown.ready, false);
  assert.equal(JSON.parse(bulk.itemFor(id).papers).B, null);
  assert.equal(bulk.fileReady(1, 1, [id]).filed.length, 0);
});

test('unresolved master cannot become ready from a high-confidence sentinel summary', () => {
  const { id } = seedReady({ sorted: {
    pages: [sortPage(1, { paper_id: 0 }), sortPage(2, { paper_id: 0 })],
    papers: [summary({ paper_id: 0 })],
  } });
  assert.equal(view(id).ready, false);
  assert.equal(JSON.parse(bulk.itemFor(id).papers).B, null);
  assert.equal(bulk.fileReady(1, 1, [id]).filed.length, 0);
});

test('positive unseen master still reports missing full comparison evidence', () => {
  const { id } = seedReady({ extra: { candidate_paper_ids: [2] } });
  assert.match(view(id).pages[0].match.issues.join(' '), /selected paper was not supplied in full/);
  assert.equal(view(id).ready, false);
});

test('unknown Section B page is not inherited into the preceding paper', () => {
  const { id } = seedReady({ sorted: { pages: [sortPage(1), sortPage(2, { paper_id: 0 })], papers: [summary()] } });
  const shown = view(id);
  assert.equal(shown.pages[0].section, 'B');
  assert.equal(shown.pages[1].section, 'B2');
  assert.equal(shown.ready, false);
  assert.equal(JSON.parse(bulk.itemFor(id).papers).B2, null);
});

test('source-named master rejects alternate papers even when manually selected', () => {
  const { id } = seedReady({ looks: [pageLook(1, teacher, { paper_title_written: library[1].title }), pageLook(2)] });
  assert.equal(view(id).ready, false);
  bulk.choosePapers(bulk.itemFor(id), { B: 1 });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /disagrees with the paper title/);
  bulk.choosePapers(bulk.itemFor(id), { B: 2 });
  assert.equal(view(id).ready, true);
});

test('confirmed administered master survives rematching without silent replacement', () => {
  const { id, pages, result } = seedReady({ extra: { paper_confirmations: { B: 2 } } });
  assert.equal(JSON.parse(bulk.itemFor(id).papers).B, 2);
  assert.equal(view(id).ready, false);
  assert.match(JSON.parse(bulk.itemFor(id).result).sections.B.reason, /confirmed administered master/);
  bulk.choosePapers(bulk.itemFor(id), { B: 2 });
  assert.equal(view(id).ready, true);
  assert.equal(JSON.parse(bulk.itemFor(id).result).source_pages[0].paper_id, 1);
  assert.equal(bulk.choosePapers(bulk.itemFor(id), { B: 3 })?.includes('different school level'), true);
  assert.equal(JSON.parse(bulk.itemFor(id).papers).B, 2);
});

test('unresolved answer pages require explicit exclusion instead of disappearing', () => {
  const { id, pages } = seedReady({ sorted: { pages: [sortPage(1), sortPage(2, { section: 'none', paper_id: 0, questions: [] })], papers: [summary()] } });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /unresolved/);
  bulk.choosePageSections(bulk.itemFor(id), [{ id: pages[1].id, section: null }]);
  assert.equal(view(id).ready, true);
});

test('filed pages retain original PDF page numbers and identity/master audit evidence', () => {
  const { id, pages } = seedReady({ fileName: 'Original scan batch.pdf' });
  bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
  bulk.choosePapers(bulk.itemFor(id), { B: 1 });
  bulk.choosePageSections(bulk.itemFor(id), [{ id: pages[0].id, section: null }]);
  const filed = bulk.fileReady(1, 1, [id]);
  assert.equal(filed.left.length, 0);
  assert.equal(filed.filed.length, 1);
  const row = db.prepare('SELECT * FROM assessment_files WHERE stored_name = ?').get(pages[1].stored_name);
  assert.equal(row.original_name, 'Original scan batch.pdf - source page 2.jpg');
  const source = JSON.parse(row.source_metadata);
  assert.equal(source.source_page, 2);
  assert.equal(source.source_file, 'Original scan batch.pdf');
  assert.equal(source.identity.name_written, teacher.name);
  assert.equal(source.administered_paper_id, 1);
  assert.equal(source.original_match.questions[0], '5A');
  assert.equal(source.identity_confirmed, true);
  assert.equal(source.paper_confirmed, true);
  assert.equal(bulk.itemFor(id), null);
});

test('concurrency is capped by configured maximum and available memory', () => {
  assert.equal(bulk.boundedConcurrency(undefined, 100), 3);
  assert.equal(bulk.boundedConcurrency('0', 100), 3);
  assert.equal(bulk.boundedConcurrency('bad', 100), 3);
  assert.equal(bulk.boundedConcurrency('2', 100), 2);
  assert.equal(bulk.boundedConcurrency('20', 1), 1);
});

const addAssessment = (extra = {}) => {
  const row = { title: 'Synthetic queued assessment', ai_status: 'none', ai_error: null, status: 'draft', evaluation_queue: null, ...extra };
  return Number(db.prepare('INSERT INTO assessments (school_id, teacher_id, test_id, title, ai_status, ai_error, status, evaluation_queue) VALUES (1, 1, 1, @title, @ai_status, @ai_error, @status, @evaluation_queue)').run(row).lastInsertRowid);
};

test('150 persisted evaluations resume once, deduplicate and stay within three concurrent jobs', async () => {
  const ids = Array.from({ length: 150 }, () => addAssessment());
  const original = bulk.createEvaluationQueue({ start: () => { throw new Error('Original queue must never start'); }, retain: () => {} });
  assert.equal(original.enqueue([...ids, ...ids], 'standard'), 150);
  assert.equal(original.enqueue(ids, 'standard'), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE evaluation_queue IS NOT NULL').get().n, 150);
  let concurrent = 0, maximum = 0;
  const calls = [];
  const resumed = bulk.createEvaluationQueue({
    concurrency: 3,
    retain: () => {},
    start: (id, marking) => {
      assert.equal(marking, 'standard');
      assert.equal(JSON.parse(db.prepare('SELECT evaluation_queue FROM assessments WHERE id = ?').get(id).evaluation_queue).state, 'running');
      calls.push(id);
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      db.prepare("UPDATE assessments SET ai_status = 'running' WHERE id = ?").run(id);
      return null;
    },
    wait: async (id) => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(db.prepare('SELECT evaluation_queue FROM assessments WHERE id = ?').get(id).evaluation_queue, 'intent survives until terminal result');
      db.prepare("UPDATE assessments SET ai_status = 'done' WHERE id = ?").run(id);
      concurrent -= 1;
    },
  });
  assert.equal(resumed.restore(), 150);
  assert.equal(resumed.restore(), 150);
  resumed.pump();
  assert.equal(resumed.active().length, 3);
  assert.equal(resumed.enqueue(ids, 'standard'), 0);
  await resumed.idle();
  assert.equal(calls.length, 150);
  assert.equal(new Set(calls).size, 150);
  assert.equal(maximum, 3);
  assert.equal(resumed.queued().length, 0);
  assert.equal(resumed.active().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE evaluation_queue IS NOT NULL').get().n, 0);
});

test('restart resumes interrupted work, preserves checkpoints, and never reruns committed terminal jobs', async () => {
  const request = (state) => JSON.stringify({ marking: 'standard', state });
  const completed = addAssessment({ ai_status: 'done', evaluation_queue: request('running') });
  const terminalFailed = addAssessment({ ai_status: 'failed', ai_error: 'Unreadable source.', evaluation_queue: request('running') });
  const interrupted = addAssessment({ ai_status: 'failed', ai_error: 'The server restarted while this was being marked.', evaluation_queue: request('running') });
  const reEvaluate = addAssessment({ ai_status: 'done', status: 'evaluated', evaluation_queue: request('queued') });
  db.prepare('UPDATE assessments SET evaluation_checkpoint = ? WHERE id = ?').run('{"retained":"rubric"}', interrupted);
  const calls = [];
  const resumed = bulk.createEvaluationQueue({ retain: () => {}, start: (id) => {
    calls.push(id);
    if (id === interrupted) return 'Synthetic retry requires review.';
    db.prepare("UPDATE assessments SET ai_status = 'done' WHERE id = ?").run(id);
    return null;
  } });
  assert.equal(resumed.restore(), 2);
  resumed.pump();
  await resumed.idle();
  assert.deepEqual(calls.sort((a, b) => a - b), [interrupted, reEvaluate]);
  for (const id of [completed, terminalFailed, interrupted, reEvaluate]) assert.equal(db.prepare('SELECT evaluation_queue FROM assessments WHERE id = ?').get(id).evaluation_queue, null);
  const failed = db.prepare('SELECT * FROM assessments WHERE id = ?').get(interrupted);
  assert.equal(failed.ai_status, 'failed');
  assert.equal(failed.evaluation_checkpoint, '{"retained":"rubric"}');
});

test('failed re-evaluation of a previously evaluated sitting remains visible for retry', () => {
  const id = addAssessment({ ai_status: 'failed', ai_error: 'A synthetic validation failed.', status: 'evaluated' });
  const failed = bulk.unmarkedSittings(1, 1).failed.find((s) => s.id === id);
  assert.equal(failed.error, 'A synthetic validation failed.');
});

test('incomplete sorting page map cannot be cleared by only selecting a paper', () => {
  const { id } = seedReady({ sorted: { pages: [sortPage(1), sortPage(2), sortPage(3)], papers: [summary()] } });
  bulk.choosePapers(bulk.itemFor(id), { B: 1 });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /incomplete page map/);
});

test('manual teacher choice cannot override an unrostered certain different name', () => {
  const { id } = seedReady({ looks: [pageLook(1, teacher, { name_written: 'Completely Different', teacher_id: 0 }), pageLook(2, null)] });
  bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
  bulk.choosePapers(bulk.itemFor(id), { B: 1 });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /clearly names “Completely Different”/);
  assert.equal(bulk.fileReady(1, 1, [id]).filed.length, 0);
});

test('manual teacher choice cannot override explicit conflicting class or subject', () => {
  for (const fields of [{ grade_written: 'Class 9' }, { subjects_written: 'History' }, { subjects_written: 'Astronomy' }]) {
    const { id } = seedReady({ looks: [pageLook(1, teacher, fields), pageLook(2, null)] });
    bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
    bulk.choosePapers(bulk.itemFor(id), { B: 1 });
    assert.equal(view(id).ready, false);
    assert.match(view(id).problems.join(' '), /class or subject that conflicts/);
    assert.equal(bulk.fileReady(1, 1, [id]).filed.length, 0);
  }
});

test('explicit teacher review resolves compatible initials and one-character handwriting variation', () => {
  for (const name of ['Anita R.', 'A. Rao', 'Anitha Rao']) {
    const { id } = seedReady({ looks: [pageLook(1), pageLook(2, teacher, { name_written: name, teacher_id: 0 })] });
    assert.equal(view(id).ready, false);
    bulk.chooseTeacher(bulk.itemFor(id), teacher.id);
    assert.equal(view(id).ready, true, name);
    assert.equal(bulk.fileReady(1, 1, [id]).filed.length, 1);
  }
});

test('shared name comparison distinguishes definite conflicts from cross-script uncertainty', async () => {
  const { nameRelationship, definiteNameConflict } = await import('../server/identity.js');
  assert.equal(definiteNameConflict('Anita Rao', 'Anita Shah'), true);
  assert.equal(definiteNameConflict('Anita K Rao', 'Anita R Rao'), true);
  assert.equal(nameRelationship('Anita Rao', 'A. Rao'), 'compatible');
  assert.equal(nameRelationship('Anita Anjali', 'A Anjli'), 'compatible');
  assert.equal(nameRelationship('Anita Rao', 'ಅನಿತಾ ರಾವ್'), 'unknown');
  assert.equal(nameRelationship('Anita Rao', 'Anita ರಾವ್'), 'unknown');
  assert.equal(nameRelationship('Anita Rao', ''), 'unknown');
});

test('marking status includes parsed stage progress', () => {
  const id = addAssessment();
  db.prepare('UPDATE assessments SET evaluation_progress = ? WHERE id = ?').run(JSON.stringify({ stage: 'response', completed: ['paper'] }), id);
  assert.deepEqual(bulk.markingState([id])[0].progress, { stage: 'response', completed: ['paper'] });
});


test('screenshot descriptive headings accept verified semantic question matches', () => {
  for (const title of ['Computer knowledge; Digital skills; Interpersonal & instructional communication skills', 'Knowledge, pedagogy, classroom management & child psychology']) {
    const { id } = seedReady({ looks: [pageLook(1, teacher, { paper_title_written: title }), pageLook(2)],
      sorted: { pages: [sortPage(1, { header_evidence: { status: 'descriptive', reason: 'This topic heading describes the question content; the distinctive scenario and question labels match the supplied master.' } }), sortPage(2)], papers: [summary()] } });
    assert.equal(view(id).ready, true, view(id).problems.join(' '));
    assert.equal(JSON.parse(bulk.itemFor(id).papers).B, 1);
  }
});

test('an unresolved or contradictory source heading still requires evidence', () => {
  for (const header_evidence of [undefined, { status: 'unresolved', reason: 'Version could not be read.' }, { status: 'conflict', reason: 'The source explicitly names a different version.' }, { status: 'descriptive', reason: '' }]) {
    const { id } = seedReady({ looks: [pageLook(1, teacher, { paper_title_written: 'Unidentified version 2025' }), pageLook(2)],
      sorted: { pages: [sortPage(1, { header_evidence }), sortPage(2)], papers: [summary()] } });
    assert.equal(view(id).ready, false);
  }
});

test('semantic heading evidence cannot override a different exact master or follow a manual paper change', () => {
  const evidence = { status: 'descriptive', reason: 'Generic heading.' };
  assert.match(bulk.headerMatchProblem(library[1].title, 1, library, evidence), /disagrees/);
  const { id } = seedReady({ looks: [pageLook(1, teacher, { paper_title_written: 'Subject knowledge and pedagogy' }), pageLook(2)],
    sorted: { pages: [sortPage(1, { header_evidence: evidence }), sortPage(2)], papers: [summary()] } });
  assert.equal(view(id).ready, true);
  bulk.choosePapers(bulk.itemFor(id), { B: 2 });
  assert.equal(view(id).ready, false);
});

test('question-label typography and local digits do not invalidate a semantic match', () => {
  for (const label of ['Q5 (a)', 'Question 5 A', '５Ａ', '೫A', '५(a)']) {
    const { id } = seedReady({ sorted: { pages: [sortPage(1, { questions: [label] }), sortPage(2)], papers: [summary()] } });
    assert.equal(view(id).ready, true, label);
  }
  assert.notEqual(bulk.normalizeQuestionLabel('5A'), bulk.normalizeQuestionLabel('5B'));
  assert.notEqual(bulk.normalizeQuestionLabel('5A'), bulk.normalizeQuestionLabel('15A'));
  for (const label of ['5(1)', '5.1', '5-1', '5 1']) assert.notEqual(bulk.normalizeQuestionLabel(label), bulk.normalizeQuestionLabel('51'));
});

test('unknown teacher metadata does not exclude compatible zero-score candidates', () => {
  const unknown = { ...teacher, grade: '', subjects: '' };
  assert.equal(bulk.candidatePapers(unknown, school, [paper(90)]).length, 1);
});

test('missing chosen paper is described accurately instead of claiming missing sections', () => {
  assert.match(bulk.paperCompatibilityProblem(null, teacher, school, 'A'), /No question paper has been matched/);
  assert.doesNotMatch(bulk.paperCompatibilityProblem(null, teacher, school, 'A'), /has no Section/);
});


test('one match-all action retries blocked matched uploads but excludes already-ready and retained outcomes', () => {
  const blocked = seedReady({ looks: [pageLook(1, teacher, { paper_title_written: 'Generic section heading' }), pageLook(2)] });
  const ready = seedReady();
  const retained = seedReady();
  db.prepare("UPDATE bulk_items SET sort_status = 'finalized' WHERE id = ?").run(retained.id);
  const queued = [];
  bulk.matchAll(1, 1, { queue: (id) => queued.push(id) });
  assert.ok(queued.includes(blocked.id));
  assert.ok(!queued.includes(ready.id));
  assert.ok(!queued.includes(retained.id));
});


test('sorter header conflicts block even when initial OCR missed the header or its title matches exactly', () => {
  for (const title of ['', library[0].title]) {
    for (const status of ['conflict', 'unresolved']) {
      const { id } = seedReady({ looks: [pageLook(1, teacher, { paper_title_written: title }), pageLook(2)],
        sorted: { pages: [sortPage(1, { header_evidence: { status, reason: 'A distinguishing version identifier conflicts with the proposed master.' } }), sortPage(2)], papers: [summary()] } });
      assert.equal(view(id).ready, false);
      assert.match(JSON.parse(bulk.itemFor(id).result).source_pages[0].issues.join(' '), /conflicting or unresolved/);
    }
  }
});


test('earlier exact master evidence survives a later generic heading', () => {
  const { id, pages, result } = seedReady();
  result.identity.pages[0].paper_title_written = 'General subject knowledge';
  result.identity.pages[0].previous_master_titles = [library[1].title];
  bulk.saveSort(id, teacher, school, library, pages, { pages: [sortPage(1, { header_evidence: { status: 'descriptive', reason: 'Generic current heading.' } }), sortPage(2)], papers: [summary()] }, result);
  assert.equal(view(id).ready, false);
  assert.match(JSON.parse(bulk.itemFor(id).result).source_pages[0].issues.join(' '), /earlier source observation/);
  bulk.choosePapers(bulk.itemFor(id), { B: 1 });
  assert.equal(view(id).ready, false);
  assert.match(view(id).problems.join(' '), /earlier source observation/);
});

test('24-page packet resolves descriptive headings against a combined A/C master and subject-specific B', () => {
  const puTeacher = { ...teacher, grade: 'I & II PU', subjects: 'Electronics' };
  const combined = paper(91, { title: 'PU Communication Skills and Computer Literacy', sections: 'A,C', levels: 'senior-secondary', subject: '' });
  const specialist = paper(92, { title: 'PU Electronics Knowledge and Pedagogy', levels: 'senior-secondary', subject: 'Electronics' });
  const bank = [combined, specialist];
  const pages = Array.from({ length: 24 }, (_, i) => ({ id: 20000 + i, position: i + 1 }));
  const looks = pages.map((_, i) => pageLook(i + 1, puTeacher, { paper_title_written: i === 0
    ? 'Computer knowledge; Digital skills; Interpersonal & instructional communication skills'
    : i === 6 ? 'Knowledge, pedagogy, classroom management & child psychology' : '' }));
  const found = pages.map((_, i) => {
    const section = i < 6 ? 'A' : i < 18 ? 'B' : 'C';
    const question = section === 'A' ? '1A' : section === 'B' ? '5A' : '11C';
    return sortPage(i + 1, { section, paper_id: section === 'B' ? 92 : 91, questions: [question],
      header_evidence: { status: i === 0 || i === 6 ? 'descriptive' : 'not_present', reason: i === 0 || i === 6 ? 'The heading describes these sections, while the concrete answer scenarios match the supplied questions.' : '' } });
  });
  const result = resultFor({ file_name: 'Combined packet.pdf' }, pages, looks, { candidate_paper_ids: [91, 92] });
  const plan = bulk.buildSortPlan(puTeacher, school, bank, pages, { pages: found, papers: [
    summary({ section: 'A', paper_id: 91, matched_question_labels: ['1A'] }),
    summary({ paper_id: 92 }), summary({ section: 'C', paper_id: 91, matched_question_labels: ['11C'] }),
  ] }, result);
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.papers, { A: 91, B: 92, C: 91 });
  assert.equal(plan.sourcePages.length, 24);
  assert.equal(plan.sourcePages.flatMap((p) => p.issues).length, 0);
});


test('a regular rematch cannot silently erase an earlier answer page as blank', () => {
  const { id, pages, result } = seedReady();
  bulk.saveSort(id, teacher, school, library, pages, { pages: [sortPage(1), sortPage(2, { section: 'none', paper_id: 0, questions: [], has_answers: false })], papers: [summary()] }, result);
  assert.equal(view(id).ready, false);
  assert.equal(JSON.parse(bulk.itemFor(id).result).source_pages[1].has_answers, true);
  assert.match(view(id).problems.join(' '), /unresolved/);
});

const { digest, fileBasis } = await import('../server/provenance.js');
const { UPLOADS_DIR } = await import('../server/db.js');
db.prepare('INSERT INTO teachers (id, school_id, name, grade, subjects) VALUES (60,1,?,?,?)').run('Synthetic Science Teacher', 'Middle School', 'Science');
for (const id of [90, 91]) db.prepare('INSERT INTO papers (id,title,sections,levels,subject,board,language,stored_name,original_name) VALUES (?,?,?,?,?,?,?,?,?)').run(id, `Synthetic Biology ${id}`, 'B', 'secondary', 'Biology', 'CBSE', 'English', `cross-master-${id}.pdf`, `cross-master-${id}.pdf`);
async function crossFixture({ conflict = false, differentPerson = false } = {}) {
  const owner = db.prepare('SELECT * FROM teachers WHERE id=60').get();
  const masters = db.prepare('SELECT * FROM papers WHERE id IN (90,91)').all();
  for (const master of masters) await fs.writeFile(path.join(UPLOADS_DIR, master.stored_name), `%PDF-1.7 synthetic full biology master ${master.id}`);
  const id = bulk.addItem(school, { id: 1 }, `${owner.name}.pdf`, [1, 2].map(n => ({ filename: `cross-${Math.random()}-${n}.jpg`, mimetype: 'image/jpeg', size: 20 })));
  db.prepare("UPDATE bulk_items SET teacher_id=60,sort_status='done',matched_by='file' WHERE id=?").run(id);
  const pages = pagesFor(id);
  for (const page of pages) await fs.writeFile(path.join(UPLOADS_DIR, page.stored_name), `synthetic biology response Q2A Q3B ${page.id}`);
  const item = bulk.itemFor(id);
  const observations = pages.map((_, i) => pageLook(i + 1, differentPerson ? other : owner));
  const result = { identity: bulk.inspectIdentity(item, pages, { pages: observations }, [...teachers, owner]), candidate_paper_ids: [90,91], paper_confirmations: {}, notes: [], sections: {},
    bank_comparison: { complete: true, final_compared: true, finalist_ids: [90], profile_fallback: true },
    matching_source_basis: { attempt_id: `synthetic-${id}`, teacher: digest(owner), school: digest(db.prepare('SELECT * FROM schools WHERE id=1').get()),
      pages: Object.fromEntries(pages.map(p => [p.id, fileBasis(p).sha256])),
      papers: Object.fromEntries(masters.map(p => [p.id, { sha256: fileBasis(p).sha256, metadata: digest(p) }])) } };
  const sorted = { pages: pages.map((_, i) => sortPage(i + 1, { paper_id: 90, questions: ['2A', '3B'], header_evidence: { status: conflict ? 'conflict' : 'not_present', reason: conflict ? 'Explicit source code differs.' : 'No paper heading.' } })),
    papers: [summary({ paper_id: 90, reason: 'Food-chain prerequisite and biology learning responses match Q2A and Q3B.', matched_question_labels: ['2A','3B'] })] };
  bulk.saveSort(id, owner, school, masters, pages, sorted, result);
  return { id, pages, owner, masters, result, sorted };
}

test('Science middle-school response discovers Biology secondary master but needs explicit evidence-bound acknowledgement', async () => {
  const { id, owner, masters } = await crossFixture();
  assert.equal(bulk.candidatePapers(owner, school, masters).length, 0);
  const before = view(id);
  assert.equal(before.ready, false);
  const review = before.sections.find(s => s.key === 'B').cross_profile_review;
  assert.ok(review); assert.equal(review.paper_id, 90); assert.match(review.master_url, /cross-master-90.pdf/);
  assert.match(bulk.choosePapers(bulk.itemFor(id), { B: 90 }), /acknowledgement/);
  assert.match(bulk.choosePapers(bulk.itemFor(id), { B: 91 }, { B: review.token }), /acknowledgement/);
  assert.equal(bulk.choosePapers(bulk.itemFor(id), { B: 90 }, { B: review.token }), null);
  assert.equal(view(id).ready, true);
  assert.deepEqual(db.prepare('SELECT * FROM teachers WHERE id=60').get(), owner);
  assert.deepEqual(view(id).pages[0].match.questions, ['2A', '3B']); // No invented Q1 coverage.
});

test('cross-profile acknowledgement cannot waive real person or source-heading conflicts', async () => {
  for (const options of [{ differentPerson: true }, { conflict: true }]) {
    const { id } = await crossFixture(options);
    const review = view(id).sections.find(s => s.key === 'B').cross_profile_review;
    const denied = bulk.choosePapers(bulk.itemFor(id), { B: 90 }, { B: review?.token ?? 'forged' });
    assert.ok(denied); assert.equal(view(id).ready, false);
  }
});

for (const kind of ['source_bytes', 'master_bytes', 'profile', 'attempt']) test(`cross-profile approval invalidates on ${kind} change`, async () => {
  const fixture = await crossFixture(); const { id, pages, owner, masters, result, sorted } = fixture;
  const review = view(id).sections.find(s => s.key === 'B').cross_profile_review;
  assert.equal(bulk.choosePapers(bulk.itemFor(id), { B: 90 }, { B: review.token }), null);
  assert.equal(view(id).ready, true);
  if (kind === 'source_bytes') await fs.appendFile(path.join(UPLOADS_DIR, pages[0].stored_name), 'changed');
  if (kind === 'master_bytes') await fs.appendFile(path.join(UPLOADS_DIR, masters[0].stored_name), 'changed');
  if (kind === 'profile') db.prepare("UPDATE teachers SET grade='Class 9' WHERE id=60").run();
  if (kind === 'attempt') {
    const next = structuredClone(result); next.matching_source_basis.attempt_id += '-new';
    bulk.saveSort(id, owner, school, masters, pages, sorted, next);
    assert.match(bulk.choosePapers(bulk.itemFor(id), { B: 90 }, { B: review.token }), /acknowledgement/);
  }
  assert.equal(view(id).ready, false);
  if (kind === 'profile') db.prepare('UPDATE teachers SET grade=? WHERE id=60').run(owner.grade);
});

test('automatic finalization explicitly holds acknowledged cross-profile submissions without mutating status', async () => {
  const { id } = await crossFixture();
  const review = view(id).sections.find(s => s.key === 'B').cross_profile_review;
  bulk.choosePapers(bulk.itemFor(id), { B: 90 }, { B: review.token });
  assert.throws(() => bulk.queueFinalizations(1, 1, [id]), /automatic finalization does not support/);
  await assert.rejects(bulk.finalizeBulkItem(id, { evaluate: false }), /automatic finalization does not support/);
  assert.equal(bulk.itemFor(id).sort_status, 'done');
});

for (const kind of ['missing_source', 'missing_master', 'alternative', 'duplicate_summary', 'exact_title']) test(`cross-profile exception fails closed for ${kind}`, async () => {
  const { id, pages, result, sorted, owner, masters } = await crossFixture();
  if (kind === 'missing_source') await fs.unlink(path.join(UPLOADS_DIR, pages[0].stored_name));
  if (kind === 'missing_master') await fs.unlink(path.join(UPLOADS_DIR, masters[0].stored_name));
  if (kind === 'alternative') sorted.papers[0].alternatives = [91];
  if (kind === 'duplicate_summary') sorted.papers.push(structuredClone(sorted.papers[0]));
  if (kind === 'exact_title') result.identity.pages[0].paper_title_written = masters[1].title;
  if (['alternative', 'duplicate_summary', 'exact_title'].includes(kind)) bulk.saveSort(id, owner, school, masters, pages, sorted, result);
  assert.equal(view(id).sections.find(s => s.key === 'B').cross_profile_review, null);
  assert.ok(bulk.choosePapers(bulk.itemFor(id), { B: 90 }, { B: 'forged' }));
  assert.equal(view(id).ready, false);
  assert.ok(bulk.itemFor(id)); // Confirmation never files or removes a submission.
});
