import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []);
}
for (const file of ['server', 'public/js', 'tests', 'scripts'].flatMap(walk)) {
  const check = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (check.status !== 0) process.exit(check.status ?? 1);
}
console.log('JavaScript syntax checks passed.');
