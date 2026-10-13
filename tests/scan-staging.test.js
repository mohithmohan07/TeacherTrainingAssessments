import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../server/zip.js';
import { inspectScanZip, stageScanZip, validateMemberName } from '../server/scan-staging.js';

const pdf = (pages, content = '') => Buffer.from(`%PDF-1.4\nfixture-pages=${pages}\n${content}\n%%EOF`);
const countPages = async (bytes) => Number(/fixture-pages=(\d+)/.exec(bytes.toString())?.[1]);

function validPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>')];
  let text = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

async function fixture(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-staging-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'scans.zip');
  await fs.writeFile(archive, buildZip(entries));
  return { root, archive, dataDir: path.join(root, 'data') };
}

function oneDeflatedZip(name, data, declaredSize = data.length) {
  const raw = buildZip([{ name, data }]);
  const compressed = deflateRawSync(data);
  const headerSize = 30 + Buffer.byteLength(name);
  const local = Buffer.from(raw.subarray(0, headerSize));
  const centralStart = headerSize + data.length;
  const central = Buffer.from(raw.subarray(centralStart, raw.length - 22));
  const end = Buffer.from(raw.subarray(raw.length - 22));
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  end.writeUInt32LE(headerSize + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

test('preview separates files, pages and identities without filesystem or database writes', async (t) => {
  const a = pdf(3, 'teacher one packet');
  const { root, archive, dataDir } = await fixture(t, [
    { name: 'RNS1 Scanned Copies/', data: Buffer.alloc(0) },
    { name: 'RNS1 Scanned Copies/a.pdf', data: a },
    { name: 'RNS1 Scanned Copies/a copy.pdf', data: a },
    { name: 'RNS1 Scanned Copies/mixed.pdf', data: pdf(5, 'two identities') },
    { name: 'notes.txt', data: Buffer.from('not extracted') },
  ]);
  const before = await fs.readdir(root);
  const manifest = await inspectScanZip(archive, { countPages, expectedTeachers: 168, dataDir });
  assert.deepEqual(await fs.readdir(root), before);
  assert.equal(manifest.status, 'preview_only');
  assert.deepEqual(manifest.counts, {
    zip_members: 5, pdf_files: 3, unique_pdf_objects: 2, duplicate_pdf_files: 1,
    pages_including_duplicate_files: 11, pages_in_unique_pdf_objects: 8,
    expected_teachers_declared: 168, verified_teacher_identities: null, imported_bulk_items: 0,
  });
  assert.equal(manifest.files[1].duplicate_of, manifest.files[0].member);
  assert.ok(manifest.files.every((file) => file.identity_status === 'unverified' && file.import_status === 'not_imported'));
  assert.deepEqual(manifest.excluded_members, [{ member: 'notes.txt', reason: 'not_a_pdf' }]);
});

test('apply preserves originals, deduplicates storage and safely retries without changing database bytes', async (t) => {
  const bytes = pdf(2, 'same original bytes');
  const { archive, dataDir } = await fixture(t, [{ name: 'a.pdf', data: bytes }, { name: 'split/copy.pdf', data: bytes }]);
  await fs.mkdir(dataDir);
  const database = Buffer.from('untouched existing database sentinel');
  await fs.writeFile(path.join(dataDir, 'app.db'), database);
  const preview = await inspectScanZip(archive, { countPages });
  const options = { dataDir, countPages, confirmSha256: preview.archive.sha256 };
  const first = await stageScanZip(archive, options);
  assert.equal(first.manifest.status, 'staged_not_imported');
  assert.equal(first.manifest.counts.imported_bulk_items, 0);
  assert.deepEqual(await fs.readdir(path.join(first.destination, 'originals')), [`${crypto.createHash('sha256').update(bytes).digest('hex')}.pdf`]);
  assert.deepEqual(await fs.readFile(path.join(first.destination, first.manifest.files[0].original_pdf)), bytes);
  const before = await fs.stat(path.join(first.destination, 'manifest.json'));
  const second = await stageScanZip(archive, options);
  assert.deepEqual(second, first);
  assert.equal((await fs.stat(path.join(second.destination, 'manifest.json'))).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'app.db')), database);
});

test('apply requires explicit destination and matching dry-run checksum before creating files', async (t) => {
  const { archive, dataDir } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }]);
  await assert.rejects(stageScanZip(archive, { countPages }), /DATA_DIR/);
  await assert.rejects(stageScanZip(archive, { countPages, dataDir }), /SHA-256/);
  await assert.rejects(stageScanZip(archive, { countPages, dataDir, confirmSha256: '0'.repeat(64) }), /differs/);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});

test('existing corrupted staged objects are never overwritten and interrupted objects resume', async (t) => {
  const { archive, dataDir } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }, { name: 'b.pdf', data: pdf(2) }]);
  const preview = await inspectScanZip(archive, { countPages });
  const options = { countPages, dataDir, confirmSha256: preview.archive.sha256 };
  const destination = path.join(dataDir, 'scan-staging', preview.archive.sha256);
  await fs.mkdir(path.join(destination, 'originals'), { recursive: true });
  const firstObject = path.join(destination, preview.files[0].original_pdf);
  await fs.writeFile(firstObject, pdf(1));
  assert.equal((await stageScanZip(archive, options)).manifest.status, 'staged_not_imported');
  await fs.writeFile(firstObject, 'corrupted');
  await assert.rejects(stageScanZip(archive, options), /failed its checksum/);
  assert.equal(await fs.readFile(firstObject, 'utf8'), 'corrupted');
});

test('insufficient disk headroom fails before destination writes', async (t) => {
  const { archive, dataDir } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }]);
  const preview = await inspectScanZip(archive, { countPages });
  await assert.rejects(stageScanZip(archive, { countPages, dataDir, confirmSha256: preview.archive.sha256, limits: { reserveBytes: Number.MAX_SAFE_INTEGER } }), /Insufficient disk space/);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});

test('unsafe members, including excluded non-PDF files, are rejected', async (t) => {
  for (const name of ['../escape.pdf', '/absolute.pdf', 'C:/windows.pdf', 'a\\b.pdf', 'a/../b.pdf', 'a//b.pdf', 'a/./b.pdf', 'a\0b.pdf', 'trailing /a.pdf']) {
    assert.throws(() => validateMemberName(name), /Unsafe/);
  }
  const { archive } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }, { name: '../escape.txt', data: Buffer.from('unsafe') }]);
  await assert.rejects(inspectScanZip(archive, { countPages }), /Unsafe/);
});

test('ambiguous member names and symlink entries are rejected', async (t) => {
  const { archive } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }, { name: 'A.pdf', data: pdf(2) }]);
  await assert.rejects(inspectScanZip(archive, { countPages }), /Duplicate or ambiguous/);
  const raw = buildZip([{ name: 'link.pdf', data: pdf(1) }]);
  const central = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  raw.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  await fs.writeFile(archive, raw);
  await assert.rejects(inspectScanZip(archive, { countPages }), /Symlinks/);
});

test('source and output symlinks are rejected without writing through them', async (t) => {
  const { root, archive, dataDir } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }]);
  const sourceLink = path.join(root, 'link.zip');
  await fs.symlink(archive, sourceLink);
  await assert.rejects(inspectScanZip(sourceLink, { countPages }), { code: 'ELOOP' });
  const preview = await inspectScanZip(archive, { countPages });
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(dataDir);
  await fs.symlink(outside, path.join(dataDir, 'scan-staging'));
  await assert.rejects(stageScanZip(archive, { countPages, dataDir, confirmSha256: preview.archive.sha256 }), /not a regular directory/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('deflated PDFs are verified, while dishonest expanded sizes and CRC corruption fail', async (t) => {
  const { archive } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }]);
  const bytes = pdf(4, 'deflated source');
  await fs.writeFile(archive, oneDeflatedZip('a.pdf', bytes));
  assert.equal((await inspectScanZip(archive, { countPages })).files[0].pages, 4);
  await fs.writeFile(archive, oneDeflatedZip('a.pdf', bytes, 1));
  await assert.rejects(inspectScanZip(archive, { countPages }), /expands beyond/);
  const corrupted = buildZip([{ name: 'a.pdf', data: bytes }]);
  corrupted[35] ^= 1;
  await fs.writeFile(archive, corrupted);
  await assert.rejects(inspectScanZip(archive, { countPages }), /checksum or size failed/);
});

test('entry, expanded-size, per-file and ratio limits apply before parsing', async (t) => {
  const { archive } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }, { name: 'b.pdf', data: pdf(1) }]);
  await assert.rejects(inspectScanZip(archive, { countPages, limits: { maxEntries: 1 } }), /entry count/);
  await assert.rejects(inspectScanZip(archive, { countPages, limits: { maxExpandedBytes: 10 } }), /expanded size/);
  await assert.rejects(inspectScanZip(archive, { countPages, limits: { maxPdfBytes: 10 } }), /per-file limit/);
  await fs.writeFile(archive, oneDeflatedZip('a.pdf', pdf(1, 'x'.repeat(10000))));
  await assert.rejects(inspectScanZip(archive, { countPages, limits: { maxCompressionRatio: 2 } }), /compression ratio/);
});

test('oversized page packets stay intact and visibly require separate handling', async (t) => {
  const { archive } = await fixture(t, [{ name: 'mixed.pdf', data: pdf(121) }]);
  const manifest = await inspectScanZip(archive, { countPages });
  assert.equal(manifest.files[0].pages, 121);
  assert.equal(manifest.files[0].bulk_upload_compatible_page_count, false);
  assert.ok(manifest.warnings.some((warning) => warning.includes('do not silently split')));
});

test('invalid PDF signatures, parser errors and source changes abort preview', async (t) => {
  const { archive } = await fixture(t, [{ name: 'a.pdf', data: Buffer.from('not a PDF') }]);
  await assert.rejects(inspectScanZip(archive, { countPages }), /signature missing/);
  await fs.writeFile(archive, buildZip([{ name: 'a.pdf', data: pdf(1) }]));
  await assert.rejects(inspectScanZip(archive, { countPages: async () => { throw new Error('Encrypted PDF'); } }), /Encrypted PDF/);
  await assert.rejects(inspectScanZip(archive, { countPages: async () => { await fs.appendFile(archive, 'changed'); return 1; } }), /changed during inspection/);
});

test('ZIP64 and encryption are rejected explicitly', async (t) => {
  const { archive } = await fixture(t, [{ name: 'a.pdf', data: pdf(1) }]);
  const raw = await fs.readFile(archive);
  const zip64 = Buffer.from(raw);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  await fs.writeFile(archive, zip64);
  await assert.rejects(inspectScanZip(archive, { countPages }), /ZIP64/);
  const central = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  raw.writeUInt16LE(0x0801, central + 8);
  await fs.writeFile(archive, raw);
  await assert.rejects(inspectScanZip(archive, { countPages }), /Encrypted/);
});

test('CRC fixture agrees with Node CRC32', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the actual CLI parses real PDF page trees, remains read-only by default and applies only explicitly', async (t) => {
  const bytes = validPdf(3);
  const { archive, dataDir } = await fixture(t, [{ name: 'actual.pdf', data: bytes }]);
  const script = fileURLToPath(new URL('../scripts/stage-scans.js', import.meta.url));
  const run = (args) => JSON.parse(execFileSync(process.execPath, [script, archive, ...args], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } }));
  const preview = run(['--expected-teachers', '168']);
  assert.equal(preview.counts.pdf_files, 1);
  assert.equal(preview.counts.pages_in_unique_pdf_objects, 3);
  assert.equal(preview.counts.verified_teacher_identities, null);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
  const staged = run(['--expected-teachers', '168', '--apply', '--confirm-sha256', preview.archive.sha256]);
  assert.equal(staged.manifest.status, 'staged_not_imported');
  assert.deepEqual(await fs.readFile(path.join(staged.destination, staged.manifest.files[0].original_pdf)), bytes);
  await assert.rejects(fs.stat(path.join(dataDir, 'app.db')), { code: 'ENOENT' });
});
