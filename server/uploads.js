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

// School logo: one image, up to 5 MB.
export const uploadLogo = multer({
  storage: diskStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: imageFilter,
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
