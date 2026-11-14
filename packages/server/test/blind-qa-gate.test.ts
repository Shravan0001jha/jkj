import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '@jkj/shared';
import { blindProblem } from '../src/services/github-flow.js';

/** 14 Nov: #1459 got QA approval 2 with no blind cases on record. Approval 2 now needs them, or a stated exception. */
const w = (cases?: string[]) => ({ id: 'as_x', title: 't', ...(cases ? { qaCases: { titles: cases, markdown: '', by: 'aditi', at: '2026-11-14T00:00:00Z' } } : {}) }) as unknown as WorkItem;

test('no blind cases and no exception line: refused, saying how to fix it', () => {
  assert.match(blindProblem(w(), '## Edge cases\n- PASS: x — y')!, /no blind cases on record/);
});

test('blind cases on record: allowed', () => {
  assert.equal(blindProblem(w(['a', 'b']), ''), null);
});

test('each named exception line allows it; a vague mention does not', () => {
  for (const line of ['Blind: n/a — parity port', 'Blind: n/a - test tooling', 'Exception: test-only', '- Blind: not blind, COO exception (all QAs had read the diff)']) {
    assert.equal(blindProblem(w(), `## Report\n${line}\n`), null, line);
  }
  assert.match(blindProblem(w(), 'This was a parity port of the table.')!, /no blind cases/);
});

test('the gate is ON by default in a real config; only WORKPLACE_BLIND_GATE=0 turns it off', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig(['--no-open'], {}).blindGate, true);
  assert.equal(loadConfig(['--no-open'], { WORKPLACE_BLIND_GATE: '0' }).blindGate, false);
});
