import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { QA_MATRIX_DIMENSIONS, missingDimensions } from '../src/services/qa-matrix.js';
import { requireUsers } from '../src/services/qa-doc.js';

const full = QA_MATRIX_DIMENSIONS.map(d => `- ${d}: Not affected: no change to this`).join('\n');

test('every dimension answered passes', () => {
  assert.deepEqual(missingDimensions(full), []);
  requireUsers(`## Users affected\n${full}\n## Edge cases\n`);
});

test('a missing dimension is named in the refusal', () => {
  const doc = `## Users affected\n${full.split('\n').filter(l => !l.startsWith('- Account age')).join('\n')}\n## Edge cases\n`;
  assert.throws(() => requireUsers(doc), /Missing or unanswered: Account age\./);
});

test('a line with neither Affected: nor Not affected: text is refused', () => {
  for (const bad of ['- Network: fine', '- Network: Not affected:', '- Network: Affected:   ', '- Network: Affected: <rows> — case(s): <which>'.replace('<rows>', '<')]) {
    const doc = `## Users affected\n${full.replace(/- Network:.*/, bad)}\n## Edge cases\n`;
    assert.throws(() => requireUsers(doc), /Missing or unanswered: Network/, bad);
  }
});

test('template templates/qa-doc.md carries every dimension label (no drift)', () => {
  const p = join(process.env.IRIS_WORKPLACE_DIR ?? join(homedir(), 'iris-workplace'), 'templates', 'qa-doc.md');
  if (!existsSync(p)) return; // checkout without the workplace repo
  const t = readFileSync(p, 'utf8');
  for (const d of QA_MATRIX_DIMENSIONS) assert.match(t, new RegExp(`^- ${d.replace('/', '\\/')}:`, 'm'), d);
});
