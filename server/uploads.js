import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { UPLOADS_DIR } from './db.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp']);
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm']);

function randomName(originalName) {
  const ext = path.extname(originalName).toLowerCase().slice(0, 10);
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => cb(null, randomName(file.originalname)),
});

function imageFilter(_req, file, cb) {
  if (IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new Error(`"${file.originalname}" is not an image file. Please upload JPG, PNG, WEBP or TIFF scans.`));
}

// Scans: several images at a time, up to 25 MB each.
export const uploadScans = multer({
  storage: diskStorage,
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
  fileFilter: imageFilter,
});

// The pages of one answer-paper PDF, made into pictures by the browser before
// upload (bulk.js): up to 120 pages, 25 MB each.
export const uploadPdfPages = multer({
  storage: diskStorage,
  limits: { fileSize: 25 * 1024 * 1024, files: 120 },
  fileFilter: imageFilter,
});

// School logo: one image, up to 5 MB.
export const uploadLogo = multer({
  storage: diskStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: imageFilter,
});

// A question paper for the library: one PDF, up to 30 MB, checked and
// written to disk by papers.js.
export const uploadPaper = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf' || file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Please upload the question paper as a PDF. In Word, use File → Save As → PDF first.'));
  },
});

// A document to read the training paths from, such as a proposal: one PDF,
// up to 30 MB, held in memory, read by OpenAI and discarded.
export const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf' || file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Please choose a PDF. From Word or Google Docs, save or download the document as a PDF first.'));
  },
});

// A paper pack: one zip of PDFs and their labels, up to 200 MB.
export const uploadPack = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.zip') return cb(null, true);
    cb(new Error('Please choose the paper pack .zip file.'));
  },
});

// Excel import: held in memory, parsed and discarded.
export const uploadWorkbook = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (SPREADSHEET_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(new Error('Please upload an .xlsx file saved from the template.'));
  },
});
