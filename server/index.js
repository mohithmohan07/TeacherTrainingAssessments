import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import db, { DATA_DIR, UPLOADS_DIR } from './db.js';
import schoolsRouter from './routes/schools.js';
import teachersRouter from './routes/teachers.js';
import assessmentsRouter from './routes/assessments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(UPLOADS_DIR, { index: false, maxAge: '1h' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/schools', schoolsRouter);
app.use('/api/teachers', teachersRouter);
app.use('/api/assessments', assessmentsRouter);

// Numbers for the dashboard.
app.get('/api/stats', (_req, res) => {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM schools)                              AS schools,
              (SELECT COUNT(*) FROM teachers)                             AS teachers,
              (SELECT COUNT(*) FROM assessments)                          AS assessments,
              (SELECT COUNT(*) FROM assessments WHERE status = 'evaluated') AS evaluated,
              (SELECT COUNT(*) FROM assessment_files)                     AS scanned_pages`
    )
    .get();

  const recent = db
    .prepare(
      `SELECT a.id, a.title, a.status, a.assessment_date, a.updated_at,
              t.name AS teacher_name, s.name AS school_name
         FROM assessments a
         JOIN teachers t ON t.id = a.teacher_id
         JOIN schools  s ON s.id = a.school_id
        ORDER BY a.updated_at DESC
        LIMIT 8`
    )
    .all();

  res.json({ counts, recent });
});

// Anything else that is not an API call is handled by the single-page app.
app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large. Scans can be up to 25 MB each, logos up to 5 MB.'
        : `Upload failed: ${error.message}`;
    return res.status(400).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: error.message || 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`\n  Teacher Training Assessments`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`  Data is stored in ${DATA_DIR}\n`);
});
