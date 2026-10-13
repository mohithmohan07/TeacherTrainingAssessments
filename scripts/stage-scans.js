#!/usr/bin/env node
import { inspectScanZip, stageScanZip } from '../server/scan-staging.js';

const usage = `Stage original scanned PDFs without changing assessments or reports.

Dry run (no files or database writes):
  node scripts/stage-scans.js scans.zip [--expected-teachers 168]

After reviewing the JSON preview, explicitly apply to DATA_DIR:
  DATA_DIR=/data node scripts/stage-scans.js scans.zip --apply --confirm-sha256 <archive-sha256> [--expected-teachers 168]

Options:
  --data-dir PATH          Explicit alternative to DATA_DIR
  --expected-teachers N    A declared expectation, never a verified identity count
  --apply                 Preserve PDFs and a manifest; does not bulk-import
  --confirm-sha256 HASH    Required with --apply; SHA from the dry run
  --help                  Show this text
`;

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage); process.exit(0); }
  const archive = args.shift();
  if (!archive || archive.startsWith('--')) throw new Error(usage);
  const options = { dataDir: process.env.DATA_DIR };
  let apply = false;
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--apply') { apply = true; continue; }
    if (!['--data-dir', '--expected-teachers', '--confirm-sha256'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--data-dir') options.dataDir = value;
    if (flag === '--confirm-sha256') options.confirmSha256 = value;
    if (flag === '--expected-teachers') {
      if (!/^\d+$/.test(value)) throw new Error('Expected teacher count must be a non-negative integer.');
      options.expectedTeachers = Number(value);
    }
  }
  if (!apply && options.confirmSha256) throw new Error('--confirm-sha256 requires --apply.');
  const result = apply ? await stageScanZip(archive, options) : await inspectScanZip(archive, options);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Scan staging stopped: ${error.message}`);
  process.exitCode = 1;
}
