// The scanner helper as a zip, so it can be downloaded from inside the app.
//
// The helper's files live in scanner-helper/ at the top of the repository.
// They are packed on request into a plain (uncompressed) zip with a single
// "Scanner helper" folder in it, and Windows line endings, because the helper
// only ever runs on Windows and its .cmd launcher needs them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './zip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HELPER_DIR = path.join(__dirname, '..', 'scanner-helper');
const FOLDER_IN_ZIP = 'Scanner helper';
const TEXT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1', '.py', '.txt', '.md', '.cs']);

function withCrlf(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
}

export function helperZip() {
  const entries = fs
    .readdirSync(HELPER_DIR, { withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .sort()
    .map((name) => {
      const data = fs.readFileSync(path.join(HELPER_DIR, name));
      const isText = TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
      return { name: `${FOLDER_IN_ZIP}/${name}`, data: isText ? withCrlf(data) : data };
    });
  return buildZip(entries);
}

export function sendHelperZip(_req, res) {
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="Scanner helper.zip"');
  res.set('Cache-Control', 'no-store');
  res.send(helperZip());
}
