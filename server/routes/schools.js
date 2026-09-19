import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import db, { UPLOADS_DIR } from '../db.js';
import { uploadLogo } from '../uploads.js';

const router = express.Router();

const selectSchools = db.prepare(`
  SELECT s.*,
         (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id)    AS teacher_count,
         (SELECT COUNT(*) FROM assessments a WHERE a.school_id = s.id) AS assessment_count
  FROM schools s
  ORDER BY s.name COLLATE NOCASE
`);

const selectSchool = db.prepare(`
  SELECT s.*,
         (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id)    AS teacher_count,
         (SELECT COUNT(*) FROM assessments a WHERE a.school_id = s.id) AS assessment_count
  FROM schools s
  WHERE s.id = ?
`);

const FIELDS = ['name', 'code', 'address', 'city', 'state', 'contact_name', 'contact_email', 'contact_phone', 'notes'];

function readFields(body) {
  const values = {};
  for (const field of FIELDS) values[field] = String(body[field] ?? '').trim();
  return values;
}

function removeLogoFile(storedName) {
  if (!storedName) return;
  fs.rm(path.join(UPLOADS_DIR, storedName), { force: true }, () => {});
}

router.get('/', (_req, res) => {
  res.json(selectSchools.all());
});

router.get('/:id', (req, res) => {
  const school = selectSchool.get(req.params.id);
  if (!school) return res.status(404).json({ error: 'School not found.' });
  res.json(school);
});

router.post('/', uploadLogo.single('logo'), (req, res) => {
  const values = readFields(req.body);
  if (!values.name) {
    if (req.file) removeLogoFile(req.file.filename);
    return res.status(400).json({ error: 'A school name is required.' });
  }

  const info = db
    .prepare(
      `INSERT INTO schools (name, code, address, city, state, contact_name, contact_email, contact_phone, notes, logo_path)
       VALUES (@name, @code, @address, @city, @state, @contact_name, @contact_email, @contact_phone, @notes, @logo_path)`
    )
    .run({ ...values, logo_path: req.file ? req.file.filename : null });

  res.status(201).json(selectSchool.get(info.lastInsertRowid));
});

router.put('/:id', uploadLogo.single('logo'), (req, res) => {
  const existing = selectSchool.get(req.params.id);
  if (!existing) {
    if (req.file) removeLogoFile(req.file.filename);
    return res.status(404).json({ error: 'School not found.' });
  }

  const values = readFields(req.body);
  if (!values.name) {
    if (req.file) removeLogoFile(req.file.filename);
    return res.status(400).json({ error: 'A school name is required.' });
  }

  const removeLogo = String(req.body.remove_logo ?? '') === 'true';
  let logoPath = existing.logo_path;
  if (req.file) logoPath = req.file.filename;
  else if (removeLogo) logoPath = null;

  db.prepare(
    `UPDATE schools
        SET name = @name, code = @code, address = @address, city = @city, state = @state,
            contact_name = @contact_name, contact_email = @contact_email, contact_phone = @contact_phone,
            notes = @notes, logo_path = @logo_path, updated_at = datetime('now')
      WHERE id = @id`
  ).run({ ...values, logo_path: logoPath, id: existing.id });

  if (logoPath !== existing.logo_path) removeLogoFile(existing.logo_path);

  res.json(selectSchool.get(existing.id));
});

router.delete('/:id', (req, res) => {
  const school = selectSchool.get(req.params.id);
  if (!school) return res.status(404).json({ error: 'School not found.' });

  const scans = db
    .prepare(
      `SELECT f.stored_name FROM assessment_files f
       JOIN assessments a ON a.id = f.assessment_id
       WHERE a.school_id = ?`
    )
    .all(school.id);

  db.prepare('DELETE FROM schools WHERE id = ?').run(school.id);

  removeLogoFile(school.logo_path);
  for (const scan of scans) removeLogoFile(scan.stored_name);

  res.json({ deleted: true });
});

export default router;
