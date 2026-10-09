// A teacher's current sitting in a test: what the board's row uploads to, and
// where pages moved to that teacher go.
import db from './db.js';
import { subjectName } from './papers.js';

// The most recently created sitting in the test for the full paper or the
// section, not the latest by date: the date is editable, so a backdated entry
// must not become the current sitting.
const selectLatestAssessment = db.prepare(
  'SELECT * FROM assessments WHERE teacher_id = ? AND test_id = ? AND section IS ? ORDER BY id DESC LIMIT 1'
);

const insertAssessment = db.prepare(
  `INSERT INTO assessments (school_id, teacher_id, test_id, section, title, assessment_date, subject, status)
   VALUES (@school_id, @teacher_id, @test_id, @section, @title, date('now'), @subject, 'draft')`
);

const selectAssessmentById = db.prepare('SELECT * FROM assessments WHERE id = ?');

// The board row acts on the teacher's current sitting in the test, for the
// full paper or for the one section the board is working on. One that has
// already been evaluated is left alone: uploading again opens a new sitting
// in the same test, which is how a teacher sits Section A on one date and
// Sections B and C on another. Their results are added together.
export function currentAssessmentFor(teacher, test, section = null) {
  const latest = selectLatestAssessment.get(teacher.id, test.id, section);
  if (latest && latest.status !== 'evaluated') return latest;

  const info = insertAssessment.run({
    school_id: teacher.school_id,
    teacher_id: teacher.id,
    test_id: test.id,
    section,
    title: `${test.name} - ${teacher.name}${section ? ` - Section ${section}` : ''}`,
    subject: subjectName(String(teacher.subjects ?? '').split(',')[0]),
  });
  return selectAssessmentById.get(info.lastInsertRowid);
}

// Section B is written for the teacher's subject, and a teacher who teaches
// two subjects can sit a Section B paper for each in the same test. Each
// paper has its own sitting, so it is marked against its own question paper.
// The sitting for a Section B paper is the latest one not yet marked that
// has that paper or no paper yet; any other section works as above. `create`
// false finds the sitting without opening one.
const selectSectionSittings = db.prepare(
  'SELECT * FROM assessments WHERE teacher_id = ? AND test_id = ? AND section IS ? ORDER BY id DESC'
);
const selectPaperIds = db.prepare('SELECT paper_id FROM assessment_papers WHERE assessment_id = ? ORDER BY position');
const selectPaperRow = db.prepare('SELECT * FROM papers WHERE id = ?');

export function sittingForPaper(teacher, test, section, paperId, { create = true } = {}) {
  if (section !== 'B' || !paperId) {
    if (create) return currentAssessmentFor(teacher, test, section);
    return selectLatestAssessment.get(teacher.id, test.id, section) ?? null;
  }
  const open = selectSectionSittings.all(teacher.id, test.id, section).find((sitting) => {
    if (sitting.status === 'evaluated') return false;
    const ids = selectPaperIds.all(sitting.id).map((row) => row.paper_id);
    return !ids.length || (ids.length === 1 && ids[0] === paperId);
  });
  if (open || !create) return open ?? null;

  const subject = subjectName(selectPaperRow.get(paperId)?.subject) || subjectName(String(teacher.subjects ?? '').split(',')[0]);
  const info = insertAssessment.run({
    school_id: teacher.school_id,
    teacher_id: teacher.id,
    test_id: test.id,
    section,
    title: `${test.name} - ${teacher.name} - Section ${section}${subject ? ` (${subject})` : ''}`,
    subject,
  });
  return selectAssessmentById.get(info.lastInsertRowid);
}
