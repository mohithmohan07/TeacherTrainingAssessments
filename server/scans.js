// Storing scanned pages. Shared by the per-assessment upload and the
// per-teacher upload on the assessments board, so both behave identically.
import fs from 'node:fs';
import path from 'node:path';
import db, { UPLOADS_DIR } from './db.js';

export const SCAN_KINDS = new Set(['question_paper', 'response']);

export function removeStoredFile(storedName) {
  if (!storedName) return;
  fs.rm(path.join(UPLOADS_DIR, storedName), { force: true }, () => {});
}

// Multer has already written the files to disk by the time a request is
// rejected, so anything we refuse has to be cleaned up again.
export function discardUploads(files) {
  for (const file of files ?? []) removeStoredFile(file.filename);
}

const nextPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) AS max_position FROM assessment_files WHERE assessment_id = ? AND kind = ?'
);

const insertFile = db.prepare(
  `INSERT INTO assessment_files (assessment_id, kind, stored_name, original_name, mime_type, size_bytes, position)
   VALUES (@assessment_id, @kind, @stored_name, @original_name, @mime_type, @size_bytes, @position)`
);

// Uploading pages never evaluates anything. A draft becomes 'scanned' so the
// board shows the scans have arrived, and an assessment that has already been
// evaluated keeps the status and the score it was given.
const markScanned = db.prepare(
  `UPDATE assessments
      SET status = CASE WHEN status = 'draft' THEN 'scanned' ELSE status END,
          updated_at = datetime('now')
    WHERE id = ?`
);

export const attachScans = db.transaction((assessmentId, kind, files) => {
  const startAt = nextPosition.get(assessmentId, kind).max_position + 1;
  files.forEach((file, index) => {
    insertFile.run({
      assessment_id: assessmentId,
      kind,
      stored_name: file.filename,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size_bytes: file.size,
      position: startAt + index,
    });
  });
  markScanned.run(assessmentId);
});
