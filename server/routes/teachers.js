import express from 'express';
import db from '../db.js';
import { uploadWorkbook } from '../uploads.js';
import { buildTeacherTemplate, parseTeacherWorkbook } from '../excel.js';

const router = express.Router();

const selectTeacher = db.prepare('SELECT * FROM teachers WHERE id = ?');
const selectSchool = db.prepare('SELECT * FROM schools WHERE id = ?');

const insertTeacher = db.prepare(
  `INSERT INTO teachers (school_id, name, grade, subjects, email, phone)
   VALUES (@school_id, @name, @grade, @subjects, @email, @phone)`
);

function teacherFields(body) {
  return {
    name: String(body.name ?? '').trim(),
    grade: String(body.grade ?? '').trim(),
    subjects: String(body.subjects ?? '').trim(),
    email: String(body.email ?? '').trim(),
    phone: String(body.phone ?? '').trim(),
  };
}

// GET /api/teachers?school_id=1&q=asha
router.get('/', (req, res) => {
  const clauses = [];
  const params = {};

  if (req.query.school_id) {
    clauses.push('t.school_id = @school_id');
    params.school_id = Number(req.query.school_id);
  }
  if (req.query.q) {
    clauses.push('(t.name LIKE @q OR t.grade LIKE @q OR t.subjects LIKE @q)');
    params.q = `%${req.query.q}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT t.*, s.name AS school_name,
              (SELECT COUNT(*) FROM assessments a WHERE a.teacher_id = t.id) AS assessment_count
         FROM teachers t
         JOIN schools s ON s.id = t.school_id
         ${where}
         ORDER BY t.name COLLATE NOCASE`
    )
    .all(params);

  res.json(rows);
});

router.post('/', (req, res) => {
  const schoolId = Number(req.body.school_id);
  if (!selectSchool.get(schoolId)) return res.status(400).json({ error: 'Pick a school for this teacher.' });

  const fields = teacherFields(req.body);
  if (!fields.name) return res.status(400).json({ error: 'A teacher name is required.' });

  const info = insertTeacher.run({ ...fields, school_id: schoolId });
  res.status(201).json(selectTeacher.get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const teacher = selectTeacher.get(req.params.id);
  if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

  const fields = teacherFields(req.body);
  if (!fields.name) return res.status(400).json({ error: 'A teacher name is required.' });

  db.prepare(
    `UPDATE teachers
        SET name = @name, grade = @grade, subjects = @subjects, email = @email, phone = @phone,
            updated_at = datetime('now')
      WHERE id = @id`
  ).run({ ...fields, id: teacher.id });

  res.json(selectTeacher.get(teacher.id));
});

router.delete('/:id', (req, res) => {
  const teacher = selectTeacher.get(req.params.id);
  if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });
  db.prepare('DELETE FROM teachers WHERE id = ?').run(teacher.id);
  res.json({ deleted: true });
});

// Download the bulk-import template, optionally named after a school.
router.get('/template', async (req, res, next) => {
  try {
    const school = req.query.school_id ? selectSchool.get(req.query.school_id) : null;
    const buffer = await buildTeacherTemplate(school);
    const slug = school ? school.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() : 'teachers';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="teacher-import-${slug || 'teachers'}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

// Bulk import a filled-in template into one school.
router.post('/import', uploadWorkbook.single('file'), async (req, res, next) => {
  try {
    const school = selectSchool.get(Number(req.body.school_id));
    if (!school) return res.status(400).json({ error: 'Pick a school to import these teachers into.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a filled-in .xlsx file to upload.' });

    const { rows, errors } = await parseTeacherWorkbook(req.file.buffer);

    const existing = db
      .prepare('SELECT name, grade FROM teachers WHERE school_id = ?')
      .all(school.id)
      .map((t) => `${t.name.toLowerCase()}|${String(t.grade ?? '').toLowerCase()}`);
    const existingKeys = new Set(existing);

    const skipped = [...errors];
    const toInsert = [];

    for (const row of rows) {
      const key = `${row.name.toLowerCase()}|${row.grade.toLowerCase()}`;
      if (existingKeys.has(key)) {
        skipped.push({ row: null, message: `Skipped: "${row.name}" is already on this school's list.` });
        continue;
      }
      existingKeys.add(key);
      toInsert.push({ ...row, school_id: school.id });
    }

    const insertMany = db.transaction((records) => {
      for (const record of records) insertTeacher.run(record);
    });
    insertMany(toInsert);

    res.json({
      imported: toInsert.length,
      skipped: skipped.length,
      messages: skipped.map((s) => (s.row ? `Row ${s.row}: ${s.message}` : s.message)),
      teachers: db
        .prepare('SELECT * FROM teachers WHERE school_id = ? ORDER BY name COLLATE NOCASE')
        .all(school.id),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
