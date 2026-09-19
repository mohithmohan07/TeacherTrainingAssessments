import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS schools (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    code          TEXT,
    address       TEXT,
    city          TEXT,
    state         TEXT,
    contact_name  TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    logo_path     TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    grade      TEXT,
    subjects   TEXT,
    email      TEXT,
    phone      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_teachers_school ON teachers(school_id);

  CREATE TABLE IF NOT EXISTS assessments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    teacher_id      INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    assessment_date TEXT,
    subject         TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',
    max_score       REAL,
    score           REAL,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assessments_school ON assessments(school_id);
  CREATE INDEX IF NOT EXISTS idx_assessments_teacher ON assessments(teacher_id);

  CREATE TABLE IF NOT EXISTS assessment_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('question_paper', 'response')),
    stored_name   TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT,
    size_bytes    INTEGER,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_files_assessment ON assessment_files(assessment_id, kind, position);
`);

export default db;
