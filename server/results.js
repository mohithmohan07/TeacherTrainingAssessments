// A teacher's results in a test, section by section. There is no overall
// percentage: each section the teacher sat is graded on its own, and sections
// they did not sit are simply not there. A teacher can sit sections on
// different dates, so the results gather every marked sitting in the test;
// if a section was marked more than once, the latest marking counts.
import crypto from 'node:crypto';
import db from './db.js';
import { levelsFromText } from './papers.js';
import { levelFor as writingLevelFor, sectionWriting } from './writing.js';

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
export const sectionTitleOf = (section) => SECTION_TITLES[section.key] ?? section.title ?? section.name;

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
  { key: 'lenient', label: 'Lenient', meaning: 'Only the questions answered count. Questions left blank are not in the marks or the total.' },
];

// The kind of a marking; markings made before there was a choice are standard.
export const markingOf = (value) => (value === 'lenient' ? 'lenient' : 'standard');

const answered = (q) => String(q.teacher_answer ?? '').trim() !== '' || Number(q.marks_awarded) > 0;

// A question in a section the teacher sat with nothing written and no marks.
export const isBlank = (q) => !answered(q);

// Whether a question counts towards the marks and the total.
export const counts = (q, marking) => markingOf(marking) !== 'lenient' || answered(q);

function groupSections(aiResult) {
  const marking = markingOf(aiResult?.marking);
  const sections = new Map();
  for (const q of aiResult?.questions ?? []) {
    const key = sectionKey(q.section);
    if (!sections.has(key)) sections.set(key, { key, awarded: 0, max: 0, marking, left_out: 0, left_out_marks: 0, questions: [] });
    const section = sections.get(key);
    section.questions.push(q);
    if (!counts(q, marking)) {
      section.left_out += 1;
      section.left_out_marks += Number(q.max_marks) || 0;
      continue;
    }
    section.awarded += Number(q.marks_awarded) || 0;
    section.max += Number(q.max_marks) || 0;
  }
  return [...sections.values()];
}

// A section with nothing written against any of its questions was not sat,
// so it is left out rather than graded 0. This matters when the whole paper
// is scanned but the teacher sat only some sections that day. The marking
// writes down what the teacher wrote for every question, so an empty answer
// with no marks means nothing was written.
const sectionWasSat = (section) => section.questions.some(answered);

// The sections of one marked sitting that the teacher sat, each with its
// Written Expression (writing.js) when the sitting's writing was checked.
export function sittingSections(aiResult) {
  return groupSections(aiResult)
    .filter(sectionWasSat)
    .map((s) => ({
      ...describe({ ...s, awarded: round(s.awarded), max: round(s.max), left_out_marks: round(s.left_out_marks) }),
      writing: sectionWriting(aiResult?.writing, s.key),
    }));
}

// Sections on the paper that the teacher left entirely unanswered.
export function unansweredSections(aiResult) {
  return groupSections(aiResult)
    .filter((section) => !sectionWasSat(section))
    .map((section) => sectionName(section.key));
}

function describe(section) {
  const percent = section.max > 0 ? Math.round((section.awarded / section.max) * 100) : null;
  const band = gradeFor(percent);
  return {
    ...section,
    name: sectionName(section.key),
    title: SECTION_TITLES[section.key] ?? '',
    percent,
    grade: band?.grade ?? null,
    grade_label: band?.label ?? null,
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

// Every section the teacher has results for in this test, A to Z. Section B
// is written for the teacher's subject, and a teacher of two subjects can sit
// a Section B paper for each: their marks are added into one Section B
// result, which names the subjects. Otherwise a section marked again (a
// re-sit of the same paper) replaces the earlier marks.
export function teacherResults(teacherId, testId) {
  const byPart = new Map();
  const sittings = selectSittings.all(teacherId, testId);
  for (const sitting of sittings) {
    // The last marking that finished; a re-mark that failed leaves it in place.
    const result = sitting.ai_result ? JSON.parse(sitting.ai_result) : null;
    const common = { assessment_id: sitting.id, assessment_ids: [sitting.id], date: sitting.assessment_date, evaluated_at: sitting.ai_evaluated_at };
    if (result) {
      const bPapers = selectSectionBPapers.all(sitting.id);
      for (const section of sittingSections(result)) {
        const part = section.key === 'B' && bPapers.length ? bPapers.map((p) => p.id).join(',') : '';
        byPart.set(`${section.key}|${part}`, {
          ...section,
          ...common,
          subjects: section.key === 'B' ? bPapers.map((p) => p.subject).filter(Boolean) : [],
          summary: result.summary,
          strengths: result.strengths,
          areas_to_improve: result.areas_to_improve,
        });
      }
    } else if (sitting.status === 'evaluated' && sitting.score !== null && Number(sitting.max_score) > 0) {
      // Marked by hand, without a question-by-question breakdown.
      byPart.set('|', { ...describe({ key: '', awarded: sitting.score, max: Number(sitting.max_score), questions: [] }), ...common, subjects: [] });
    }
  }
  const bySection = new Map();
  for (const entry of byPart.values()) {
    if (!bySection.has(entry.key)) bySection.set(entry.key, []);
    bySection.get(entry.key).push(entry);
  }
  return [...bySection.values()]
    .map((parts) => (parts.length === 1 ? parts[0] : combineParts(parts)))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// One Section B result from a teacher's Section B papers in different
// subjects: the marks and totals added up and graded together, each paper's
// questions named with its subject, and each paper's own result kept in parts.
function combineParts(parts) {
  const sum = (key) => round(parts.reduce((total, p) => total + (Number(p[key]) || 0), 0));
  const label = (p) => p.subjects.join(' and ');
  const latest = parts.reduce((a, b) => (String(b.evaluated_at ?? '') > String(a.evaluated_at ?? '') ? b : a));
  const combined = describe({
    key: parts[0].key,
    awarded: sum('awarded'),
    max: sum('max'),
    left_out: sum('left_out'),
    left_out_marks: sum('left_out_marks'),
    marking: parts.some((p) => p.marking === 'lenient') ? 'lenient' : 'standard',
    questions: parts.flatMap((p) => p.questions.map((q) => (label(p) ? { ...q, question: `${q.question} (${label(p)})` } : q))),
  });
  return {
    ...combined,
    writing: combineWriting(parts.map((p) => p.writing)),
    assessment_id: parts[0].assessment_id,
    assessment_ids: parts.flatMap((p) => p.assessment_ids),
    date: latest.date,
    evaluated_at: latest.evaluated_at,
    subjects: parts.flatMap((p) => p.subjects),
    parts: parts.map((p) => ({ subjects: p.subjects, awarded: p.awarded, max: p.max, percent: p.percent, grade: p.grade, assessment_id: p.assessment_id })),
    summary: parts.map((p) => (label(p) ? `${label(p)}: ${p.summary}` : p.summary)).filter(Boolean).join(' '),
    strengths: parts.flatMap((p) => p.strengths ?? []),
    areas_to_improve: parts.flatMap((p) => p.areas_to_improve ?? []),
  };
}

// The Written Expression of the papers combined: the scores averaged over
// the papers judged, and every error listed.
function combineWriting(list) {
  const present = list.filter(Boolean);
  if (!present.length) return null;
  const unchecked = present.find((w) => !w.checked);
  if (unchecked) return unchecked;
  const judged = present.filter((w) => w.judged);
  const errors = present.flatMap((w) => w.errors ?? []);
  if (!judged.length) return { ...present[0], errors };
  const mean = (values) => Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  const score = mean(judged.map((w) => w.score));
  return {
    checked: true,
    judged: true,
    score,
    level: judged.length === 1 ? judged[0].level : writingLevelFor(score),
    summary: judged.map((w) => w.summary).filter(Boolean).join(' '),
    criteria: judged[0].criteria.map((c, i) => ({ label: c.label, score: mean(judged.map((w) => Number(w.criteria[i]?.score) || 0)) })),
    errors,
  };
}

// The potential identifier on the management report. It is worked out from
// the section grades by fixed rules, so every teacher is judged the same way
// and the reasons can be read off the page:
//   - each section is a strength (grade A or B), developing (C) or a support
//     priority (D);
//   - the headline follows from those, and says how many of the three sections
//     it rests on, since one section is thin evidence.
export function potentialFor(sections) {
  const graded = sections.filter((s) => s.percent !== null);
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
  const sat = graded.filter((s) => areas.includes(s.key)).length;
  return {
    level,
    headline,
    meaning,
    strengths: strengths.map((s) => s.name),
    developing: graded.filter((s) => s.grade === 'C').map((s) => s.name),
    support: support.map((s) => s.name),
    roles: exemplary.filter((s) => SECTION_ROLES[s.key]).map((s) => ({ section: s.name, role: SECTION_ROLES[s.key] })),
    evidence: sat && sat < areas.length ? `Based on ${sat} of ${areas.length} sections so far.` : graded.length === areas.length ? `Based on all ${areas.length} sections.` : `Based on ${graded.length} section${graded.length === 1 ? '' : 's'}.`,
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
  const grades = sections.filter((s) => s.percent !== null && s.grade).map((s) => s.grade);
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
  return sections.map((s) => [s.key, s.assessment_ids?.length > 1 ? s.assessment_ids : s.assessment_id, s.awarded, s.max, s.evaluated_at]);
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
