import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import db, { DATA_DIR, UPLOADS_DIR } from './db.js';
import { installAuth, authEnabled } from './auth.js';
import schoolsRouter from './routes/schools.js';
import teachersRouter from './routes/teachers.js';
import assessmentsRouter from './routes/assessments.js';
import generatorRouter from './routes/generator.js';
import testsRouter from './routes/tests.js';
import reportsRouter from './routes/reports.js';
import dashboardRouter from './routes/dashboard.js';
import papersRouter from './routes/papers.js';
import trainingRouter from './routes/training.js';
import { sendHelperZip } from './helper-download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();

// Behind Fly's proxy, so req.ip and req.secure reflect the real client.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check for the hosting platform: no session needed, no data exposed.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// When APP_PASSWORD is set, everything below this line needs a signed session.
installAuth(app);

app.use('/uploads', express.static(UPLOADS_DIR, { index: false, maxAge: '1h' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Noto fonts for every script the generator writes in, from the @fontsource packages.
app.use('/fonts', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource'), { index: false, maxAge: '30d' }));
// PDF.js, which draws the library's question papers as pages at the end of a
// teacher's reports, with the files it reads fonts and images with. Its legacy
// build runs in browsers a few years old as well as the newest.
const PDFJS_DIR = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
for (const [url, dir] of [['build', 'legacy/build'], ['cmaps', 'cmaps'], ['standard_fonts', 'standard_fonts'], ['wasm', 'wasm'], ['iccs', 'iccs']]) {
  app.use(`/vendor/pdfjs/${url}`, express.static(path.join(PDFJS_DIR, dir), { index: false, maxAge: '30d' }));
}

app.use('/api/schools', schoolsRouter);
app.use('/api/teachers', teachersRouter);
app.use('/api/assessments', assessmentsRouter);
app.use('/api/generator', generatorRouter);
app.use('/api/tests', testsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/papers', papersRouter);
app.use('/api/training', trainingRouter);

// The scanner helper, for the laptop the scanner is plugged into.
app.get('/downloads/scanner-helper.zip', sendHelperZip);

// Anything else that is not an API call is handled by the single-page app.
app.get(/^\/(?!api\/|uploads\/|healthz|login|logout).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large. Scans can be up to 25 MB each, logos up to 5 MB, question papers and training documents 30 MB, and paper packs 200 MB.'
        : `Upload failed: ${error.message}`;
    return res.status(400).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: error.message || 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`\n  Teacher Training Assessments`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`  Data is stored in ${DATA_DIR}`);
  console.log(authEnabled ? '  Password protection is on.\n' : '  Password protection is off (set APP_PASSWORD to turn it on).\n');
});
