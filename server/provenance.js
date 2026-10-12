// Content fingerprints deliberately read bytes, not mtimes or filenames. A scan
// replaced in place must invalidate extraction, scoring and report caches.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db, { UPLOADS_DIR } from './db.js';

export const digest = (value) => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

export function fileBasis(file) {
  let sha256;
  try { sha256 = digest(fs.readFileSync(path.join(UPLOADS_DIR, file.stored_name))); }
  catch { sha256 = 'missing'; }
  return { ...file, sha256 };
}

export function currentSourceBasis(assessmentId) {
  const sitting = db.prepare('SELECT id, teacher_id, school_id, test_id, section FROM assessments WHERE id = ?').get(assessmentId) ?? null;
  const school = sitting ? db.prepare('SELECT id, name FROM schools WHERE id = ?').get(sitting.school_id) : null;
  const teacher = sitting ? db.prepare('SELECT id, name, grade, subjects, school_id FROM teachers WHERE id = ?').get(sitting.teacher_id) : null;
  const files = db.prepare('SELECT id, kind, stored_name, original_name, mime_type, position, source_metadata FROM assessment_files WHERE assessment_id = ? ORDER BY kind, position, id').all(assessmentId).map(fileBasis);
  const papers = db.prepare('SELECT p.*, ap.position FROM assessment_papers ap JOIN papers p ON p.id = ap.paper_id WHERE ap.assessment_id = ? ORDER BY ap.position, p.id').all(assessmentId).map(fileBasis);
  return { sitting, teacher, school, files, papers };
}
