/** LLD-dashboard §1: build snapshot-v1.json from the Workplace's own records; with --upload, copy it to the dashboard's private bucket. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadRows } from './services/metrics/rows.js';
import { buildSnapshot } from './services/metrics/snapshot.js';

const wpDir = process.env['IRIS_WORKPLACE_DIR'] ?? join(homedir(), 'iris-workplace');
const opsDir = process.env['IRIS_OPS_DIR'] ?? join(homedir(), 'iris-ops');
const outDir = join(wpDir, 'metrics');
const bucket = process.env['DASH_DATA_BUCKET'];

// Product map: the owner's override in the Workplace dir, else the default shipped with the code.
const override = join(wpDir, 'products.json');
const fallback = join(dirname(fileURLToPath(import.meta.url)), 'services', 'metrics', 'products.default.json');
const cfg = JSON.parse(readFileSync(existsSync(override) ? override : existsSync(fallback) ? fallback : join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'metrics', 'products.default.json'), 'utf8'));
const snap = buildSnapshot(loadRows(join(wpDir, 'workplace.db'), join(opsDir, 'workplace', 'staging-follow-trunk.log')), cfg);
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'snapshot-v1.json');
writeFileSync(out + '.tmp', JSON.stringify(snap));
renameSync(out + '.tmp', out);
console.log(`snapshot ${snap.generatedAt}: ${snap.products.length} products, ${snap.features.length} epics, unknown ${Math.round(snap.unknownShare * 100)}%`);
if (process.argv.includes('--upload')) {
  if (!bucket) throw new Error('DASH_DATA_BUCKET is not set');
  execFileSync('aws', ['s3', 'cp', out, `s3://${bucket}/snapshot-v1.json`, '--content-type', 'application/json', '--only-show-errors'], { stdio: 'inherit' });
  console.log(`uploaded to s3://${bucket}/snapshot-v1.json`);
}
