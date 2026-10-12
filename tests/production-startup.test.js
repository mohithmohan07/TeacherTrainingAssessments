import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

// Use node:http directly, so proxy settings cannot send smoke requests elsewhere.
function localRequest(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('Local startup request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

test('production server starts with isolated data, reports its revision and protects app routes', { timeout: 25000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tta-production-startup-'));
  let stop = async () => {};
  t.after(async () => {
    try { await stop(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const port = await availablePort();
  const revision = '0123456789abcdef0123456789abcdef01234567';
  const password = 'synthetic-startup-password';
  // Only OS essentials are inherited: no real model keys, passwords, sessions,
  // Fly settings, NODE_OPTIONS or NODE_PATH may reach this disposable app.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']
    .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  Object.assign(env, { NODE_ENV: 'production', DATA_DIR: dataDir, PORT: String(port), APP_PASSWORD: password,
    APP_REVISION: revision, SESSION_SECRET: 'synthetic-startup-session-secret' });
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError;
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', (error) => { spawnError = error; resolve(); }); });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  stop = async () => {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    } finally { clearTimeout(timer); }
  };

  let health;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Server exited during startup:\n${output}`);
    assert.equal(child.signalCode, null, `Server stopped during startup:\n${output}`);
    try { health = await localRequest(port, '/healthz'); if (health.status === 200) break; } catch {}
    await delay(50);
  }
  assert.equal(health?.status, 200, `Server did not become healthy:\n${output}`);
  assert.deepEqual(JSON.parse(health.text), { ok: true, revision });
  const denied = await localRequest(port, '/api/schools');
  assert.equal(denied.status, 401);
  const page = await localRequest(port, '/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  const login = await localRequest(port, '/login', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
  assert.equal(login.status, 302);
  const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  assert.ok(cookie, 'Synthetic sign-in must issue a session');
  const allowed = await localRequest(port, '/api/schools', { headers: { cookie } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.text), []);
});
