// The scanner helper as a zip, so it can be downloaded from inside the app.
//
// The helper's files live in scanner-helper/ at the top of the repository.
// They are packed on request into a plain (uncompressed) zip with a single
// "Scanner helper" folder in it, and Windows line endings, because the helper
// only ever runs on Windows and its .cmd launcher needs them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HELPER_DIR = path.join(__dirname, '..', 'scanner-helper');
const FOLDER_IN_ZIP = 'Scanner helper';
const TEXT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1', '.py', '.txt', '.md', '.cs']);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function withCrlf(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
}

// entries: [{ name, data: Buffer }]. Stored, not deflated: the files are small.
export function buildZip(entries, modified = new Date()) {
  const { time, date } = dosDateTime(modified);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: MS-DOS, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    // extra length, comment length, disk number, internal and external attributes: all 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + size;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
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
