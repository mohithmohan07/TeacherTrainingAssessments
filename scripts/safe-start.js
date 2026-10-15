import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAfterBackup } from './deployment-backup.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  await startAfterBackup({
    appRoot,
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(appRoot, 'data'),
    revision: process.env.APP_REVISION || 'unknown',
    // Dynamic import is essential: static imports execute schema changes before
    // any of this entrypoint's backup checks can run.
    start: () => import('../server/index.js'),
  });
} catch (error) {
  console.error(`[database-backup] Startup stopped: ${error.message}`);
  process.exitCode = 1;
}
