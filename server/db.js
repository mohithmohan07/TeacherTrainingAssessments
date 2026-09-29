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

  -- Papers written by the assessment generator. \`request\` is what was asked
  -- for and \`paper\` the questions, answers and marking points, both as JSON.
  CREATE TABLE IF NOT EXISTS generated_papers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    subject     TEXT,
    grade       TEXT,
    total_marks REAL,
    request     TEXT NOT NULL,
    paper       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A test is one round of the assessment at a school, such as a pre-training
  -- and a post-training test. Each teacher's sittings belong to one test, and
  -- a teacher can sit its sections on different dates.
  CREATE TABLE IF NOT EXISTS tests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tests_school ON tests(school_id);

  -- Reports written by OpenAI from the marks. kind 'teacher' holds both the
  -- teacher's own report and the management report on that teacher; kind
  -- 'school' is the management report on all of a school's teachers.
  -- \`basis\` fingerprints the results a report was written from, so the page
  -- can tell when newer marks have arrived since.
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL CHECK (kind IN ('teacher', 'school')),
    school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    test_id    INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'none',
    content    TEXT,
    basis      TEXT,
    error      TEXT,
    model      TEXT,
    written_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_reports_test ON reports(test_id, kind, teacher_id);
`);

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT
// EXISTS, so each one is added only when the table does not have it yet.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// The OpenAI marking of an assessment: whether it is running, what it found
// (a JSON breakdown per question), and why it failed if it did.
addColumn('assessments', 'ai_status', "TEXT NOT NULL DEFAULT 'none'");
addColumn('assessments', 'ai_result', 'TEXT');
addColumn('assessments', 'ai_error', 'TEXT');
addColumn('assessments', 'ai_model', 'TEXT');
addColumn('assessments', 'ai_evaluated_at', 'TEXT');

// Which test a sitting belongs to.
addColumn('assessments', 'test_id', 'INTEGER REFERENCES tests(id) ON DELETE CASCADE');

// Sittings from before tests existed go into a "Test 1" for their school.
db.transaction(() => {
  const schools = db.prepare('SELECT DISTINCT school_id FROM assessments WHERE test_id IS NULL').all();
  for (const { school_id: schoolId } of schools) {
    let test = db.prepare('SELECT id FROM tests WHERE school_id = ? ORDER BY id LIMIT 1').get(schoolId);
    if (!test) {
      const info = db.prepare("INSERT INTO tests (school_id, name) VALUES (?, 'Test 1')").run(schoolId);
      test = { id: info.lastInsertRowid };
    }
    db.prepare('UPDATE assessments SET test_id = ? WHERE school_id = ? AND test_id IS NULL').run(test.id, schoolId);
  }
})();

// A marking or a report that was running when the server stopped will never finish.
db.prepare(
  `UPDATE assessments SET ai_status = 'failed', ai_error = 'The server restarted while this was being marked. Press Evaluate to try again.'
    WHERE ai_status = 'running'`
).run();
db.prepare(
  `UPDATE reports SET status = 'failed', error = 'The server restarted while this report was being written. Press Build report to try again.'
    WHERE status = 'running'`
).run();

export default db;
