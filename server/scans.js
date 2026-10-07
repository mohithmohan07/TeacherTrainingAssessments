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

// Pages filed the wrong way round: the question paper becomes the response
// and the response the question paper. Each keeps its page order.
const flipKinds = db.prepare(
  `UPDATE assessment_files
      SET kind = CASE kind WHEN 'question_paper' THEN 'response' ELSE 'question_paper' END
    WHERE assessment_id = ?`
);

export function swapScanKinds(assessmentId) {
  flipKinds.run(assessmentId);
}

const selectKindPages = db.prepare(
  'SELECT id, original_name FROM assessment_files WHERE assessment_id = ? AND kind = ? ORDER BY position, id'
);

const refilePage = db.prepare(
  'UPDATE assessment_files SET assessment_id = @assessment_id, position = @position, original_name = @original_name WHERE id = @id'
);

const countPages = db.prepare('SELECT COUNT(*) AS n FROM assessment_files WHERE assessment_id = ?');

// A sitting whose pages have all gone is a draft again, not "Scans uploaded".
const backToDraft = db.prepare(
  `UPDATE assessments SET status = 'draft', updated_at = datetime('now') WHERE id = ? AND status = 'scanned'`
);

// Pages filed under the wrong teacher, moved to the right teacher's sitting
// after the pages of the same kind it already has, in their order. Scanned
// pages are named after the teacher they were scanned for, so names that
// start with the first teacher's name take the new one.
export const movePages = db.transaction((fromId, toId, kinds, { from, to }) => {
  let moved = 0;
  for (const kind of kinds) {
    let position = nextPosition.get(toId, kind).max_position;
    for (const page of selectKindPages.all(fromId, kind)) {
      position += 1;
      moved += 1;
      refilePage.run({
        id: page.id,
        assessment_id: toId,
        position,
        original_name: page.original_name.startsWith(`${from} - `) ? `${to} - ${page.original_name.slice(from.length + 3)}` : page.original_name,
      });
    }
  }
  markScanned.run(toId);
  if (!countPages.get(fromId).n) backToDraft.run(fromId);
  return moved;
});

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
