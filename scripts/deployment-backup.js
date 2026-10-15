import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const MIN_RESERVE = 256n * 1024n * 1024n;
const RELEASE_INPUTS = ['package.json', 'package-lock.json', 'server', 'scripts', 'public', 'scanner-helper'];

// Hash the deployed files, not mtimes, absolute paths, or a potentially unset
// APP_REVISION. Native Fly builds therefore have the same restart protection.
export function buildFingerprint(appRoot) {
  const hash = createHash('sha256');
  function visit(relative) {
    const filename = path.join(appRoot, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      hash.update(`${relative}\0${stat.size}\0`);
      hash.update(fs.readFileSync(filename));
    } else {
      throw new Error(`Unsupported deployment fingerprint input: ${relative}`);
    }
  }
  RELEASE_INPUTS.forEach(visit);
  return hash.digest('hex');
}

function privateDirectory(dirname) {
  try { fs.mkdirSync(dirname, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dirname);
  if (!stat.isDirectory() || (stat.mode & 0o077)) {
    throw new Error(`Backup directory must be private and must not be a symlink: ${dirname}`);
  }
}

function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile()) throw new Error(`Expected a regular file, not a symlink: ${filename}`);
  return stat;
}

function syncFile(filename) {
  const fd = fs.openSync(filename, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeExclusive(filename, contents) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function checkIntegrity(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const results = db.pragma('integrity_check');
    if (results.length !== 1 || results[0].integrity_check !== 'ok') {
      // Never log potentially sensitive corrupt record/page contents.
      throw new Error('SQLite backup integrity check failed');
    }
  } finally { db.close(); }
}

function diskSpace(dirname) {
  const stat = fs.statfsSync(dirname, { bigint: true });
  return stat.bavail * stat.bsize;
}

function reserveFor(bytes) { return bytes / 10n > MIN_RESERVE ? bytes / 10n : MIN_RESERVE; }

function requireSpace(dirname, requiredBytes, availableBytes) {
  if (availableBytes(dirname) < requiredBytes) {
    throw new Error('Insufficient free space for the deployment database backup and safety reserve');
  }
}

async function readCompleted(releaseDir, fingerprint) {
  const marker = path.join(releaseDir, 'complete.json');
  try { regularFile(marker); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (manifest.format !== 1 || manifest.fingerprint !== fingerprint
      || !/^attempt-[0-9a-f-]{36}\/app\.db$/.test(manifest.file)
      || !/^[0-9a-f]{64}$/.test(manifest.sha256)
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
    throw new Error('Invalid deployment backup completion manifest');
  }
  const backupPath = path.join(releaseDir, manifest.file);
  privateDirectory(path.dirname(backupPath));
  const stat = regularFile(backupPath);
  if ((stat.mode & 0o077) || stat.size !== manifest.bytes || await fileHash(backupPath) !== manifest.sha256) {
    throw new Error('Completed deployment backup is missing, changed, or not private');
  }
  checkIntegrity(backupPath);
  return { status: 'existing', backupPath, manifest };
}

// This module deliberately never imports server/db.js: importing it mutates the
// schema. A startup failure here must leave that module unexecuted.
export async function ensureDeploymentBackup({ dataDir, fingerprint, revision = 'unknown', availableBytes = diskSpace }) {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Invalid deployment fingerprint');
  dataDir = path.resolve(dataDir);
  const sourcePath = path.join(dataDir, 'app.db');
  try { regularFile(sourcePath); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'fresh-install' }; throw error; }

  const backupsDir = path.join(dataDir, 'backups');
  const releaseDir = path.join(backupsDir, fingerprint);
  privateDirectory(backupsDir);
  privateDirectory(releaseDir);
  const completed = await readCompleted(releaseDir, fingerprint);
  if (completed) {
    requireSpace(dataDir, reserveFor(BigInt(completed.manifest.bytes)), availableBytes);
    return completed;
  }

  // A fresh private attempt on every retry preserves interrupted files. No
  // existing backup or manifest is ever overwritten or automatically deleted.
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let backupPath;
  let attemptDir;
  try {
    db.pragma('query_only = ON');
    const pageSize = BigInt(db.pragma('page_size', { simple: true }));
    const expectedBytes = pageSize * BigInt(db.pragma('page_count', { simple: true }));
    const reserve = reserveFor(expectedBytes);
    requireSpace(dataDir, expectedBytes + reserve, availableBytes);
    attemptDir = path.join(releaseDir, `attempt-${randomUUID()}`);
    fs.mkdirSync(attemptDir, { mode: 0o700 });
    backupPath = path.join(attemptDir, 'app.db');
    writeExclusive(backupPath, '');
    await db.backup(backupPath, {
      progress({ totalPages, remainingPages }) {
        const bytes = BigInt(totalPages) * pageSize;
        requireSpace(dataDir, BigInt(remainingPages) * pageSize + reserveFor(bytes), availableBytes);
        return 100;
      },
    });
  } finally { db.close(); }

  checkIntegrity(backupPath);
  syncFile(backupPath);
  const bytes = regularFile(backupPath).size;
  requireSpace(dataDir, reserveFor(BigInt(bytes)), availableBytes);
  const manifest = {
    format: 1,
    fingerprint,
    revision,
    createdAt: new Date().toISOString(),
    source: 'app.db',
    scope: 'SQLite database only; uploads and other volume files are not included',
    file: `${path.basename(attemptDir)}/app.db`,
    bytes,
    sha256: await fileHash(backupPath),
    integrity: 'ok',
  };
  const manifestPath = path.join(attemptDir, 'manifest.json');
  writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  syncFile(attemptDir);
  // A hard link publishes the fully written manifest atomically and exclusively.
  // Unlike rename(), it can never replace another process's completed marker.
  try { fs.linkSync(manifestPath, path.join(releaseDir, 'complete.json')); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const winner = await readCompleted(releaseDir, fingerprint);
    if (!winner) throw new Error('Concurrent backup completion marker disappeared');
    return winner;
  }
  syncFile(releaseDir);
  syncFile(backupsDir);
  syncFile(dataDir);
  return { status: 'created', backupPath, manifest };
}

export async function startAfterBackup({ appRoot, dataDir, revision, start, log = console.log, availableBytes }) {
  const fingerprint = buildFingerprint(appRoot);
  const backup = await ensureDeploymentBackup({ dataDir, fingerprint, revision, availableBytes });
  process.env.APP_BUILD_FINGERPRINT = fingerprint;
  log(`[database-backup] ${backup.status}${backup.backupPath ? `: ${backup.backupPath}` : ''}`);
  await start();
  return backup;
}
