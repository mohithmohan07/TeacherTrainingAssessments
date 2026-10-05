// A teacher's results in a test, section by section. There is no overall
// percentage: each section the teacher sat is graded on its own, and sections
// they did not sit are simply not there. A teacher can sit sections on
// different dates, so the results gather every marked sitting in the test;
// if a section was marked more than once, the latest marking counts.
import crypto from 'node:crypto';
import db from './db.js';
import { levelsFromText } from './papers.js';

// Grade bands, applied to each section's percentage.
export const GRADES = [
  { min: 85, grade: 'A', label: 'Exemplary' },
  { min: 70, grade: 'B', label: 'Proficient' },
  { min: 50, grade: 'C', label: 'Developing' },
  { min: 0, grade: 'D', label: 'Beginning' },
];

// The programme's sections (see paper-formats.js). Section B is written for
// the teacher's subject, or for arts, music, dance and PE teachers.
export const SECTION_TITLES = {
  A: 'Interpersonal & Instructional Communication Skills',
  B: 'Subject Knowledge, Classroom Management & Child Psychology',
  C: 'Computer Knowledge & Digital Teaching Skills',
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
  const match = /^(?:section|part)\s*[-:]?\s*['"‘’]?([a-z])\b/i.exec(text);
  if (match) return match[1].toUpperCase();
  return indicSectionLetter(text) ?? text;
}

export function sectionName(key) {
  if (!key) return 'Whole paper';
  return /^[A-Z]$/.test(key) ? `Section ${key}` : key;
}

const round = (n) => Math.round(n * 100) / 100;

function groupSections(aiResult) {
  const sections = new Map();
  for (const q of aiResult?.questions ?? []) {
    const key = sectionKey(q.section);
    if (!sections.has(key)) sections.set(key, { key, awarded: 0, max: 0, questions: [] });
    const section = sections.get(key);
    section.awarded += Number(q.marks_awarded) || 0;
    section.max += Number(q.max_marks) || 0;
    section.questions.push(q);
  }
  return [...sections.values()];
}

const answered = (q) => String(q.teacher_answer ?? '').trim() !== '' || Number(q.marks_awarded) > 0;

// A question in a section the teacher sat with nothing written and no marks.
export const isBlank = (q) => !answered(q);

// A section with nothing written against any of its questions was not sat,
// so it is left out rather than graded 0. This matters when the whole paper
// is scanned but the teacher sat only some sections that day. The marking
// writes down what the teacher wrote for every question, so an empty answer
// with no marks means nothing was written.
const sectionWasSat = (section) => section.questions.some(answered);

// The sections of one marked sitting that the teacher sat.
export function sittingSections(aiResult) {
  return groupSections(aiResult)
    .filter(sectionWasSat)
    .map((s) => describe({ ...s, awarded: round(s.awarded), max: round(s.max) }));
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

// Every section the teacher has results for in this test, A to Z.
export function teacherResults(teacherId, testId) {
  const bySection = new Map();
  const sittings = selectSittings.all(teacherId, testId);
  for (const sitting of sittings) {
    // The last marking that finished; a re-mark that failed leaves it in place.
    const result = sitting.ai_result ? JSON.parse(sitting.ai_result) : null;
    const common = { assessment_id: sitting.id, date: sitting.assessment_date, evaluated_at: sitting.ai_evaluated_at };
    if (result) {
      for (const section of sittingSections(result)) {
        bySection.set(section.key, {
          ...section,
          ...common,
          summary: result.summary,
          strengths: result.strengths,
          areas_to_improve: result.areas_to_improve,
        });
      }
    } else if (sitting.status === 'evaluated' && sitting.score !== null && Number(sitting.max_score) > 0) {
      // Marked by hand, without a question-by-question breakdown.
      bySection.set('', { ...describe({ key: '', awarded: sitting.score, max: Number(sitting.max_score), questions: [] }), ...common });
    }
  }
  return [...bySection.values()].sort((a, b) => a.key.localeCompare(b.key));
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
  const names = (list) => list.map((s) => s.name).join(', ');
  // "Section A", or "Sections A and B" when there are two.
  const sectionList = (list) =>
    list.length > 1 && list.every((s) => /^[A-Z]$/.test(s.key))
      ? `Sections ${list.slice(0, -1).map((s) => s.key).join(', ')} and ${list.at(-1).key}`
      : names(list);

  let level;
  let headline;
  let meaning;
  if (exemplary.length === graded.length) {
    level = 'mentor';
    headline = 'Mentor Potential';
    meaning = 'Exemplary in every section sat. A candidate to guide colleagues and lead training.';
  } else if (strengths.length === graded.length) {
    level = 'strong';
    headline = 'Strong Performer';
    meaning = 'Proficient or better in every section sat. Ready for more responsibility in these areas.';
  } else if (strengths.length) {
    const developing = graded.filter((s) => s.grade === 'C');
    level = 'emerging';
    headline = `Strength in ${sectionList(strengths)}`;
    meaning = [
      'A real strength to build on.',
      developing.length ? `Still developing in ${sectionList(developing)}.` : '',
      support.length ? `Needs focused support in ${sectionList(support)}.` : '',
    ].filter(Boolean).join(' ');
  } else if (!support.length) {
    level = 'developing';
    headline = 'Developing Steadily';
    meaning = 'Developing in every section sat. Regular training and practice should lift these to proficient.';
  } else {
    level = 'support';
    headline = 'Priority for Support';
    meaning = `Needs focused support in ${sectionList(support)} before other responsibilities.`;
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
    evidence: sat && sat < areas.length ? `Based on ${sat} of ${areas.length} sections so far.` : `Based on ${graded.length} section${graded.length === 1 ? '' : 's'}.`,
    provisional: sat < areas.length,
  };
}

// How a teacher stands overall, from their lowest grade: on track when every
// section sat is Proficient or better, developing when the lowest is C, and
// in need of support with any section at D. These match the training rule:
// a section at C or D is what puts a teacher on a growth path.
export const NEEDS = [
  { key: 'on_track', label: 'On Track', meaning: 'Grade B or better in every section taken' },
  { key: 'developing', label: 'Developing', meaning: 'A section at Grade C, none at Grade D' },
  { key: 'support', label: 'Needs Support', meaning: 'A section at Grade D' },
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
  return sections.map((s) => [s.key, s.assessment_id, s.awarded, s.max, s.evaluated_at]);
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
