// A teacher's results in a test, section by section. There is no overall
// percentage: each section the teacher sat is graded on its own, and sections
// they did not sit are simply not there. A teacher can sit sections on
// different dates, so the results gather every marked sitting in the test;
// if a section was marked more than once, the latest marking counts.
import crypto from 'node:crypto';
import { currentSourceBasis, digest } from './provenance.js';
import db from './db.js';
import { levelsFromText } from './papers.js';
import { sectionWriting, writingOf } from './writing.js';

// Grade bands, applied to each section's percentage, named in everyday words.
export const GRADES = [
  { min: 85, grade: 'A', label: 'Excellent' },
  { min: 70, grade: 'B', label: 'Good' },
  { min: 50, grade: 'C', label: 'Fair' },
  { min: 0, grade: 'D', label: 'Needs Practice' },
];

// The programme's sections (see paper-formats.js). Section B is written for
// the teacher's subject, or for arts, music, dance and PE teachers.
export const SECTION_TITLES = {
  A: 'Interpersonal & Instructional Communication Skills',
  B: 'Subject Knowledge, Classroom Management & Child Psychology',
  C: 'Computer Knowledge & Digital Teaching Skills',
};

// A section's name in every report's text: the programme's title for it, the
// same for every teacher, so a reader never needs to know what a letter means.
export const sectionTitleOf = (section) => {
  const title = SECTION_TITLES[section.key] ?? section.title ?? section.name;
  // One of a teacher's Section B papers in different subjects.
  return section.subject ? `${title} (${section.subject})` : title;
};

// What a strong result in each section suggests a teacher could take on.
const SECTION_ROLES = {
  A: 'parent communication and peer mentoring on classroom talk',
  B: 'subject mentoring for colleagues',
  C: 'leading digital teaching in the school',
};

export function gradeFor(percent) {
  if (percent === null || percent === undefined) return null;
  return GRADES.find((band) => percent >= band.min);
}

// Section names on the programme's papers in Indian languages, for when the
// marking copies one from the paper instead of writing it in English as
// asked: खंड 'ख', विभाग ब, ಭಾಗ-ಆ, பகுதி இ, বিভাগ খ and so on.
const INDIC_SECTION_WORDS = ['खंड', 'खण्ड', 'विभाग', 'भाग', 'ವಿಭಾಗ', 'ಭಾಗ', 'பகுதி', 'பிரிவு', 'విభాగం', 'భాగం', 'വിഭാഗം', 'ഭാഗം', 'বিভাগ', 'খণ্ড'];
const INDIC_SECTION_LETTERS = {
  A: ['क', 'अ', 'ಕ', 'ಅ', 'ಎ', 'க', 'அ', 'క', 'అ', 'ఎ', 'ക', 'അ', 'എ', 'ক', 'অ', 'এ'],
  B: ['ख', 'ब', 'ಖ', 'ಆ', 'ಬಿ', 'ஆ', 'బి', 'ఖ', 'ఆ', 'ഖ', 'ആ', 'ബി', 'খ', 'আ', 'বি'],
  C: ['ग', 'स', 'ಗ', 'ಇ', 'ಸಿ', 'இ', 'సి', 'గ', 'ఇ', 'ഗ', 'ഇ', 'സി', 'গ', 'ই', 'সি'],
};
const QUOTES = /['"‘’“”`]/gu;

function indicSectionLetter(text) {
  const plain = text.replace(QUOTES, ' ').replace(/[-–—:.()]/gu, ' ').trim().split(/\s+/u);
  // "खंड ख" as well as "ख खंड" / "ক-বিভাগ"
  for (const [word, letter] of [[plain[0], plain[1]], [plain[1], plain[0]]]) {
    if (!INDIC_SECTION_WORDS.includes(word) || !letter) continue;
    if (/^[a-z]$/i.test(letter)) return letter.toUpperCase();
    const key = Object.keys(INDIC_SECTION_LETTERS).find((k) => INDIC_SECTION_LETTERS[k].includes(letter));
    if (key) return key;
  }
  return null;
}

// "Section A" (or "section a", "SECTION A:", "Part A", "खंड 'क'") → "A". A
// paper with no sections is kept as one block under the key "".
export function sectionKey(name) {
  const text = String(name ?? '').trim();
  if (/^whole paper$/i.test(text)) return '';
  const match = /^(?:section|part)\s*[-:]?\s*['"‘’]?([a-z])\b/i.exec(text);
  if (match) return match[1].toUpperCase();
  return indicSectionLetter(text) ?? text;
}

export function sectionName(key) {
  if (!key) return 'Whole paper';
  return /^[A-Z]$/.test(key) ? `Section ${key}` : key;
}

const round = (n) => Math.round(n * 100) / 100;

// How a sitting's marks are counted, chosen each time Evaluate is pressed.
// Standard counts every question, so one not attempted scores 0 out of its
// marks. Lenient leaves the questions the teacher did not attempt out of both
// the marks and the total. Marking the answers is the same either way.
export const MARKINGS = [
  { key: 'standard', label: 'Standard', meaning: 'Every question counts. A question left blank gets 0 and stays in the total.' },
];

// The kind of a marking; markings made before there was a choice are standard.
export const markingOf = (value) => (value === 'lenient' ? 'lenient' : 'standard');

const answered = (q) => String(q.teacher_answer ?? '').trim() !== '' || Number(q.marks_awarded) > 0;

// A question in a section the teacher sat with nothing written and no marks.
export const isBlank = (q) => boundedQuestion(q) && questionState(q) !== 'assessed' ? false : q.response_status ? q.response_status === 'unanswered' : !answered(q);

// New evidence-bounded results distinguish an unassessable answer from zero.
// Old results without these fields retain their original counting rules.
const UNASSESSABLE_RESPONSES = new Set(['unreadable', 'missing_page', 'extraction_failure', 'unmatched', 'identity_unresolved', 'marking_unavailable', 'paper_unavailable']);
const boundedQuestion = (q) => q.assessment_state !== undefined || q.qualification !== undefined || q.marks_awarded === null;
const boundedResult = (result) => Boolean(result?.outcome || result?.completion || result?.questions?.some(boundedQuestion));
const questionState = (q, submissionSection) => {
  if (submissionSection?.status === 'not_supplied' || q.assessment_state === 'not_supplied' || q.response_status === 'section_not_supplied') return 'not_supplied';
  if (q.assessment_state === 'unassessable' || UNASSESSABLE_RESPONSES.has(q.response_status) || q.marks_awarded === null || q.marks_awarded === undefined || !Number.isFinite(Number(q.marks_awarded))) return 'unassessable';
  return 'assessed';
};

// Pure coverage metadata. Printed maxima are never rescaled: an assessed
// partial answer retains its full printed maximum, while an unassessable row
// remains visible in the supplied maximum and outside the assessed subset.
export function coverageOf(questions = [], submissionSection) {
  const coverage = { state: 'unassessable', assessed_questions: 0, unassessable_questions: 0, not_supplied_questions: 0, assessed_max: 0, unassessable_max: 0, supplied_max: 0, total_max: 0 };
  let limited = false;
  for (const q of questions) {
    const state = questionState(q, submissionSection);
    const max = Number.isFinite(Number(q.max_marks)) && Number(q.max_marks) > 0 ? Number(q.max_marks) : 0;
    coverage[`${state}_questions`] += 1;
    coverage.total_max += max;
    if (state !== 'not_supplied') {
      coverage.supplied_max += max;
      coverage[`${state}_max`] += max;
    }
    if (state === 'assessed' && q.qualification === 'limited_readability') limited = true;
  }
  if (submissionSection?.status === 'not_supplied' || (questions.length && coverage.not_supplied_questions === questions.length)) coverage.state = 'not_supplied';
  else if (!coverage.assessed_questions) coverage.state = 'unassessable';
  else if (coverage.unassessable_questions || coverage.not_supplied_questions || limited || submissionSection?.status === 'incomplete') coverage.state = 'partial';
  else coverage.state = 'complete';
  for (const key of ['assessed_max', 'unassessable_max', 'supplied_max', 'total_max']) coverage[key] = round(coverage[key]);
  return coverage;
}

// All comparative/grade consumers use this predicate. A subset percentage is
// useful evidence, but must not become a section grade or a comparison.
export function gradeEligible(section) {
  if (!section || section.grade_eligible === false || section.outcome === 'no_assessment' || section.completion?.state === 'no_assessment') return false;
  if (section.coverage && section.coverage.state !== 'complete') return false;
  return typeof section.percent === 'number' && Number.isFinite(section.percent);
}

// Whether a question counts towards assessed marks and their denominator.
export const counts = (q, marking) => boundedQuestion(q)
  ? questionState(q) === 'assessed'
  : q.response_status
    ? !['section_not_supplied', 'missing_page', 'extraction_failure'].includes(q.response_status)
    : markingOf(marking) !== 'lenient' || answered(q);

function groupSections(aiResult) {
  const marking = markingOf(aiResult?.marking);
  const bounded = boundedResult(aiResult);
  const sections = new Map();
  const add = (key) => {
    if (!sections.has(key)) sections.set(key, { key, awarded: 0, max: 0, marking, left_out: 0, left_out_marks: 0, questions: [] });
    return sections.get(key);
  };
  for (const q of aiResult?.questions ?? []) {
    const section = add(sectionKey(q.section));
    section.questions.push(q);
    const supplied = aiResult?.submission?.sections?.find((s) => sectionKey(s.section) === section.key);
    if (!(bounded ? questionState(q, supplied) === 'assessed' : counts(q, marking))) {
      section.left_out += 1;
      section.left_out_marks += Number(q.max_marks) || 0;
      continue;
    }
    section.awarded += Number(q.marks_awarded) || 0;
    section.max += Number(q.max_marks) || 0;
  }
  if (bounded) {
    for (const supplied of aiResult?.submission?.sections ?? []) add(sectionKey(supplied.section));
    for (const section of sections.values()) {
      const supplied = aiResult?.submission?.sections?.find((s) => sectionKey(s.section) === section.key);
      section.coverage = coverageOf(section.questions, supplied);
      // An unassessable section has no score, rather than 0/0.
      if (!section.coverage.assessed_questions) section.awarded = section.max = null;
      section.outcome = aiResult.outcome;
      section.completion = aiResult.completion;
    }
  }
  return [...sections.values()];
}

const sectionWasSat = (section, result) => {
  if (section.coverage) return section.coverage.state !== 'not_supplied';
  const supplied = result?.submission?.sections?.find((s) => sectionKey(s.section) === section.key);
  if (supplied) return supplied.status === 'supplied_complete';
  return section.questions.some(answered); // Legacy results retain historical coverage.
};

// A completed attempt with no trusted ledger still produces a reportable
// status. It invents neither a question nor a printed maximum.
export function sittingSections(aiResult) {
  const sections = groupSections(aiResult)
    .filter((section) => sectionWasSat(section, aiResult))
    .map((s) => ({
      ...describe({ ...s, awarded: s.awarded === null ? null : round(s.awarded), max: s.max === null ? null : round(s.max), left_out_marks: round(s.left_out_marks) }),
      writing: sectionWriting(writingOf(aiResult?.writing, aiResult?.questions ?? []), s.key),
    }));
  if (!sections.length && (aiResult?.outcome === 'no_assessment' || aiResult?.completion?.state === 'no_assessment')) {
    const key = sectionKey(aiResult.completion?.section);
    return [{ key, name: key ? sectionName(key) : 'Assessment status', title: SECTION_TITLES[key] ?? '', questions: [], awarded: null, max: null, percent: null, grade: null, grade_label: null,
      marking: markingOf(aiResult.marking), left_out: 0, left_out_marks: 0, writing: null,
      coverage: coverageOf([]), grade_eligible: false, outcome: 'no_assessment', completion: aiResult.completion }];
  }
  return sections;
}

// Entire sections not supplied (or historically not sat), never a synonym
// for a supplied answer that could not be read.
export function unansweredSections(aiResult) {
  return groupSections(aiResult)
    .filter((section) => !sectionWasSat(section, aiResult))
    .map((section) => sectionName(section.key));
}

function describe(section) {
  const percent = section.max > 0 && section.awarded !== null ? round((section.awarded / section.max) * 100) : null;
  const eligible = gradeEligible({ ...section, percent });
  const band = eligible ? gradeFor(percent) : null;
  return {
    ...section,
    name: sectionName(section.key),
    title: SECTION_TITLES[section.key] ?? '',
    percent,
    grade: band?.grade ?? null,
    grade_label: band?.label ?? null,
    ...(section.coverage ? { grade_eligible: eligible } : {}),
  };
}

const selectSittings = db.prepare(
  `SELECT * FROM assessments
    WHERE teacher_id = ? AND test_id = ?
    ORDER BY COALESCE(ai_evaluated_at, updated_at), id`
);

// The Section B papers a sitting was marked against, from the library.
const selectSectionBPapers = db.prepare(
  `SELECT p.id, p.subject, p.title FROM assessment_papers ap JOIN papers p ON p.id = ap.paper_id
    WHERE ap.assessment_id = ? AND (',' || p.sections || ',') LIKE '%,B,%' ORDER BY ap.position`
);

const selectPaperIds = db.prepare('SELECT paper_id FROM assessment_papers WHERE assessment_id = ? ORDER BY paper_id');

// Every section the teacher has results for in this test, A to Z. Section B
// is written for the teacher's subject, and a teacher of two subjects can sit
// a Section B paper for each: each paper gets its own result and grade,
// named by its subject, "Section B (Mathematics)". Otherwise a section marked
// again (a re-sit of the same paper) replaces the earlier marks.
export function teacherResults(teacherId, testId) {
  const byPart = new Map();
  const sittings = selectSittings.all(teacherId, testId);
  const sittingById = new Map(sittings.map((sitting) => [sitting.id, sitting]));
  const selectionOf = (id) => selectPaperIds.all(id).map((paper) => paper.paper_id).join(',');
  for (const sitting of sittings) {
    if (sitting.status === 'assembling') continue;
    // The last marking that finished; a re-mark that failed leaves it in place.
    const result = sitting.ai_result ? JSON.parse(sitting.ai_result) : null;
    const evaluationStale = Boolean(result?.audit?.source_digest && result.audit.source_digest !== digest(currentSourceBasis(sitting.id)));
    const common = { evaluation_stale: evaluationStale, assessment_audit: result?.audit ?? null, submission: result?.submission ?? null, assessment_id: sitting.id, date: sitting.assessment_date, evaluated_at: sitting.ai_evaluated_at };
    if (result) {
      const bPapers = selectSectionBPapers.all(sitting.id);
      const sections = sittingSections(result);
      if (result.outcome === 'no_assessment' && sections.length === 1 && !sections[0].questions.length && !sections[0].key) {
        // A fresh whole-paper attempt supersedes the same earlier whole-paper
        // selection even when no trusted ledger remains to name its sections.
        const selection = selectionOf(sitting.id);
        for (const [part, previous] of byPart) {
          if (!sittingById.get(previous.assessment_id)?.section && selectionOf(previous.assessment_id) === selection) byPart.delete(part);
        }
      }
      for (const section of sections) {
        const part = section.key === 'B' && bPapers.length ? bPapers.map((p) => p.id).join(',') : '';
        byPart.set(`${section.key}|${part}`, {
          ...section,
          ...common,
          subject: section.key === 'B' ? bPapers.map((p) => p.subject).filter(Boolean).join(' and ') : '',
          summary: result.summary,
          strengths: result.strengths,
          areas_to_improve: result.areas_to_improve,
        });
      }
    } else if (sitting.status === 'evaluated' && sitting.score !== null && Number(sitting.max_score) > 0) {
      // Marked by hand, without a question-by-question breakdown.
      byPart.set('|', { ...describe({ key: '', awarded: sitting.score, max: Number(sitting.max_score), questions: [] }), ...common, subject: '' });
    }
  }
  const results = [...byPart.values()];
  // Only a section with more than one paper names its subjects; a single
  // Section B stays "Section B", as it always has.
  return results
    .map((s) => {
      const several = results.filter((other) => other.key === s.key).length > 1;
      const { subject, ...rest } = s;
      return several && subject ? { ...rest, subject, name: `${s.name} (${subject})` } : rest;
    })
    .sort((a, b) => a.key.localeCompare(b.key) || String(a.subject ?? '').localeCompare(String(b.subject ?? '')));
}

// The potential identifier on the management report. It is worked out from
// the section grades by fixed rules, so every teacher is judged the same way
// and the reasons can be read off the page:
//   - each section is a strength (grade A or B), developing (C) or a support
//     priority (D);
//   - the headline follows from those, and says how many of the three sections
//     it rests on, since one section is thin evidence.
export function potentialFor(sections) {
  if (sections.some((s) => (s.coverage || s.grade_eligible === false || s.outcome === 'no_assessment') && s.coverage?.state !== 'not_supplied' && !gradeEligible(s))) return null;
  const graded = sections.filter(gradeEligible);
  if (!graded.length) return null;

  const strengths = graded.filter((s) => s.grade === 'A' || s.grade === 'B');
  const support = graded.filter((s) => s.grade === 'D');
  const exemplary = graded.filter((s) => s.grade === 'A');
  // The sections by name: "Computer Knowledge & Digital Teaching Skills".
  const about = (list) => {
    const titles = list.map(sectionTitleOf);
    return titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0];
  };

  let level;
  let headline;
  let meaning;
  if (exemplary.length === graded.length) {
    level = 'mentor';
    headline = 'Can Guide Other Teachers';
    meaning = 'Grade A (Excellent) in every section taken. Could help train and guide other teachers.';
  } else if (strengths.length === graded.length) {
    level = 'strong';
    headline = 'Strong in Every Section';
    meaning = 'Grade A or B (Excellent or Good) in every section taken. Ready to take on more responsibility.';
  } else if (strengths.length) {
    const developing = graded.filter((s) => s.grade === 'C');
    level = 'emerging';
    headline = 'Strong in Some Sections';
    meaning = [
      `Good or better in ${about(strengths)}.`,
      developing.length ? `Needs some practice in ${about(developing)}.` : '',
      support.length ? `Needs extra help in ${about(support)}.` : '',
    ].filter(Boolean).join(' ');
  } else if (!support.length) {
    level = 'developing';
    headline = 'Fair in Every Section';
    meaning = 'Grade C (Fair) in every section taken. Regular training and practice should lift these to Grade B (Good).';
  } else {
    level = 'support';
    headline = 'Needs Help First';
    meaning = `Needs extra help in ${about(support)} before taking on other duties.`;
  }

  const areas = Object.keys(SECTION_TITLES);
  // Two Section B papers are still one of the three sections.
  const sat = new Set(graded.filter((s) => areas.includes(s.key)).map((s) => s.key)).size;
  return {
    level,
    headline,
    meaning,
    strengths: strengths.map((s) => s.name),
    developing: graded.filter((s) => s.grade === 'C').map((s) => s.name),
    support: support.map((s) => s.name),
    roles: exemplary.filter((s) => SECTION_ROLES[s.key]).map((s) => ({ section: s.name, role: SECTION_ROLES[s.key] })),
    evidence: sat && sat < areas.length ? `Based on ${sat} of ${areas.length} sections so far.` : sat === areas.length ? `Based on all ${areas.length} sections.` : `Based on ${graded.length} section${graded.length === 1 ? '' : 's'}.`,
    provisional: sat < areas.length,
  };
}

// How a teacher stands overall, from their lowest grade: doing well when
// every section sat is Good (B) or better, needing some support when the
// lowest is C, and more support with any section at D. These match the training rule:
// a section at C or D is what puts a teacher on a growth path.
export const NEEDS = [
  { key: 'on_track', label: 'Doing Well', meaning: 'Grade A or B (Excellent or Good) in every section taken' },
  { key: 'developing', label: 'Needs Some Support', meaning: 'Lowest grade is C (Fair), in at least one section' },
  { key: 'support', label: 'Needs More Support', meaning: 'Grade D (Needs Practice) in at least one section' },
];

export function needOf(sections) {
  if (sections.some((s) => (s.coverage || s.grade_eligible === false || s.outcome === 'no_assessment') && s.coverage?.state !== 'not_supplied' && !gradeEligible(s))) return null;
  const grades = sections.filter((s) => gradeEligible(s) && s.grade).map((s) => s.grade);
  if (!grades.length) return null;
  if (grades.includes('D')) return 'support';
  return grades.includes('C') ? 'developing' : 'on_track';
}

// The school stages the report on all teachers is split by, youngest first.
export const STAGES = [
  { key: 'pre-primary', name: 'Pre-Primary', classes: 'Nursery to UKG' },
  { key: 'primary', name: 'Primary', classes: 'Classes 1 to 5' },
  { key: 'middle-school', name: 'Middle School', classes: 'Classes 6 to 8' },
  { key: 'secondary', name: 'High School', classes: 'Classes 9 and 10' },
  { key: 'senior-secondary', name: 'PUC', classes: 'I and II PUC' },
];

// A teacher's stage, read from the classes typed as their grade. Someone who
// teaches across stages is counted in the highest; null when the grade names
// no class.
export function stageOf(gradeText) {
  const levels = levelsFromText(gradeText);
  return STAGES.findLast((stage) => levels.has(stage.key))?.key ?? null;
}

// A short fingerprint of results, so a report can tell whether the marks it
// was written from have changed since.
export function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function resultsBasis(sections) {
  return sections.map((s) => ({ key: s.key, subject: s.subject, assessment_id: s.assessment_id,
    awarded: s.awarded, max: s.max, percent: s.percent, grade: s.grade, marking: s.marking,
    questions: s.questions, writing: s.writing, summary: s.summary, strengths: s.strengths,
    areas_to_improve: s.areas_to_improve, submission: s.submission,
    coverage: s.coverage, grade_eligible: s.grade_eligible, outcome: s.outcome, completion: s.completion,
    audit: s.assessment_audit, evaluation_stale: s.evaluation_stale, evaluated_at: s.evaluated_at }));
}

/* ------------------------------------------------------------------- tests */

const selectLatestTest = db.prepare('SELECT * FROM tests WHERE school_id = ? ORDER BY id DESC LIMIT 1');
const insertTest = db.prepare('INSERT INTO tests (school_id, name) VALUES (?, ?)');
const selectTest = db.prepare('SELECT * FROM tests WHERE id = ?');

// The test to file a sitting under when none is named: the school's newest,
// or a first "Test 1" if the school has none yet.
export function defaultTestFor(schoolId) {
  const latest = selectLatestTest.get(schoolId);
  if (latest) return latest;
  return selectTest.get(insertTest.run(schoolId, 'Test 1').lastInsertRowid);
}

// The named test if it belongs to the school, otherwise the default.
export function testFor(schoolId, testId) {
  const test = testId ? selectTest.get(Number(testId)) : null;
  return test && test.school_id === schoolId ? test : defaultTestFor(schoolId);
}
