import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BANK_COMPARISON_BATCH_SIZE, BANK_COMPARISON_FINALIST_LIMIT, compareQuestionBank, compareWithProfileFallback } from '../server/bank-matching.js';
import { createMatchingBudget } from '../server/matching-budget.js';

// Synthetic bytes and injected requests only: no credentials, provider calls,
// application database, or production source files are used by these tests.
const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tta-bank-comparison-'));
after(() => fs.rm(uploadsDir, { recursive: true, force: true }));
const fullPdf = (id) => Buffer.from(`%PDF-1.7\nFIRST PAGE ${id}\n${'middle pages and questions\n'.repeat(40)}FINAL PAGE QUESTION ${id}\n%%EOF`);
const candidates = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1, title: `Synthetic administered paper ${i + 1}`, sections: 'B', subject: 'Mathematics',
  levels: 'primary', board: 'Synthetic Board', language: 'English', stored_name: `paper-${i + 1}.pdf`,
}));
await Promise.all(candidates.map((paper) => fs.writeFile(path.join(uploadsDir, paper.stored_name), fullPdf(paper.id))));
const sourceBytes = Buffer.from('synthetic original answer page: no printed question or paper title');
const sourcePath = path.join(uploadsDir, 'answer-response-only.png');
await fs.writeFile(sourcePath, sourceBytes);
const answerInput = Object.freeze({ type: 'input_image', image_url: `data:image/png;base64,${sourceBytes.toString('base64')}`, detail: 'high' });
const content = Object.freeze([
  Object.freeze({ type: 'input_text', text: 'TEACHER: synthetic primary mathematics teacher. Response-only page; match the answer content.' }),
  answerInput,
]);
const schema = { type: 'object', properties: { pages: { type: 'array' }, papers: { type: 'array' } } };
const page = (paperId = 0, extra = {}) => ({ page: 1, paper_id: paperId, section: paperId ? 'B' : 'none', questions: paperId ? ['5A'] : [], has_answers: true, ...extra });
const summary = (paperId, alternatives = [], extra = {}) => ({ section: 'B', paper_id: paperId, confidence: alternatives.length ? 'low' : 'high', reason: 'Concrete answer content corresponds to question 5A.', matched_question_labels: ['5A'], alternatives, ...extra });
const unresolved = (extra = {}) => ({ pages: [page(0, extra)], papers: [] });
const matched = (paperId, alternatives = []) => ({ pages: [page(paperId)], papers: [summary(paperId, alternatives)] });
const suppliedIds = (request) => request.content.filter((entry) => entry.type === 'input_file').map((entry) => Number(entry.filename.match(/^paper-(\d+)\.pdf$/)[1]));
const options = (count, request, extra = {}) => ({ candidates: candidates.slice(0, count), request, instructions: 'Original matching instructions.', content, schema, uploadsDir, name: 'answer_sheets_sorted', ...extra });

test('small banks use one call with every full PDF, including matches below the old top four', async () => {
  let calls = 0;
  const before = JSON.stringify(content);
  const result = await compareQuestionBank(options(7, async (request) => {
    calls += 1;
    assert.deepEqual(suppliedIds(request), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(request.schema, schema);
    assert.equal(request.name, 'answer_sheets_sorted');
    assert.equal(request.timeoutMs, 120000);
    assert.equal(request.maxRetries, 1);
    assert.ok(request.instructions.startsWith('Original matching instructions.'));
    assert.ok(request.content.includes(answerInput));
    assert.deepEqual(request.content.slice(-content.length), content);
    for (const entry of request.content.filter((input) => input.type === 'input_file')) {
      const id = Number(entry.filename.match(/\d+/)[0]);
      assert.deepEqual(Buffer.from(entry.file_data.split(',')[1], 'base64'), fullPdf(id));
      assert.ok(request.content.some((input) => input.type === 'input_text' && input.text.includes(`"id":${id},`) && input.text.includes('Synthetic Board')));
    }
    return matched(7);
  }, { timeoutMs: 120000, maxRetries: 1 }));
  assert.equal(calls, 1);
  assert.equal(result.pages[0].paper_id, 7);
  assert.deepEqual(result.considered_candidate_ids, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(result.bank_comparison.final_compared, true);
  assert.equal(result.bank_comparison.candidate_count, 7);
  assert.equal(JSON.stringify(content), before);
  assert.deepEqual(await fs.readFile(sourcePath), sourceBytes);
  for (const paper of candidates.slice(0, 7)) assert.deepEqual(await fs.readFile(path.join(uploadsDir, paper.stored_name)), fullPdf(paper.id));
});

test('all batches are searched and a correct late-bank candidate gets a full final comparison', async () => {
  const calls = [];
  const result = await compareQuestionBank(options(17, async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    assert.ok(ids.length <= BANK_COMPARISON_BATCH_SIZE);
    assert.ok(request.content.includes(answerInput), 'original answer image must accompany every batch and final call');
    if (calls.length < 4) assert.match(request.instructions, /not the whole compatible question bank/);
    else assert.match(request.instructions, /final comparison/);
    return ids.includes(17) ? matched(17) : unresolved();
  }));
  assert.deepEqual(calls, [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14, 15, 16], [17], [17]]);
  assert.equal(result.pages[0].paper_id, 17);
  assert.deepEqual(result.considered_candidate_ids, candidates.slice(0, 17).map((p) => p.id));
  assert.equal(result.bank_comparison.candidate_count, 17);
});

test('cross-batch matches and ambiguous alternatives all survive into final disambiguation', async () => {
  const calls = [];
  const result = await compareQuestionBank(options(12, async (request) => {
    calls.push(suppliedIds(request));
    if (calls.length === 1) return matched(2, [7]);
    if (calls.length === 2) return matched(11);
    assert.deepEqual(suppliedIds(request), [2, 7, 11]);
    return matched(2, [7, 11]);
  }));
  assert.equal(calls.length, 3);
  assert.deepEqual(result.papers[0].alternatives, [7, 11]);
  assert.equal(result.papers[0].confidence, 'low');
  assert.deepEqual(result.bank_comparison.finalist_ids, [2, 7, 11]);
});

test('page-only and low-confidence paper leads are kept, even without a winning summary', async () => {
  let calls = 0;
  const result = await compareQuestionBank(options(9, async (request) => {
    calls += 1;
    if (calls === 1) return { pages: [page(6)], papers: [summary(0, [8], { confidence: 'low' })] };
    if (calls === 2) return unresolved();
    assert.deepEqual(suppliedIds(request), [6, 8]);
    return matched(8);
  }));
  assert.equal(result.pages[0].paper_id, 8);
  assert.equal(calls, 3);
});

for (const [name, bad] of [
  ['page ID', { pages: [page(999)], papers: [] }],
  ['summary ID', { pages: [page()], papers: [summary(999)] }],
  ['alternative ID', matched(1, [999])],
]) {
  test(`invented ${name} is rejected instead of becoming match evidence`, async () => {
    await assert.rejects(compareQuestionBank(options(4, async () => bad)), (error) => {
      assert.equal(error.code, 'QUESTION_BANK_COMPARISON_FAILED');
      assert.equal(error.cause.code, 'QUESTION_BANK_INVALID_EVIDENCE');
      assert.match(error.message, /999 was not supplied/);
      return true;
    });
  });
}

test('a real bank ID absent from the current batch is rejected too', async () => {
  let calls = 0;
  await assert.rejects(compareQuestionBank(options(12, async () => {
    calls += 1;
    return matched(12);
  })), /12 was not supplied/);
  assert.equal(calls, 1);
});

test('a failed batch aborts instead of reporting another batch winner as globally safe', async () => {
  const calls = [];
  await assert.rejects(compareQuestionBank(options(12, async (request) => {
    calls.push(suppliedIds(request));
    if (calls.length === 1) return matched(1);
    throw new Error('Synthetic provider outage');
  })), (error) => {
    assert.match(error.message, /batch 2 of 2 failed/);
    assert.match(error.message, /incomplete; no match was accepted/);
    assert.deepEqual(error.considered_candidate_ids, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(error.failed_candidate_ids, [9, 10, 11, 12]);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('a failed final comparison cannot fall back to a provisional batch match', async () => {
  let calls = 0;
  await assert.rejects(compareQuestionBank(options(9, async () => {
    calls += 1;
    if (calls === 1) return matched(2);
    if (calls === 2) return unresolved();
    throw new Error('Synthetic final failure');
  })), /final comparison failed/);
  assert.equal(calls, 3);
});

test('no matching contender leaves answers unresolved and never invents a paper or blank page', async () => {
  let calls = 0;
  const result = await compareQuestionBank(options(9, async () => {
    calls += 1;
    return unresolved({ has_answers: calls === 1 });
  }));
  assert.equal(calls, 2);
  assert.deepEqual(result.pages, [page()]);
  assert.deepEqual(result.papers, []);
  assert.equal(result.bank_comparison.final_compared, false);
  assert.equal(result.considered_candidate_ids.length, 9);
});

test('genuinely blank pages remain blank when all screening batches agree', async () => {
  const result = await compareQuestionBank(options(9, async () => unresolved({ has_answers: false })));
  assert.deepEqual(result.pages, [page(0, { has_answers: false })]);
  assert.deepEqual(result.papers, []);
});

test('up to sixteen contenders are compared together in full after eight-paper screening batches', async () => {
  const calls = [];
  const result = await compareQuestionBank(options(BANK_COMPARISON_FINALIST_LIMIT, async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    for (const input of request.content.filter((entry) => entry.type === 'input_file')) {
      const id = Number(input.filename.match(/\d+/)[0]);
      assert.deepEqual(Buffer.from(input.file_data.split(',')[1], 'base64'), fullPdf(id));
    }
    return calls.length <= 2 ? matched(ids[0], ids.slice(1)) : matched(16);
  }));
  assert.deepEqual(calls.map((ids) => ids.length), [8, 8, 16]);
  assert.deepEqual(calls[2], candidates.slice(0, 16).map((paper) => paper.id));
  assert.equal(result.pages[0].paper_id, 16);
});

test('too many finalists report an explicit limit after inspecting the entire bank, with none dropped', async () => {
  const calls = [];
  await assert.rejects(compareQuestionBank(options(20, async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    return matched(ids[0], ids.slice(1));
  })), (error) => {
    assert.equal(error.code, 'QUESTION_BANK_FINALIST_LIMIT');
    assert.deepEqual(error.considered_candidate_ids, candidates.map((p) => p.id));
    assert.deepEqual(error.finalist_ids, candidates.map((p) => p.id));
    assert.match(error.message, /20 remain plausible/);
    assert.match(error.message, /at most 16 full PDFs/);
    assert.match(error.message, /no contender was dropped/);
    return true;
  });
  assert.deepEqual(calls.map((ids) => ids.length), [8, 8, 4]);
});

test('paper input factory is per-paper and supplies the same full evidence again for final disambiguation', async () => {
  const readIds = [];
  let calls = 0;
  const result = await compareQuestionBank(options(9, async () => {
    calls += 1;
    return calls === 1 ? unresolved() : matched(9);
  }, {
    paperInputs: async (paper) => {
      readIds.push(paper.id);
      return [{ type: 'input_text', text: 'Existing caller metadata' }, { type: 'input_file', filename: `paper-${paper.id}.pdf`, file_data: `data:application/pdf;base64,${fullPdf(paper.id).toString('base64')}` }];
    },
  }));
  assert.deepEqual(readIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
  assert.equal(result.pages[0].paper_id, 9);
});

test('a missing full PDF aborts before a request can claim the candidate was inspected', async () => {
  await assert.rejects(compareQuestionBank(options(1, async () => assert.fail('No provider request without the PDF'), {
    paperInputs: async () => [{ type: 'input_text', text: 'Only title and metadata, no full paper' }],
  })), /full PDF for question paper 1 was not supplied/);
});

test('a malformed batch cannot quietly exclude a possible contender', async () => {
  await assert.rejects(compareQuestionBank(options(9, async () => ({ pages: [], papers: [] }))), /did not account for every answer page/);
});

test('supplied header evidence is validated and preserved, while older no-header responses remain supported', async () => {
  const header_evidence = { status: 'descriptive', reason: 'Generic heading matches the distinctive question topics.' };
  const result = await compareQuestionBank(options(1, async () => ({ pages: [page(1, { header_evidence })], papers: [summary(1)] })));
  assert.deepEqual(result.pages[0].header_evidence, header_evidence);
  for (const bad of [null, { status: 'trust_me', reason: 'A claim.' }, { status: 'compatible', reason: 9 }]) {
    await assert.rejects(compareQuestionBank(options(1, async () => ({ pages: [page(1, { header_evidence: bad })], papers: [summary(1)] }))), /heading evidence is malformed/);
  }
});

test('text-only input without an explicit page count still requires nonempty contiguous page maps', async () => {
  const textOnly = [{ type: 'input_text', text: 'Supporting transcription of source answer pages.' }];
  for (const bad of [{ pages: [], papers: [] }, { pages: [page(0, { page: 2 })], papers: [] }]) {
    await assert.rejects(compareQuestionBank(options(9, async () => bad, { content: textOnly })), /did not account|missing or malformed/);
  }
  let calls = 0;
  await assert.rejects(compareQuestionBank(options(9, async () => {
    calls += 1;
    return calls === 1 ? { pages: [page(), page(0, { page: 2 })], papers: [] } : unresolved();
  }, { content: textOnly })), /did not account for every answer page/);
  assert.equal(calls, 2);
});

test('final comparison cannot turn previously observed writing into a disposable blank', async () => {
  let calls = 0;
  const result = await compareQuestionBank(options(9, async (request) => {
    calls++;
    if (calls < 3) return matched(suppliedIds(request)[0]);
    return unresolved({ has_answers: false });
  }));
  assert.equal(calls, 3);
  assert.equal(result.pages[0].has_answers, true);
  assert.equal(result.pages[0].section, 'none');
  assert.equal(result.pages[0].paper_id, 0);
  assert.deepEqual(result.blank_conflict_pages, [1]);
});

const requestTimeout = () => Object.assign(new Error('Synthetic request timed out.'), { code: 'OPENAI_REQUEST_TIMEOUT' });
function metered(handler, limits = {}) {
  const requestPolicy = createMatchingBudget({ ...limits });
  const request = async (options) => {
    assert.equal(options.requestPolicy, requestPolicy);
    const attempt = requestPolicy.beginAttempt({ provider: 'openai', model: 'synthetic', timeoutMs: 90000 });
    try {
      const result = await handler(options);
      attempt.finish({ status: 'success' });
      return result;
    } catch (error) {
      attempt.finish({ status: error.code === 'OPENAI_REQUEST_TIMEOUT' ? 'timeout' : 'error', error });
      throw error;
    }
  };
  return { request, requestPolicy };
}

test('a timed-out eight-paper screening batch splits once, preserving earlier leads and every original answer image', async () => {
  const calls = [];
  const images = Array.from({ length: 17 }, (_, i) => ({ ...answerInput, image_url: `data:image/png;base64,${Buffer.from(`original source ${i + 1}`).toString('base64')}` }));
  const originalContent = [{ type: 'input_text', text: 'Original teacher context.' }, ...images];
  const transport = metered(async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    for (const original of originalContent) assert.ok(request.content.includes(original));
    let result;
    if (calls.length === 1) result = matched(2, [7]);
    else if (calls.length === 2) throw requestTimeout();
    else if (calls.length === 3) {
      assert.match(request.instructions, /timeout-recovery subset 1 of 2/);
      result = matched(11);
    } else if (calls.length === 4) {
      assert.match(request.instructions, /timeout-recovery subset 2 of 2/);
      result = matched(13, [16]);
    } else if (calls.length === 5) result = unresolved();
    else {
      assert.deepEqual(ids, [2, 7, 11, 13, 16]);
      assert.match(request.instructions, /This is the final comparison/);
      result = matched(13, [16]);
    }
    return { ...result, pages: images.map((_, i) => ({ ...result.pages[0], page: i + 1 })) };
  });
  const result = await compareQuestionBank(options(17, transport.request, { requestPolicy: transport.requestPolicy, content: originalContent }));
  assert.deepEqual(calls.map(ids => ids.length), [8, 8, 4, 4, 1, 5]);
  assert.equal(transport.requestPolicy.snapshot().attempts, 6);
  assert.deepEqual(result.considered_candidate_ids, candidates.slice(0, 17).map(p => p.id));
  assert.deepEqual(result.papers[0].alternatives, [16]);
  assert.equal(result.bank_comparison.recovery_split_count, 1);
  assert.equal(result.bank_comparison.screening_leaf_count, 4);
  assert.equal(result.bank_comparison.complete, true);
});

test('the five-paper last batch of a twenty-one-paper bank splits into three and two without dropping a late contender', async () => {
  const calls = [];
  const bank = [...candidates, { ...candidates[0], id: 21 }];
  const transport = metered(async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    if (calls.length === 3) throw requestTimeout();
    return ids.includes(21) ? matched(21) : unresolved();
  });
  const result = await compareQuestionBank(options(20, transport.request, {
    requestPolicy: transport.requestPolicy, candidates: bank,
    paperInputs: async paper => [{ type: 'input_file', filename: `paper-${paper.id}.pdf`, file_data: `data:application/pdf;base64,${fullPdf(paper.id).toString('base64')}` }],
  }));
  assert.deepEqual(calls, [[1,2,3,4,5,6,7,8], [9,10,11,12,13,14,15,16], [17,18,19,20,21], [17,18,19], [20,21], [21]]);
  assert.deepEqual(result.considered_candidate_ids, bank.map(p => p.id));
  assert.equal(result.pages[0].paper_id, 21);
  assert.equal(transport.requestPolicy.snapshot().attempts, 6);
});

test('a timed-out recovery child aborts without recursion or accepting its sibling', async () => {
  const calls = [];
  const transport = metered(async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    if (calls.length !== 2) throw requestTimeout();
    return matched(1);
  });
  await assert.rejects(compareQuestionBank(options(9, transport.request, { requestPolicy: transport.requestPolicy })), error => {
    assert.match(error.message, /recovery subset 2 of 2/);
    assert.match(error.message, /incomplete; no match was accepted/);
    assert.deepEqual(error.considered_candidate_ids, [1, 2, 3, 4]);
    assert.deepEqual(error.failed_candidate_ids, [5, 6, 7, 8]);
    return true;
  });
  assert.deepEqual(calls.map(ids => ids.length), [8, 4, 4]);
  assert.equal(transport.requestPolicy.snapshot().attempts, 3);
});

test('screening recovery cannot split a final comparison or promote provisional evidence when it times out', async () => {
  const calls = [];
  const transport = metered(async (request) => {
    calls.push(suppliedIds(request));
    if (calls.length === 1 || calls.length === 5) throw requestTimeout();
    return matched(suppliedIds(request)[0]);
  });
  await assert.rejects(compareQuestionBank(options(9, transport.request, { requestPolicy: transport.requestPolicy })), /final comparison failed/);
  assert.deepEqual(calls.map(ids => ids.length), [8, 4, 4, 1, 3]);
});

test('a small-bank final timeout and a singleton screening timeout are never split', async () => {
  for (const count of [7, 9]) {
    let calls = 0;
    const transport = metered(async () => {
      calls += 1;
      if (count === 7 || calls === 2) throw requestTimeout();
      return matched(1);
    });
    await assert.rejects(compareQuestionBank(options(count, transport.request, { requestPolicy: transport.requestPolicy })), /incomplete; no match was accepted/);
    assert.equal(calls, count === 7 ? 1 : 2);
  }
});

test('recovery is unavailable without a shared packet policy', async () => {
  let calls = 0;
  await assert.rejects(compareQuestionBank(options(9, async () => { calls += 1; throw requestTimeout(); })), /incomplete/);
  assert.equal(calls, 1);
});

test('budget, persistence, ordinary provider and malformed-evidence failures never trigger screening recovery', async () => {
  for (const code of ['MATCHING_BUDGET_EXHAUSTED', 'MATCHING_BUDGET_PERSISTENCE_FAILED', 'HTTP_503', null]) {
    let calls = 0;
    const transport = metered(async () => {
      calls += 1;
      if (code) throw Object.assign(new Error('Synthetic timeout-like text must not control recovery.'), { code });
      return { pages: [], papers: [] };
    });
    await assert.rejects(compareQuestionBank(options(9, transport.request, { requestPolicy: transport.requestPolicy })), /incomplete/);
    assert.equal(calls, 1);
  }
});

test('every recovery request consumes the existing shared attempt budget and exhaustion stops before another provider call', async () => {
  let calls = 0;
  const transport = metered(async () => {
    calls += 1;
    if (calls === 1) throw requestTimeout();
    return matched(1);
  }, { maxProviderAttempts: 2 });
  await assert.rejects(compareQuestionBank(options(9, transport.request, { requestPolicy: transport.requestPolicy })), error => {
    assert.equal(error.cause.code, 'MATCHING_BUDGET_EXHAUSTED');
    assert.deepEqual(error.considered_candidate_ids, [1, 2, 3, 4]);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(transport.requestPolicy.snapshot().attempts, 2);
});

test('a deadline exhausted by the original timeout admits no recovery provider call', async () => {
  let now = 0, calls = 0;
  const transport = metered(async () => {
    calls += 1;
    now = 100;
    throw requestTimeout();
  }, { packetTimeoutMs: 100, requestTimeoutMs: 90, clock: () => now });
  await assert.rejects(compareQuestionBank(options(9, transport.request, { requestPolicy: transport.requestPolicy })), error => {
    assert.equal(error.cause.code, 'MATCHING_BUDGET_EXHAUSTED');
    assert.equal(error.cause.reason, 'packet_deadline');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(transport.requestPolicy.snapshot().attempts, 1);
});

test('too many contenders after a split still fail the joint-finalist limit without dropping any paper', async () => {
  const calls = [];
  const transport = metered(async (request) => {
    const ids = suppliedIds(request);
    calls.push(ids);
    if (calls.length === 1) throw requestTimeout();
    return matched(ids[0], ids.slice(1));
  });
  await assert.rejects(compareQuestionBank(options(20, transport.request, { requestPolicy: transport.requestPolicy })), error => {
    assert.equal(error.code, 'QUESTION_BANK_FINALIST_LIMIT');
    assert.deepEqual(error.considered_candidate_ids, candidates.map(p => p.id));
    assert.deepEqual(error.finalist_ids, candidates.map(p => p.id));
    return true;
  });
  assert.deepEqual(calls.map(ids => ids.length), [8, 4, 4, 8, 4]);
});

test('writing seen by a recovery child cannot become a blank in the final comparison', async () => {
  let calls = 0;
  const transport = metered(async () => {
    calls += 1;
    if (calls === 1) throw requestTimeout();
    if (calls === 2) return matched(1);
    return unresolved({ has_answers: false });
  });
  const result = await compareQuestionBank(options(9, transport.request, { requestPolicy: transport.requestPolicy }));
  assert.equal(calls, 5);
  assert.deepEqual(result.blank_conflict_pages, [1]);
  assert.equal(result.pages[0].has_answers, true);
  assert.equal(result.pages[0].paper_id, 0);
});

test('unresolved profile bank discovers cross-profile master with every full PDF and same budget', async () => {
  const calls = [];
  const transport = metered(async request => {
    const ids = suppliedIds(request); calls.push(ids);
    assert.ok(request.content.includes(answerInput));
    for (const input of request.content.filter(value => value.type === 'input_file')) {
      const id = Number(input.filename.match(/\d+/)[0]);
      assert.deepEqual(Buffer.from(input.file_data.split(',')[1], 'base64'), fullPdf(id));
    }
    return ids.includes(2) ? matched(2) : unresolved();
  });
  const result = await compareWithProfileFallback({ ...options(1, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0, 2) });
  assert.deepEqual(calls, [[1], [1, 2]]);
  assert.equal(result.pages[0].paper_id, 2);
  assert.equal(result.bank_comparison.profile_fallback, true);
  assert.equal(transport.requestPolicy.snapshot().attempts, 2);
  assert.equal(transport.requestPolicy.snapshot().limits.maxProviderAttempts, 40);
});

test('empty profile bank discovers wider masters and clear initial result does not repeat', async () => {
  for (const empty of [true, false]) {
    let calls = 0;
    const transport = metered(async () => { calls++; return matched(1); });
    const result = await compareWithProfileFallback({ ...options(empty ? 0 : 1, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0, 2) });
    assert.equal(calls, 1); assert.equal(result.pages[0].paper_id, 1);
  }
});

test('wider discovery consumes the existing attempt budget', async () => {
  const transport = metered(async () => unresolved(), { maxProviderAttempts: 1 });
  await assert.rejects(compareWithProfileFallback({ ...options(1, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0, 2) }), /budget|attempt|limit/i);
  assert.equal(transport.requestPolicy.snapshot().attempts, 1);
});

for (const kind of ['writing', 'conflict', 'different_master']) test(`wider pass cannot erase prior ${kind} evidence`, async () => {
  let calls = 0;
  const transport = metered(async () => {
    calls++;
    if (calls === 1) return kind === 'conflict' ? { ...matched(1), pages: [page(1, { header_evidence: { status: 'conflict', reason: 'Explicit version differs.' } })] } : matched(1);
    return kind === 'writing' ? { pages: [page(0, { has_answers: false })], papers: [] } : matched(kind === 'different_master' ? 2 : 1);
  });
  const result = await compareWithProfileFallback({ ...options(1, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0, 2), needsFallback: () => true });
  assert.equal(result.pages[0].has_answers, true);
  assert.equal(result.pages[0].paper_id, 0);
  assert.equal(result.pages[0].header_evidence.status, 'unresolved');
});

test('caller acceptance check triggers wider discovery for high but ungrounded summary', async () => {
  let calls = 0;
  const transport = metered(async () => { calls++; return calls === 1 ? { pages: [page(1)], papers: [summary(1, [], { matched_question_labels: [] })] } : matched(1); });
  await compareWithProfileFallback({ ...options(1, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0, 2), needsFallback: result => !result.papers[0].matched_question_labels.length });
  assert.equal(calls, 2);
});

test('parallel screening is capped at two, covers every full master and waits before final comparison', async () => {
  let active = 0, peak = 0; const calls = [];
  const transport = metered(async request => {
    const ids = suppliedIds(request); calls.push(ids);
    assert.ok(request.content.includes(answerInput));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 12)); active--;
    return matched(ids.includes(17) ? 17 : ids[0]);
  });
  const result = await compareQuestionBank(options(20, transport.request, { requestPolicy: transport.requestPolicy, screeningConcurrency: 2 }));
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.deepEqual(calls.slice(0, 3).flat().sort((a,b) => a-b), candidates.map(p => p.id));
  assert.deepEqual(calls.at(-1), [1,9,17]);
  assert.equal(result.pages[0].paper_id, 17);
  assert.equal(transport.requestPolicy.snapshot().attempts, 4);
});

for (const cancellationThrows of [false, true]) test(`parallel failure drains started requests before rejection, cancellation error=${cancellationThrows}`, async () => {
  let calls = 0, secondSettled = false, admitSecond;
  const secondStarted = new Promise(resolve => { admitSecond = resolve; });
  const transport = metered(async request => {
    calls++;
    if (calls === 1) { await secondStarted; throw new Error('Synthetic fatal batch failure'); }
    admitSecond(); await new Promise(resolve => setTimeout(resolve, 30));
    secondSettled = true; return matched(suppliedIds(request)[0]);
  });
  const policy = cancellationThrows ? { ...transport.requestPolicy, cancel() { transport.requestPolicy.cancel(); throw new Error('Synthetic cancellation persistence failure'); } } : transport.requestPolicy;
  const request = cancellationThrows ? args => transport.request({ ...args, requestPolicy: transport.requestPolicy }) : transport.request;
  await assert.rejects(compareQuestionBank(options(20, request, { requestPolicy: policy, screeningConcurrency: 2 })), /Synthetic/);
  assert.equal(secondSettled, true); assert.equal(calls, 2);
  assert.equal(transport.requestPolicy.snapshot().activeAttempts, 0);
});

test('same-run reuse retains all initial screening contenders, including a rejected final alternative', async () => {
  let calls = 0, assertions = 0; const supplied = [], primary = [];
  const transport = metered(async request => {
    calls++; const ids = suppliedIds(request); supplied.push(ids);
    assert.ok(request.content.includes(answerInput));
    if (calls === 1) return matched(2, [3]);
    if (calls === 2) return unresolved();
    if (calls === 3) return matched(2); // 3 lost only in final comparison, not screening.
    assert.deepEqual(ids, [2,3,10]); return matched(10);
  });
  const result = await compareWithProfileFallback({ ...options(9, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0,10), needsFallback: () => true,
    assertSourcesUnchanged: () => { assertions++; }, onPrimaryComplete: result => primary.push(structuredClone(result)) });
  assert.equal(assertions, 2); assert.equal(primary.length, 1);
  assert.deepEqual(result.considered_candidate_ids, candidates.slice(0,10).map(p => p.id));
  assert.deepEqual(result.bank_comparison.finalist_ids, [2,3,10]);
  assert.equal(result.pages[0].paper_id, 0); // Conflicting prior clear master cannot be silently replaced.
});

test('failed wider comparison preserves completed primary diagnostics but never accepts partial coverage', async () => {
  let calls = 0; const saved = [], progress = [];
  const transport = metered(async () => { calls++; if (calls === 1) return unresolved(); throw new Error('Synthetic wider failure'); });
  await assert.rejects(compareWithProfileFallback({ ...options(1, transport.request, { requestPolicy: transport.requestPolicy }), fallbackCandidates: candidates.slice(0,2),
    assertSourcesUnchanged() {}, onPrimaryComplete: result => saved.push(structuredClone(result)), onProgress: state => progress.push(structuredClone(state)) }), /Synthetic wider failure/);
  assert.equal(saved.length, 1); assert.equal(saved[0].bank_comparison.complete, true);
  const last = progress.at(-1); assert.equal(last.complete, false); assert.equal(last.profile_fallback, true);
  assert.equal(last.candidate_count, 2); assert.deepEqual(last.completed_candidate_ids, [1]);
});

test('parallel screening rejects a budget without cancellation before provider work', async () => {
  let calls = 0;
  await assert.rejects(compareQuestionBank(options(20, async () => { calls++; return unresolved(); }, {
    screeningConcurrency: 2, requestPolicy: { beginAttempt() {} },
  })), /shared cancellable request budget/);
  assert.equal(calls, 0);
});
