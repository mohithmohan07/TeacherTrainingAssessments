import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildFingerprint, ensureDeploymentBackup, startAfterBackup } from '../scripts/deployment-backup.js';

const FINGERPRINT = 'a'.repeat(64);
const PLENTY = () => 10n ** 12n;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-deployment-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t, { wal = false } = {}) {
  const dataDir = temporary(t);
  const db = new Database(path.join(dataDir, 'app.db'));
  if (wal) {
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
  }
  db.exec('CREATE TABLE synthetic_rows (id INTEGER PRIMARY KEY, value TEXT)');
  if (wal) db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('INSERT INTO synthetic_rows (value) VALUES (?)').run('committed synthetic value');
  t.after(() => { if (db.open) db.close(); });
  return { dataDir, db };
}

function options(dataDir, extra = {}) {
  return { dataDir, fingerprint: FINGERPRINT, availableBytes: PLENTY, ...extra };
}

function countRows(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT count(*) AS count FROM synthetic_rows').get().count; }
  finally { db.close(); }
}

function appFixture(t) {
  const root = temporary(t);
  for (const dir of ['server', 'scripts', 'public', 'scanner-helper']) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, 'fixture.js'), `// ${dir}\n`);
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  return root;
}

test('online backup includes committed WAL rows, verifies integrity, and uses private files', async (t) => {
  const { dataDir, db } = fixture(t, { wal: true });
  assert.ok(fs.statSync(path.join(dataDir, 'app.db-wal')).size > 0);
  const plainCopy = path.join(dataDir, 'plain-main-file.db');
  fs.copyFileSync(path.join(dataDir, 'app.db'), plainCopy);
  assert.equal(countRows(plainCopy), 0, 'plain file copy intentionally misses committed WAL data');
  const before = db.prepare('SELECT * FROM synthetic_rows').all();
  const result = await ensureDeploymentBackup(options(dataDir));
  assert.equal(result.status, 'created');
  assert.equal(result.manifest.integrity, 'ok');
  assert.equal(countRows(result.backupPath), 1);
  assert.deepEqual(db.prepare('SELECT * FROM synthetic_rows').all(), before);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.backupPath)).mode & 0o777, 0o700);
  const marker = path.join(dataDir, 'backups', FINGERPRINT, 'complete.json');
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), result.manifest);
});

test('repeated starts reuse the original backup even after later live writes', async (t) => {
  const { dataDir, db } = fixture(t);
  const first = await ensureDeploymentBackup(options(dataDir));
  const original = fs.readFileSync(first.backupPath);
  db.exec("INSERT INTO synthetic_rows (value) VALUES ('later write')");
  const second = await ensureDeploymentBackup(options(dataDir));
  assert.equal(second.status, 'existing');
  assert.equal(second.backupPath, first.backupPath);
  assert.deepEqual(fs.readFileSync(first.backupPath), original);
  assert.equal(countRows(second.backupPath), 1);
  assert.equal(fs.readdirSync(path.join(dataDir, 'backups', FINGERPRINT)).filter((name) => name.startsWith('attempt-')).length, 1);
});

test('a new build gets a new backup and preserves previous backups', async (t) => {
  const { dataDir, db } = fixture(t);
  const first = await ensureDeploymentBackup(options(dataDir));
  const original = fs.readFileSync(first.backupPath);
  db.exec("INSERT INTO synthetic_rows (value) VALUES ('new release write')");
  const second = await ensureDeploymentBackup(options(dataDir, { fingerprint: 'b'.repeat(64) }));
  assert.equal(second.status, 'created');
  assert.notEqual(first.backupPath, second.backupPath);
  assert.equal(countRows(second.backupPath), 2);
  assert.deepEqual(fs.readFileSync(first.backupPath), original);
});

test('interrupted attempts remain untouched and retry publishes a new complete attempt', async (t) => {
  const { dataDir } = fixture(t);
  const backups = path.join(dataDir, 'backups');
  const release = path.join(backups, FINGERPRINT);
  const interrupted = path.join(release, 'attempt-00000000-0000-0000-0000-000000000000');
  for (const dirname of [backups, release, interrupted]) fs.mkdirSync(dirname, { mode: 0o700 });
  const partial = path.join(interrupted, 'app.db');
  fs.writeFileSync(partial, 'interrupted backup', { mode: 0o600 });
  const result = await ensureDeploymentBackup(options(dataDir));
  assert.equal(result.status, 'created');
  assert.equal(fs.readFileSync(partial, 'utf8'), 'interrupted backup');
  assert.notEqual(path.dirname(result.backupPath), interrupted);
});

test('concurrent attempts publish exactly one atomic completion manifest', async (t) => {
  const { dataDir } = fixture(t);
  const results = await Promise.all([ensureDeploymentBackup(options(dataDir)), ensureDeploymentBackup(options(dataDir))]);
  assert.equal(results[0].backupPath, results[1].backupPath);
  assert.deepEqual(results.map((r) => r.status).sort(), ['created', 'existing']);
  const marker = path.join(dataDir, 'backups', FINGERPRINT, 'complete.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), results[0].manifest);
});

test('missing database is a fresh install and creates no backup directories', async (t) => {
  const dataDir = path.join(temporary(t), 'not-created-yet');
  assert.deepEqual(await ensureDeploymentBackup(options(dataDir)), { status: 'fresh-install' });
  assert.equal(fs.existsSync(dataDir), false);
});

test('corrupt source fails closed without a completion marker or source changes', async (t) => {
  const dataDir = temporary(t);
  const source = path.join(dataDir, 'app.db');
  fs.writeFileSync(source, 'not a SQLite database');
  await assert.rejects(ensureDeploymentBackup(options(dataDir)), /not a database/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'not a SQLite database');
  assert.equal(fs.existsSync(path.join(dataDir, 'backups', FINGERPRINT, 'complete.json')), false);
});

test('corrupt completed backup fails instead of replacing it', async (t) => {
  const { dataDir } = fixture(t);
  const first = await ensureDeploymentBackup(options(dataDir));
  fs.writeFileSync(first.backupPath, 'corrupt backup');
  const marker = path.join(dataDir, 'backups', FINGERPRINT, 'complete.json');
  const originalMarker = fs.readFileSync(marker);
  await assert.rejects(ensureDeploymentBackup(options(dataDir)), /missing, changed, or not private/);
  assert.deepEqual(fs.readFileSync(marker), originalMarker);
  assert.equal(fs.readFileSync(first.backupPath, 'utf8'), 'corrupt backup');
});

test('insufficient space fails before copying, retaining the live database', async (t) => {
  const { dataDir, db } = fixture(t);
  await assert.rejects(ensureDeploymentBackup(options(dataDir, { availableBytes: () => 0n })), /Insufficient free space/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_rows').get().n, 1);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'backups', FINGERPRINT)), []);
});

test('space exhaustion during online copy leaves no completion marker and can retry', async (t) => {
  const { dataDir, db } = fixture(t);
  db.exec('CREATE TABLE filler (payload BLOB); INSERT INTO filler VALUES (zeroblob(2097152))');
  let checks = 0;
  await assert.rejects(ensureDeploymentBackup(options(dataDir, {
    availableBytes: () => ++checks === 1 ? PLENTY() : 0n,
  })), /Insufficient free space/);
  assert.ok(checks >= 2);
  assert.equal(fs.existsSync(path.join(dataDir, 'backups', FINGERPRINT, 'complete.json')), false);
  const attemptsBefore = fs.readdirSync(path.join(dataDir, 'backups', FINGERPRINT));
  assert.equal(attemptsBefore.length, 1);
  const retry = await ensureDeploymentBackup(options(dataDir));
  assert.equal(retry.status, 'created');
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', FINGERPRINT, attemptsBefore[0])));
});

test('fingerprint is deterministic across roots and responds to deployed code changes', (t) => {
  const first = appFixture(t);
  const second = appFixture(t);
  assert.equal(buildFingerprint(first), buildFingerprint(second));
  const fingerprint = buildFingerprint(first);
  fs.utimesSync(path.join(first, 'server', 'fixture.js'), new Date(0), new Date(0));
  assert.equal(buildFingerprint(first), fingerprint);
  fs.appendFileSync(path.join(first, 'server', 'fixture.js'), '// changed code');
  assert.notEqual(buildFingerprint(first), fingerprint);
});

test('startup waits for verified backup before importing schema changes and exposes the fingerprint', async (t) => {
  const { dataDir } = fixture(t);
  const appRoot = appFixture(t);
  const previousFingerprint = process.env.APP_BUILD_FINGERPRINT;
  t.after(() => {
    if (previousFingerprint === undefined) delete process.env.APP_BUILD_FINGERPRINT;
    else process.env.APP_BUILD_FINGERPRINT = previousFingerprint;
  });
  const logs = [];
  let started = false;
  await startAfterBackup({
    appRoot, dataDir, availableBytes: PLENTY, log: (line) => logs.push(line),
    start: async () => {
      const fingerprint = buildFingerprint(appRoot);
      assert.equal(process.env.APP_BUILD_FINGERPRINT, fingerprint);
      const marker = path.join(dataDir, 'backups', fingerprint, 'complete.json');
      assert.ok(fs.existsSync(marker), 'completion is visible before server loading');
      started = true;
    },
  });
  assert.equal(started, true);
  assert.match(logs[0], /^\[database-backup\] created: /);
  assert.equal(logs[0].includes('committed synthetic value'), false);
});

test('startup callback cannot run after a failed backup', async (t) => {
  const { dataDir } = fixture(t);
  let started = false;
  await assert.rejects(startAfterBackup({
    appRoot: appFixture(t), dataDir, availableBytes: () => 0n,
    start: () => { started = true; }, log: () => {},
  }), /Insufficient free space/);
  assert.equal(started, false);
});

test('real Docker entrypoint exits nonzero without importing the mutating server on corruption', (t) => {
  const dataDir = temporary(t);
  fs.writeFileSync(path.join(dataDir, 'app.db'), 'invalid SQLite database');
  const result = spawnSync(process.execPath, ['scripts/safe-start.js'], {
    cwd: repo, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Startup stopped/);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads')), false, 'server/db.js must not run');
});
