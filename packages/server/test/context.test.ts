import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ancestry, estimateTokens } from '../src/services/context.js';

test('ancestry walks from home down to the project, outermost first', () => {
  const project = join(homedir(), 'work', 'repo', 'packages', 'server');
  assert.deepEqual(ancestry(project), [
    join(homedir(), 'work'),
    join(homedir(), 'work', 'repo'),
    join(homedir(), 'work', 'repo', 'packages'),
    project,
  ]);
});

test('a project outside home has no chain to walk', () => {
  assert.deepEqual(ancestry('/opt/elsewhere'), ['/opt/elsewhere']);
});

test('token estimate is proportional and never negative', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('x'.repeat(360)), 100);
});
