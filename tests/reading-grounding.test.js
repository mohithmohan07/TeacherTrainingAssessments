import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// All scans and provider responses here are synthetic. No live API is called.
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-grounding-'));
process.env.DATA_DIR = data;
const { default: db, UPLOADS_DIR } = await import('../server/db.js');
const { readingPages, readAnswers } = await import('../server/reading.js');
const { readingInputs } = await import('../server/paper-inputs.js');
const { writingOf, writingBasis, lacksWriting, sectionWriting, teacherWriting, schoolWriting, writingWordCount, checkWriting, WRITING_VERSION } = await import('../server/writing.js');
after(async () => { db.close(); await fs.rm(data, { recursive: true, force: true }); });

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA7sAAAAASUVORK5CYII=', 'base64');
const files = [1, 2, 3].map((id) => ({ id, original_name: `synthetic-${id}.png`, stored_name: `${id}.png`, mime_type: 'image/png' }));
await Promise.all(files.map((file) => fs.writeFile(path.join(UPLOADS_DIR, file.stored_name), png)));
const batch = files.map((file, i) => ({ number: i + 1, file }));
const page = (number, text, status = 'read') => ({ page: number, text, status, reason: '' });
const response = (pages) => ({ pages });

const teacherAnswer = 'मैं बच्चो को कहानी सुनाता है। ಮಕ್ಕಳು ಒಟ್ಟಿಗೆ ಕಲಿಯುತ್ತಾರೆ. بچے مل کر سیکھتے ہیں۔ Teaching with stories helps children listen and share their own ideas with the whole class in meaningful ways.';
const questions = [{ section: 'Section A', question: '1A', question_text: 'Describe a teaching activity.', teacher_answer: teacherAnswer, marks_awarded: 3 }];
function writing(overrides = {}, rows = questions) {
  return {
    basis: writingBasis(rows), evidence_version: 1, version: WRITING_VERSION, from: 'reading',
    sections: [{ section: 'Section A', judged: true, sentence_formation: 4, grammar: 3, spelling_punctuation: 4, vocabulary: 4, summary: 'Check agreement.' }],
    errors: [{ section: 'Section A', question: '1A', type: 'Grammar', wrote: 'मैं बच्चो को कहानी सुनाता है।', problem: 'Subject and verb do not agree.', correction: 'मैं बच्चों को कहानी सुनाता हूँ।' }],
    ...overrides,
  };
}

test('multilingual, RTL and Romanized Hindi text is preserved without translation', () => {
  const source = ['1A. ಮಕ್ಕಳು ಕಲಿಯುತ್ತಾರೆ. blackboard', '۲۔ بچے مل کر سیکھتے ہیں۔', '3A. Bacche milkar seekhte hain.'];
  const result = readingPages(response(source.map((text, i) => page(i + 1, text))), batch);
  assert.deepEqual(result.map((p) => p.text), source);
  assert.deepEqual(result.map((p) => p.source_file_id), [1, 2, 3]);
  assert.ok(result.every((p) => p.status === 'read' && !p.needs_image));
});

test('empty, whitespace and malformed extractions are unavailable, never blank answers', () => {
  const result = readingPages(response([page(1, ''), page(2, ' \n\t '), page(3, { invented: 'text' })]), batch);
  assert.deepEqual(result.map((p) => p.text), [null, null, null]);
  assert.ok(result.every((p) => p.status === 'unreadable' && p.needs_image));
});

test('explicitly reported blank is distinguished but still requires the source scan', async () => {
  const details = readingPages(response([page(1, '', 'blank')]), batch.slice(0, 1));
  assert.equal(details[0].status, 'blank_unverified');
  const inputs = await readingInputs([null], files.slice(0, 1), details);
  assert.match(inputs[0].text, /blank page, which has not been verified/);
  assert.equal(inputs[1].type, 'input_image');
});

test('missing, duplicate and incorrectly renumbered pages cannot borrow neighboring text', () => {
  const missing = readingPages(response([page(1, 'हिंदी'), page(3, 'தமிழ்')]), batch);
  assert.deepEqual(missing.map((p) => p.text), ['हिंदी', null, 'தமிழ்']);
  const duplicate = readingPages(response([page(1, 'पहला'), page(1, 'दूसरा')]), batch);
  assert.equal(duplicate[0].text, null);
  assert.match(duplicate[0].reason, /Duplicate/);
  const laterBatch = [{ number: 9, file: files[0] }, { number: 10, file: files[1] }];
  assert.deepEqual(readingPages(response([page(1, 'misnumbered'), page(2, 'misnumbered')]), laterBatch).map((p) => p.text), [null, null]);
});

test('partial handwriting retains words, uncertainty and the correctly numbered source image', async () => {
  const details = readingPages(response([page(1, '1A. बच्चे [illegible] हैं।'), page(2, '2A. ಕಲಿಕೆ', 'uncertain')]), batch.slice(0, 2));
  assert.ok(details.every((p) => p.status === 'uncertain' && p.needs_image));
  const inputs = await readingInputs(details.map((p) => p.text), files.slice(0, 2), details);
  assert.equal(inputs.filter((input) => input.type === 'input_image').length, 2);
  assert.match(inputs[0].text, /page 1 of 2/);
  assert.match(inputs[2].text, /page 2 of 2/);
  assert.match(inputs[0].text, /बच्चे \[illegible\] हैं/);
});

test('legacy empty strings and omitted trailing extractions fall back to every source image', async () => {
  const inputs = await readingInputs(['', '  '], files);
  assert.equal(inputs.filter((input) => input.type === 'input_image').length, 3);
  assert.match(inputs[4].text, /page 3 of 3/);
  assert.ok(inputs.filter((input) => input.type === 'input_text').every((input) => !input.text.includes('nothing written')));
});

test('source absence is explicit and cannot silently turn into an unanswered page', async () => {
  const inputs = await readingInputs([null]);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].text, /Source image unavailable/);
  assert.match(inputs[0].text, /do not infer an unanswered page/);
});

test('all-empty Gemini batch returns source fallbacks, with backward compatible output', async (t) => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-test-only';
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(response([page(1, ''), page(2, '  ', 'blank')])) }] } }] }),
  }));
  const details = await readAnswers(files.slice(0, 2), ['Hindi'], { includeDetails: true });
  assert.deepEqual(details.texts, [null, null]);
  assert.deepEqual(details.pages.map((p) => p.status), ['unreadable', 'blank_unverified']);
  assert.deepEqual(await readAnswers(files.slice(0, 2), ['Hindi']), [null, null]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('mixed PNG/GIF pages retain original numbering and supported pages still use Gemini', async (t) => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-test-only';
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  const gif = { id: 20, original_name: 'synthetic-20.gif', stored_name: '20.gif', mime_type: 'image/gif' };
  await fs.writeFile(path.join(UPLOADS_DIR, gif.stored_name), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const mixed = [files[0], gif, files[2]];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const parts = JSON.parse(options.body).contents[0].parts;
    assert.deepEqual(parts.filter((part) => /^Page \d+:$/.test(part.text ?? '')).map((part) => part.text), ['Page 1:', 'Page 3:']);
    assert.match(parts[0].text, /pages 1, 3 of 3 pages/);
    assert.ok(parts.filter((part) => part.inlineData).every((part) => part.inlineData.mimeType === 'image/png'));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(response([page(1, '1A. ಮಕ್ಕಳು ಕಲಿಯುತ್ತಾರೆ.'), page(3, '3A. بچے مل کر سیکھتے ہیں۔')])) }] } }] }) };
  });
  const result = await readAnswers(mixed, ['Kannada', 'Urdu'], { includeDetails: true });
  assert.deepEqual(result.texts, ['1A. ಮಕ್ಕಳು ಕಲಿಯುತ್ತಾರೆ.', null, '3A. بچے مل کر سیکھتے ہیں۔']);
  assert.deepEqual(result.pages.map((p) => [p.page, p.source_file_id]), [[1, 1], [2, 20], [3, 3]]);
  assert.equal(result.pages[1].needs_image, true);
  assert.match(result.pages[1].reason, /does not support image\/gif/);
  assert.equal(fetchMock.mock.callCount(), 1);
  const inputs = await readingInputs(result.texts, mixed, result.pages);
  assert.equal(inputs.filter((input) => input.type === 'input_image').length, 1);
  assert.match(inputs[1].text, /page 2 of 3/);
  assert.match(inputs[2].image_url, /^data:image\/gif;base64,/);
});

test('all-GIF input uses source fallback without needing a Gemini key or making a provider call', async (t) => {
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  const gif = { id: 21, original_name: 'synthetic-21.gif', stored_name: '21.gif', mime_type: 'image/gif' };
  await fs.writeFile(path.join(UPLOADS_DIR, gif.stored_name), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { assert.fail('All-GIF fallback must not call Gemini.'); });
  const result = await readAnswers([gif], ['Hindi'], { includeDetails: true });
  assert.deepEqual(result.texts, [null]);
  assert.equal(result.pages[0].source_file_id, 21);
  assert.equal(result.pages[0].needs_image, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('writing errors require exact, question-specific multilingual source quotes', () => {
  const raw = writing();
  raw.errors.push(
    { ...raw.errors[0], question: '9Z' },
    { ...raw.errors[0], wrote: 'मैं बच्चों को कहानी सुनाता हूँ।' },
    { ...raw.errors[0], type: 'Invented category' },
    { ...raw.errors[0], correction: raw.errors[0].wrote },
    { ...raw.errors[0] },
  );
  const result = writingOf(raw, questions);
  assert.equal(result.errors.length, 1);
  assert.equal(result.rejected_errors, 4);
  assert.equal(result.errors[0].wrote, raw.errors[0].wrote);
  assert.equal(result.sections[0].score, 7.5);
  assert.equal(sectionWriting(result, 'A').level, 'Good');
});

test('a refused batch retries individual pages and retains a successful handwritten reading', async (t) => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-test-only';
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  const mocked = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const parts = JSON.parse(options.body).contents[0].parts;
    const labels = parts.filter((part) => /^Page \d+:$/.test(part.text ?? '')).map((part) => part.text);
    const readable = labels.length === 1 && labels[0] === 'Page 1:';
    return {
      ok: true, status: 200,
      json: async () => ({ candidates: [readable
        ? { content: { parts: [{ text: JSON.stringify(response([page(1, '1A. शिक्षक बच्चों से प्रश्न पूछते हैं।')])) }] } }
        : { finishReason: 'OTHER', content: { parts: [] } }] }),
    };
  });
  const result = await readAnswers(files.slice(0, 2), ['Hindi'], { includeDetails: true });
  assert.deepEqual(result.texts, ['1A. शिक्षक बच्चों से प्रश्न पूछते हैं।', null]);
  assert.deepEqual(result.pages.map((p) => [p.page, p.source_file_id, p.status]), [[1, 1, 'read'], [2, 2, 'unreadable']]);
  assert.equal(mocked.mock.callCount(), 3);
});

test('Unicode canonical equivalents and whitespace match without translating or changing case', () => {
  const rows = [{ ...questions[0], teacher_answer: `café\nहिंदी लेखन गलत है। ${teacherAnswer}` }];
  const error = { section: 'Section A', question: 'Q1(a)', type: 'Spelling', wrote: 'cafe\u0301 हिंदी', correction: 'café हिन्दी', problem: 'Synthetic spelling example.' };
  assert.equal(writingOf(writing({ errors: [error] }, rows), rows).errors.length, 1);
  assert.equal(writingOf(writing({ errors: [{ ...error, wrote: 'CAFÉ हिंदी' }] }, rows), rows).errors.length, 0);
});

test('unreadable handwriting cannot become a fabricated spelling correction', () => {
  const rows = [{ ...questions[0], teacher_answer: 'ಬಾಲಕರು [illegible] ಕಲಿಯುತ್ತಾರೆ.' }];
  const raw = writing({ errors: [{ section: 'Section A', question: '1A', type: 'Spelling', wrote: '[illegible]', correction: 'ಶಾಲೆಯಲ್ಲಿ', problem: 'Invented missing word.' }] }, rows);
  assert.equal(writingOf(raw, rows).errors.length, 0);
});

test('missing, fractional or out-of-range criterion scores remain unjudged, never clamped', () => {
  for (const value of [undefined, 0, 6, 3.5, '4', NaN]) {
    const raw = writing();
    raw.sections[0].grammar = value;
    const result = writingOf(raw, questions);
    assert.equal(result.sections[0].judged, false);
    assert.equal(result.sections[0].score, null);
    assert.equal(result.errors.length, 0);
  }
});

test('writing invalidates after answer or attribution edits, but not a marks-only correction', () => {
  const raw = writing();
  assert.equal(writingOf(raw, [{ ...questions[0], marks_awarded: 5 }]).problem, undefined);
  assert.match(writingOf(raw, [{ ...questions[0], teacher_answer: `${teacherAnswer} extra words` }]).problem, /changed/);
  assert.match(writingOf(raw, [{ ...questions[0], question: '2B' }]).problem, /changed/);
  assert.equal(lacksWriting({ questions, writing: raw }), false);
  assert.equal(lacksWriting({ questions: [{ ...questions[0], teacher_answer: 'Changed answer' }], writing: raw }), true);
});

test('legacy unverified writing is pending reassessment and cannot retain an unsupported score', () => {
  const raw = writing();
  delete raw.basis;
  delete raw.evidence_version;
  assert.equal(lacksWriting({ questions, writing: raw }), true);
  assert.match(writingOf(raw, questions).problem, /evidence-checked reassessment/);
});

test('unclear handwriting, option labels and absent responses cannot support a writing score', async () => {
  for (const answer of ['[illegible]', '[ unclear handwriting ]', 'A', '123', '[diagram: a labelled water cycle]']) {
    const row = { ...questions[0], teacher_answer: answer };
    assert.equal(writingWordCount(row), 0, answer);
    assert.equal(await checkWriting([row]), null);
  }
  for (const response_status of ['unreadable', 'unanswered', 'section_not_supplied', 'extraction_failure', 'missing_page']) {
    const row = { ...questions[0], response_status };
    assert.equal(writingWordCount(row), 0);
    assert.equal(writingOf(writing({}, [row]), [row]).sections[0].judged, false);
    assert.equal(await checkWriting([row]), null);
  }
});

test('too little supported writing stays unjudged regardless of a model-proposed high rating', () => {
  const row = { ...questions[0], teacher_answer: `A clear short answer. ${'[illegible] '.repeat(35)}`, response_status: 'partial' };
  assert.equal(writingWordCount(row), 4);
  const result = writingOf(writing({}, [row]), [row]);
  assert.equal(result.sections[0].judged, false);
  assert.equal(result.sections[0].score, null);
  assert.deepEqual(result.errors, []);
});

test('multilingual phrases can provide enough supported writing, and status changes invalidate it', () => {
  const row = { ...questions[0], response_status: 'partial' };
  assert.ok(writingWordCount(row) >= 30);
  const result = writingOf(writing({}, [row]), [row]);
  assert.equal(result.sections[0].judged, true);
  assert.match(writingOf(result, [{ ...row, response_status: 'unreadable' }]).problem, /changed/);
});

test('displayed writing average and rating use the same rounded score at band boundaries', () => {
  const teachers = Array.from({ length: 12 }, (_, i) => ({ sections: [{ writing: {
    judged: true, score: i === 0 ? 6.5 : 7, errors: [],
    criteria: [{ label: 'Grammar', score: 4 }],
  } }] }));
  const aggregate = schoolWriting(teachers);
  assert.equal(aggregate.average, 7);
  assert.equal(aggregate.level, 'Good');
  assert.equal(teacherWriting([{ writing: { judged: true, score: NaN } }]), null);
});
