import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectKey } from '../src/services/projects.js';

test('the project key matches the directory name Claude Code uses', () => {
  assert.equal(encodeProjectKey('/Users/me/claude-dev'), '-Users-me-claude-dev');
  assert.equal(encodeProjectKey('/Users/me/a.b:c'), '-Users-me-a-b-c');
});
