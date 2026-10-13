// Preserve original scanned PDFs for a separately authorized bulk import.
// This module deliberately never opens app.db or invokes bulk.addItem.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInflateRaw, crc32 } from 'node:zlib';
import { Readable } from 'node:stream';

export const STAGING_LIMITS = Object.freeze({
  maxArchiveBytes: 4 * 1024 ** 3 - 1,
  maxEntries: 5000,
  maxDirectoryBytes: 16 * 1024 ** 2,
  maxPdfBytes: 256 * 1024 ** 2,
  maxExpandedBytes: 8 * 1024 ** 3,
  maxCompressionRatio: 200,
  maxPagesPerPdf: 120, // The existing bulk upload's page limit.
  reserveBytes: 256 * 1024 ** 2,
});

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fail = (message) => { throw new Error(message); };
const decoder = new TextDecoder('utf-8', { fatal: true });

async function readAt(handle, length, position) {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(data, offset, length - offset, position + offset);
    if (!bytesRead) fail('Truncated ZIP.');
    offset += bytesRead;
  }
  return data;
}

export function validateMemberName(name) {
  if (!name || name.length > 4096 || /[\\\x00-\x1f\x7f:]/u.test(name) || name.startsWith('/')) {
    fail(`Unsafe ZIP member name: ${JSON.stringify(name)}.`);
  }
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    fail(`Unsafe ZIP member name: ${JSON.stringify(name)}.`);
  }
  return name;
}

// Inspect the central directory before inflating anything. A deliberately
// limited reader: ordinary single-disk stored/deflated ZIPs only. Rejecting
// ZIP64/encryption is safer than partly interpreting them.
async function zipEntries(handle, size, limits) {
  if (size < 22 || size > limits.maxArchiveBytes) fail('ZIP size is outside the configured archive limit.');
  const tailStart = Math.max(0, size - 65557);
  const tail = await readAt(handle, size - tailStart, tailStart);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) fail('A complete ZIP end record was not found.');
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('ZIP64 is not supported; use an ordinary ZIP smaller than 4 GiB.');
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count) fail('Multi-disk ZIPs are not supported.');
  if (!count || count > limits.maxEntries || directorySize > limits.maxDirectoryBytes) fail('ZIP entry count or directory size exceeds the configured limit.');
  if (directoryOffset + directorySize !== tailStart + end) fail('ZIP directory bounds are inconsistent.');
  const directory = await readAt(handle, directorySize, directoryOffset);
  const entries = [];
  const names = new Set();
  let offset = 0;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) fail('Invalid ZIP directory entry.');
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const sizeBytes = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localOffset = directory.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) fail('Truncated ZIP directory entry.');
    if ([compressedSize, sizeBytes, localOffset].includes(0xffffffff)) fail('ZIP64 entries are not supported.');
    if (directory.readUInt16LE(offset + 34)) fail('Multi-disk ZIP entries are not supported.');
    if ((flags & ~0x080e) || ![0, 8].includes(method)) fail('Encrypted or unsupported ZIP members are not allowed.');
    const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x0800) && nameBytes.some((byte) => byte > 127)) fail('Non-ASCII ZIP names must use UTF-8 encoding.');
    const name = validateMemberName(decoder.decode(nameBytes));
    const key = name.normalize('NFC').toLowerCase();
    if (names.has(key)) fail(`Duplicate or ambiguous ZIP member name: ${name}.`);
    names.add(key);
    const attributes = directory.readUInt32LE(offset + 38);
    const unixType = (attributes >>> 16) & 0xf000;
    const isDirectory = name.endsWith('/');
    if (unixType && unixType !== (isDirectory ? 0x4000 : 0x8000)) fail(`Symlinks and special ZIP members are not allowed: ${name}.`);
    if ((attributes & 0x10) && !isDirectory) fail(`Inconsistent ZIP directory member: ${name}.`);
    if (isDirectory && sizeBytes) fail(`ZIP directory contains data: ${name}.`);
    if (sizeBytes > limits.maxPdfBytes) fail(`ZIP member exceeds the per-file limit: ${name}.`);
    expanded += sizeBytes;
    if (expanded > limits.maxExpandedBytes) fail('ZIP expanded size exceeds the configured limit.');
    if (sizeBytes / Math.max(1, compressedSize) > limits.maxCompressionRatio) fail(`Suspicious ZIP compression ratio: ${name}.`);
    if (method === 0 && compressedSize !== sizeBytes) fail(`Stored ZIP member has inconsistent sizes: ${name}.`);
    const local = await readAt(handle, 30, localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) fail(`Inconsistent ZIP local header: ${name}.`);
    const localNameLength = local.readUInt16LE(26);
    const localName = await readAt(handle, localNameLength, localOffset + 30);
    if (!localName.equals(nameBytes)) fail(`ZIP local and directory names differ: ${name}.`);
    const dataOffset = localOffset + 30 + localNameLength + local.readUInt16LE(28);
    if (dataOffset + compressedSize > directoryOffset) fail(`ZIP member extends into the directory: ${name}.`);
    const crc = directory.readUInt32LE(offset + 16);
    if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressedSize || local.readUInt32LE(22) !== sizeBytes)) fail(`ZIP local and directory sizes/checksums differ: ${name}.`);
    entries.push({ name, method, compressedSize, sizeBytes, crc, localOffset, dataOffset, isDirectory });
    offset = next;
  }
  if (offset !== directory.length) fail('Unexpected trailing ZIP directory data.');
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < byOffset.length; i += 1) {
    if (byOffset[i].localOffset < byOffset[i - 1].dataOffset + byOffset[i - 1].compressedSize) fail('Overlapping ZIP members are not allowed.');
  }
  return entries;
}

async function* readChunks(handle, start, length) {
  let position = start;
  const end = start + length;
  while (position < end) {
    const chunk = await readAt(handle, Math.min(64 * 1024, end - position), position);
    position += chunk.length;
    yield chunk;
  }
}

async function memberBytes(handle, entry) {
  const input = Readable.from(readChunks(handle, entry.dataOffset, entry.compressedSize));
  const output = entry.method === 8 ? input.pipe(createInflateRaw()) : input;
  if (output !== input) input.on('error', (error) => output.destroy(error));
  const chunks = [];
  let length = 0;
  let crc = 0;
  try {
    for await (const chunk of output) {
      length += chunk.length;
      if (length > entry.sizeBytes) fail(`ZIP member expands beyond its declared size: ${entry.name}.`);
      crc = crc32(chunk, crc);
      chunks.push(chunk);
    }
  } finally {
    output.destroy();
    input.destroy();
  }
  if (length !== entry.sizeBytes || crc !== entry.crc) fail(`ZIP member checksum or size failed: ${entry.name}.`);
  return Buffer.concat(chunks, length);
}

async function hashHandle(handle) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of readChunks(handle, 0, (await handle.stat()).size)) hash.update(chunk);
  return hash.digest('hex');
}

async function pdfPageCount(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  try { return (await loading.promise).numPages; }
  finally { await loading.destroy(); }
}

function checkLimits(limits) {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === 'reserveBytes' ? 0 : 1)) fail(`Invalid limit: ${name}.`);
  }
}

// Page counts are parsed from each unique PDF. A PDF is not a teacher, and
// parsing its page tree does not verify identities or render its pages.
export async function inspectScanZip(archivePath, options = {}) {
  const limits = { ...STAGING_LIMITS, ...options.limits };
  checkLimits(limits);
  const expectedTeachers = options.expectedTeachers ?? null;
  if (expectedTeachers !== null && (!Number.isSafeInteger(expectedTeachers) || expectedTeachers < 0)) fail('Expected teacher count must be a non-negative integer.');
  const handle = await fsp.open(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('The ZIP source must be a regular file.');
    const entries = await zipEntries(handle, stat.size, limits);
    const archiveSha = await hashHandle(handle);
    const pdfs = [];
    const unique = new Map();
    for (const entry of entries) {
      if (entry.isDirectory || !/\.pdf$/i.test(entry.name)) continue;
      const bytes = await memberBytes(handle, entry);
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail(`PDF signature missing: ${entry.name}.`);
      const sha256 = digest(bytes);
      let object = unique.get(sha256);
      if (!object) {
        let pages;
        try { pages = await (options.countPages ?? pdfPageCount)(bytes); }
        catch (error) { throw new Error(`Could not parse ${entry.name}: ${error.message}`, { cause: error }); }
        if (!Number.isSafeInteger(pages) || pages < 1) fail(`Cannot verify the PDF page count: ${entry.name}.`);
        object = { pages, first: entry.name, sizeBytes: bytes.length };
        unique.set(sha256, object);
      }
      pdfs.push({
        member: entry.name, sha256, size_bytes: bytes.length, pages: object.pages,
        original_pdf: `originals/${sha256}.pdf`,
        duplicate_of: object.first === entry.name ? null : object.first,
        identity_status: 'unverified', import_status: 'not_imported', bulk_item_ids: [],
        bulk_upload_compatible_page_count: object.pages <= limits.maxPagesPerPdf,
      });
    }
    if (!pdfs.length) fail('The ZIP contains no PDF members.');
    const unchanged = await handle.stat();
    if (stat.size !== unchanged.size || stat.mtimeMs !== unchanged.mtimeMs || stat.ctimeMs !== unchanged.ctimeMs) fail('The ZIP changed during inspection.');
    const manifest = {
      schema_version: 1,
      status: 'preview_only',
      archive: { name: path.basename(archivePath), sha256: archiveSha, size_bytes: stat.size },
      counts: {
        zip_members: entries.length,
        pdf_files: pdfs.length,
        unique_pdf_objects: unique.size,
        duplicate_pdf_files: pdfs.length - unique.size,
        pages_including_duplicate_files: pdfs.reduce((sum, file) => sum + file.pages, 0),
        pages_in_unique_pdf_objects: [...unique.values()].reduce((sum, file) => sum + file.pages, 0),
        expected_teachers_declared: expectedTeachers,
        verified_teacher_identities: null,
        imported_bulk_items: 0,
      },
      bytes: {
        pdf_files_expanded: pdfs.reduce((sum, file) => sum + file.size_bytes, 0),
        unique_pdf_objects: [...unique.values()].reduce((sum, file) => sum + file.sizeBytes, 0),
      },
      limits,
      files: pdfs,
      excluded_members: entries.filter((entry) => !entry.isDirectory && !/\.pdf$/i.test(entry.name)).map((entry) => ({ member: entry.name, reason: 'not_a_pdf' })),
      warnings: [
        'Staging is not bulk import: no database rows, page images, matches, assessments or reports are created.',
        'PDF files and pages are counted independently from teacher identities. Split or mixed packets are not assigned to teachers.',
        'Duplicate bytes are stored once; all original ZIP member names are retained. Review duplicates before any later import.',
        ...pdfs.filter((file) => !file.bulk_upload_compatible_page_count).map((file) => `${file.member}: exceeds the current bulk upload limit of ${limits.maxPagesPerPdf} pages; do not silently split or truncate.`),
      ],
    };
    return manifest;
  } finally { await handle.close(); }
}

async function existingAncestor(location) {
  let current = location;
  while (true) {
    try { await fsp.stat(current); return current; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) fail('No existing destination ancestor.');
    current = parent;
  }
}

async function ensureDirectory(location) {
  await fsp.mkdir(location, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(location);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Staging destination is not a regular directory: ${location}.`);
}

async function regularFileHash(file) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) fail(`Not a regular staged file: ${file}.`);
    return await hashHandle(handle);
  } finally { await handle.close(); }
}

// Publish through an exclusive hard link. This never overwrites an existing
// file; the existing bytes must match. Interrupted temporary files are safe
// to discard, and completed content-addressed originals are reusable.
async function writeOnce(file, bytes) {
  const expected = digest(bytes);
  try {
    if (await regularFileHash(file) !== expected) fail(`Existing staged file failed its checksum: ${file}.`);
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.partial`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fsp.link(temporary, file).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      if (await regularFileHash(file) !== expected) fail(`Concurrent staged file differs: ${file}.`);
    });
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}

// --apply must be bound to the SHA from an inspected preview. Every source
// is revalidated before publishing, and the complete manifest is last.
export async function stageScanZip(archivePath, options = {}) {
  if (!options.dataDir) fail('Set DATA_DIR or pass --data-dir explicitly.');
  if (!/^[a-f0-9]{64}$/.test(options.confirmSha256 ?? '')) fail('Apply requires the archive SHA-256 from the dry-run preview.');
  const manifest = await inspectScanZip(archivePath, options);
  if (manifest.archive.sha256 !== options.confirmSha256) fail('Archive SHA-256 differs from the approved dry-run preview.');
  const dataDir = path.resolve(options.dataDir);
  const available = await fsp.statfs(await existingAncestor(dataDir));
  const required = manifest.bytes.unique_pdf_objects + manifest.limits.reserveBytes + Buffer.byteLength(JSON.stringify(manifest)) + 65536;
  if (available.bavail * available.bsize < required) fail(`Insufficient disk space: need ${required} free bytes including reserve before staging.`);
  // DATA_DIR may itself be an intentional volume/symlink; everything created
  // beneath its resolved root must be real directories, never symlinks.
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const root = await fsp.realpath(dataDir);
  const stagingRoot = path.join(root, 'scan-staging');
  await ensureDirectory(stagingRoot);
  const destination = path.join(stagingRoot, manifest.archive.sha256);
  await ensureDirectory(destination);
  await ensureDirectory(path.join(destination, 'originals'));
  const handle = await fsp.open(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const entries = await zipEntries(handle, (await handle.stat()).size, manifest.limits);
    if (await hashHandle(handle) !== manifest.archive.sha256) fail('The archive changed before staging.');
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const written = new Set();
    for (const file of manifest.files) {
      if (written.has(file.sha256)) continue;
      const bytes = await memberBytes(handle, byName.get(file.member));
      if (digest(bytes) !== file.sha256) fail(`Source PDF changed before staging: ${file.member}.`);
      await writeOnce(path.join(destination, file.original_pdf), bytes);
      written.add(file.sha256);
    }
  } finally { await handle.close(); }
  manifest.status = 'staged_not_imported';
  await writeOnce(path.join(destination, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { destination, manifest };
}
