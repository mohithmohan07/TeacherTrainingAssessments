// A teacher's current sitting in a test: what the board's row uploads to, and
// where pages moved to that teacher go.
import db from './db.js';

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
    subject: String(teacher.subjects ?? '').split(',')[0].trim(),
  });
  return selectAssessmentById.get(info.lastInsertRowid);
}
