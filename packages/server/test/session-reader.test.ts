import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { readSession, listSessionFiles, type SessionFile } from '../src/runtime/session-reader.js';
import type { ClaudeHome } from '../src/runtime/claude-home.js';

const file = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url));
const entry: SessionFile = {
  sessionId: 'fixture-session-0001', file, projectKey: '-tmp-fixture-repo',
  mtimeMs: statSync(file).mtimeMs, size: statSync(file).size,
};

test('a transcript parses into entries, metadata and usage', async () => {
  const detail = await readSession(entry);
  assert.ok(detail);
  assert.equal(detail.cwd, '/tmp/fixture-repo');
  assert.equal(detail.gitBranch, 'main');
  assert.equal(detail.title, 'Fix the greeting');
  assert.equal(detail.lastPrompt, 'here is the screenshot');
  assert.equal(detail.model, 'claude-sonnet-5');
  assert.equal(detail.startedAt, '2026-09-20T10:00:00.000Z');
  assert.equal(detail.endedAt, '2026-09-20T10:00:30.000Z');
  // Only new input is counted; cache reads are not.
  assert.equal(detail.inputTokens, 120 + 40 + 10 + 50);
  assert.equal(detail.outputTokens, 30 + 25 + 5 + 60);
});

test('user noise is cleaned: reminders stripped, commands reduced, meta dropped', async () => {
  const detail = (await readSession(entry))!;
  const kinds = detail.entries.map(e => `${e.kind}:${e.label}`);
  assert.deepEqual(kinds, [
    'user:', 'assistant:', 'read:Read', 'bash:Bash', 'task:Task',
    'error:Failed', 'image:', 'user:', 'system:Command', 'assistant:',
  ]);
  assert.equal(detail.entries[0]!.text, 'Fix the greeting in hello.py');
  assert.equal(detail.entries[8]!.text, '/clear');
  assert.ok(!detail.entries.some(e => e.text.includes('meta noise')));
});

test('tool failures keep only their first three lines', async () => {
  const detail = (await readSession(entry))!;
  const failure = detail.entries.find(e => e.kind === 'error')!;
  assert.equal(failure.text.split('\n').length, 3);
});

test('images are decoded once and served by reference', async () => {
  const detail = (await readSession(entry))!;
  const image = detail.entries.find(e => e.kind === 'image')!;
  assert.ok(image.image?.ref);
  const bytes = detail.images.get(image.image!.ref)!;
  assert.equal(bytes.mediaType, 'image/png');
  assert.equal(bytes.data.toString('base64'), 'iVBORw0KGgo=');
});

test('sidechain records become a named subagent run', async () => {
  const detail = (await readSession(entry))!;
  assert.equal(detail.hasSubagents, true);
  assert.equal(detail.subagents.length, 1);
  assert.equal(detail.subagents[0]!.name, 'Explore');
  assert.equal(detail.subagents[0]!.task, 'Find every caller of greet()');
  assert.deepEqual(detail.subagents[0]!.entries.map(e => e.kind), ['user', 'search', 'assistant']);
});

test('a truncated last line is skipped rather than failing the file', async () => {
  const detail = await readSession(entry);
  assert.ok(detail);   // the fixture ends with a half-written record
});

test('listing a missing projects directory yields nothing, not an error', () => {
  const home: ClaudeHome = {
    configDir: '/nonexistent', projectsDir: '/nonexistent/projects',
    sessionsDir: '/nonexistent/sessions', configFile: null, present: false,
  };
  assert.deepEqual(listSessionFiles(home), []);
});
