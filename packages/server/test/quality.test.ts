import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as quality from '../src/services/quality.js';

/**
 * Checkpoint 10 (docs/HLD-github-flow.md D2, D6): the quality checks the Mac runs for
 * `workplace/tests` — per-area commands from quality.yaml, a secret scan, a build-output guard and a
 * file-size limit — judged only on what the branch adds or changes.
 */

const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

function repo(): { root: string; commit(file: string, content: string | Buffer): string; rm(file: string): string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'iris-quality-'));
  git(root, ['init', '-q', '-b', 'feat/iris-character']);
  git(root, ['config', 'user.email', 't@iris.local']); git(root, ['config', 'user.name', 't']);
  const commit = (file: string, content: string | Buffer): string => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
    git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', file]);
    return git(root, ['rev-parse', 'HEAD']).trim();
  };
  const rm = (file: string): string => { git(root, ['rm', '-q', file]); git(root, ['commit', '-q', '-m', `rm ${file}`]); return git(root, ['rev-parse', 'HEAD']).trim(); };
  commit('README.md', '# base\n');
  // The trunk already tracks build output (it does, live: services/agent-svc/dist-arm64/…).
  commit('services/agent-svc/dist-arm64/old.bin', 'old\n');
  git(root, ['checkout', '-q', '-b', 'emp/kabir/as_1']);
  return { root, commit, rm, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const config = (yaml: string): quality.QualityConfig => quality.parseConfig(yaml);

test('quality.yaml: defaults when missing; areas, checks and limits when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-qcfg-'));
  try {
    const d = quality.loadConfig(dir);
    assert.ok(d.maxFileBytes > 0);
    assert.ok(d.buildOutput.some(p => p.test('services/agent-svc/dist-x/a.bin')));
    assert.equal(d.areas.length, 0);
    writeFileSync(join(dir, 'quality.yaml'), 'maxFileBytes: 10\nareas:\n  desktop:\n    paths: [desktop/]\n    checks:\n      - name: lint\n        run: node --check {files}\n        extensions: [.js]\n        timeoutSec: 30\n');
    const c = quality.loadConfig(dir);
    assert.equal(c.maxFileBytes, 10);
    assert.deepEqual(c.areas.map(a => a.id), ['desktop']);
    assert.equal(c.areas[0]!.checks[0]!.timeoutSec, 30);
    assert.throws(() => config('areas:\n  x:\n    checks:\n      - name: lint\n'), /run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the build-output guard judges only what the branch adds or changes: existing dist-* and deletions pass', () => {
  const r = repo();
  try {
    r.commit('services/agent-svc/x.py', 'x\n');
    const c = config('');
    assert.deepEqual(quality.buildOutputProblems(r.root, 'feat/iris-character', 'HEAD', c), []);
    r.rm('services/agent-svc/dist-arm64/old.bin');
    assert.deepEqual(quality.buildOutputProblems(r.root, 'feat/iris-character', 'HEAD', c), []);
    r.commit('mobile/dist-ios/app.ipa', 'ipa\n');
    const p = quality.buildOutputProblems(r.root, 'feat/iris-character', 'HEAD', c);
    assert.equal(p.length, 1);
    assert.match(p[0]!, /mobile\/dist-ios\/app\.ipa/);
  } finally { r.cleanup(); }
});

test('the file-size limit refuses a file over maxFileBytes', () => {
  const r = repo();
  try {
    r.commit('desktop/big.bin', Buffer.alloc(2048, 1));
    const p = quality.fileSizeProblems(r.root, 'feat/iris-character', 'HEAD', config('maxFileBytes: 1024\n'));
    assert.equal(p.length, 1);
    assert.match(p[0]!, /desktop\/big\.bin.*2048/);
    assert.deepEqual(quality.fileSizeProblems(r.root, 'feat/iris-character', 'HEAD', config('maxFileBytes: 4096\n')), []);
  } finally { r.cleanup(); }
});

test('the secret scan finds a planted key without echoing it, and fails closed when the scanner is missing', () => {
  const r = repo();
  try {
    const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    r.commit('services/iris-api/conf.py', `TOKEN = "${key}"\n`);
    const found = quality.secretProblems(r.root, 'feat/iris-character', 'HEAD', config(''));
    assert.equal(found.length, 1);
    assert.match(found[0]!, /services\/iris-api\/conf\.py:1/);
    assert.ok(!found[0]!.includes(key));
    const missing = quality.secretProblems(r.root, 'feat/iris-character', 'HEAD', config('secretScan:\n  command: /nonexistent/gitleaks\n'));
    assert.equal(missing.length, 1);
    assert.match(missing[0]!, /secret scan could not run/);
  } finally { r.cleanup(); }
});

test('the secret scan passes a clean branch', () => {
  const r = repo();
  try {
    r.commit('services/iris-api/conf.py', 'TOKEN = os.environ["TOKEN"]\n');
    assert.deepEqual(quality.secretProblems(r.root, 'feat/iris-character', 'HEAD', config('')), []);
  } finally { r.cleanup(); }
});

test('run: only the touched areas run, with {files} filtered by extension; a failing check fails the run', async () => {
  const r = repo();
  try {
    r.commit('desktop/a.js', 'const a = 1;\n');
    r.commit('desktop/notes.md', '# n\n');
    const yaml = [
      'areas:',
      '  desktop:',
      '    paths: [desktop/]',
      '    checks:',
      '      - name: lint',
      '        run: for f in {files}; do node --check "$f" || exit 1; done; echo "$CHANGED_FILES" > .files-seen',
      '        extensions: [.js]',
      '  iris-api:',
      '    paths: [services/iris-api/]',
      '    checks:',
      '      - name: lint',
      '        run: "false"',
    ].join('\n');
    const ok = await quality.run(r.root, 'feat/iris-character', 'HEAD', config(yaml));
    assert.equal(ok.state, 'success', ok.details);
    assert.match(ok.summary, /desktop/);
    assert.ok(!/iris-api/.test(ok.summary), 'an untouched area does not run');

    r.commit('desktop/b.js', 'const = ;\n');
    const bad = await quality.run(r.root, 'feat/iris-character', 'HEAD', config(yaml));
    assert.equal(bad.state, 'failure');
    assert.match(bad.summary, /desktop lint/);
  } finally { r.cleanup(); }
});

test('run: a dist-x file or a planted key fails the run before any command', async () => {
  const r = repo();
  try {
    r.commit('dist-x/out.js', 'x\n');
    const res = await quality.run(r.root, 'feat/iris-character', 'HEAD', config('areas:\n  all:\n    paths: [""]\n    checks:\n      - name: never\n        run: touch .ran\n'));
    assert.equal(res.state, 'failure');
    assert.match(res.summary, /build output/);
    assert.ok(!res.details?.includes('never'));
  } finally { r.cleanup(); }
});

test('run: a check over its time limit fails', async () => {
  const r = repo();
  try {
    r.commit('desktop/a.js', 'x\n');
    const res = await quality.run(r.root, 'feat/iris-character', 'HEAD', config('areas:\n  desktop:\n    paths: [desktop/]\n    checks:\n      - name: slow\n        run: sleep 5\n        timeoutSec: 1\n'));
    assert.equal(res.state, 'failure');
    assert.match(res.details ?? '', /timed out/);
  } finally { r.cleanup(); }
});

test('run: refused when the worktree is not at the head under review', async () => {
  const r = repo();
  try {
    const first = r.commit('desktop/a.js', 'x\n');
    r.commit('desktop/b.js', 'y\n');
    const res = await quality.run(r.root, 'feat/iris-character', first, config(''));
    assert.equal(res.state, 'error');
    assert.match(res.summary, /not at/);
  } finally { r.cleanup(); }
});
