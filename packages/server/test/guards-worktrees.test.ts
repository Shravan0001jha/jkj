import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { join } from 'node:path';
import type { MapEntry } from '@jkj/shared';
import { guardCommand, guardEdit, guardTool } from '../src/services/guards.js';
import { changedFiles, ensureWorktree, isMainCheckout, commitsSince } from '../src/services/worktrees.js';
import * as employees from '../src/services/employees.js';
import * as work from '../src/services/work.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

const entry = (key: string, primary: string): MapEntry => ({ kind: 'path', key, primary, contributors: [], consulted: [] });
const ctx = {
  worktree: '/Users/o/iris-work/tara/claude-dev',
  repoId: 'iris',
  charterIds: ['mobile'],
  map: [entry('iris:mobile', 'mobile'), entry('iris:services/agent-svc', 'experts'), entry('iris:services/agent-svc/phone.py', 'experts')],
  mainCheckouts: ['/Users/o/claude-dev', '/Users/o/claude-dev-mobile'],
};

test('edits stay inside the worktree and inside owned paths; scratch is free; main checkouts never', () => {
  assert.equal(guardEdit('/Users/o/iris-work/tara/claude-dev/mobile/ios/App.swift', ctx).decision, 'allow');
  assert.equal(guardEdit('mobile/ios/App.swift', ctx).decision, 'allow', 'relative to the worktree');
  assert.match(guardEdit('/Users/o/iris-work/tara/claude-dev/services/agent-svc/phone.py', ctx).reason!, /owned by experts/);
  assert.match(guardEdit('/Users/o/iris-work/tara/claude-dev/README.md', ctx).reason!, /owned by nobody/);
  assert.match(guardEdit('/Users/o/claude-dev/mobile/ios/App.swift', ctx).reason!, /main checkout/);
  assert.match(guardEdit('/Users/o/elsewhere/x', ctx).reason!, /outside your worktree/);
  assert.equal(guardEdit('/tmp/scratch.txt', ctx).decision, 'allow');
  assert.equal(guardTool('Write', { file_path: '/Users/o/claude-dev/x' }, ctx).decision, 'deny');
  assert.equal(guardTool('Read', { file_path: '/Users/o/claude-dev/x' }, ctx).decision, 'allow', 'reading is free');
});

test('commands never push, merge, rebase, release, deploy, leave the machine, or name a main checkout', () => {
  const denied = [
    'git push origin emp/tara/x', 'git merge emp/dev/other', 'git merge feat/iris-character && git push', 'git merge feat/iris-character emp/dev/other', 'git merge -s ours feat/iris-character', 'git rebase feat/mobile', 'git reset --hard HEAD~1',
    'git filter-repo --path mobile', 'git worktree add ../x', 'git checkout feat/iris-character', 'git branch -D main',
    './scripts/release-iris.sh 0.2.16', 'cd services && ../scripts/deploy-api.sh', 'ssh ec2-user@box ls', 'scp file box:/opt',
    'aws s3 cp x s3://y', 'gh pr merge 1', 'sudo rm x', 'rm -rf build', 'rm -fr build', 'xcrun devicectl device install app --device X y.app',
    'cd /Users/o/claude-dev && npm test', 'cat /Users/o/claude-dev-mobile/mobile/ios/README.md',
    'curl -X POST http://127.0.0.1:4317/api/releases/rel_1/run',
  ];
  for (const c of denied) assert.equal(guardCommand(c, ctx).decision, 'deny', c);
  const allowed = ['git status', 'git add -A && git commit -m "x"', 'git log --oneline', 'git diff', 'git checkout -b emp/tara/other', 'git merge feat/iris-character', 'git merge --no-edit feat/mobile', 'git merge --abort', 'git merge-base HEAD feat/iris-character', 'git merge --no-edit feat/iris-character 2>&1', 'cd emp && git merge --no-edit feat/iris-character 2>&1 | tail -20', 'git merge feat/iris-character -m "catch up"', 'npm test', 'cd mobile/android && ./gradlew test', 'ls -la', 'python3 -m pytest -q', 'curl -s http://127.0.0.1:4317/api/office'];
  for (const c of allowed) assert.equal(guardCommand(c, ctx).decision, 'allow', c);
});

test('host commands that drive the owner\'s real Mac are denied, unless an approved live-check window is open', () => {
  const denied = [
    'osascript -e \'tell app "Finder" to activate\'', 'afplay /System/Library/Sounds/Ping.aiff', 'say "hello"',
    'screencapture -x /tmp/shot.png', 'open -a Safari', 'open https://example.com', 'pmset -g', 'caffeinate -i -s',
    'defaults write com.apple.dock autohide -bool true', 'killall Dock', 'launchctl list', 'tccutil reset All',
    'networksetup -listallhardwareports', 'shortcuts run "Good Morning"', 'automator -i x myworkflow.workflow',
    'security find-generic-password -s x', 'open -a /Applications/Iris.app', './agent-svc --once',
    'dist-arm64/iris-agent', 'cd x && services/agent-svc/dist/agent-svc --port 9110', '.venv/bin/python app.py', 'python3 -u services/agent-svc/app.py', 'uvicorn app:app --port 9110',
  ];
  for (const c of denied) {
    const d = guardCommand(c, ctx);
    assert.equal(d.decision, 'deny', c);
    assert.match(d.reason!, /real Mac|COO/, c);
  }
  // The allowed test commands (pytest, npm test, gradlew, xcodebuild on the simulator) are unaffected.
  const stillAllowed = [
    'cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests', 'ls services/agent-svc', 'echo agent-svc', 'git diff -- services/agent-svc/app.py', 'grep -n x services/memory-svc/store.py',
    'npm test', 'npm run test:unit', 'python3 -m pytest -q', '.venv/bin/python -m pytest tests/', 'cd mobile/android && ./gradlew test',
    'xcodebuild test -scheme Iris -destination "platform=iOS Simulator,name=iPhone 15"',
  ];
  for (const c of stillAllowed) assert.equal(guardCommand(c, ctx).decision, 'allow', c);

  // An approved live-check window (an absolute ms timestamp in the future) lifts the denial; an
  // expired one (in the past, or never opened) does not.
  const open = { ...ctx, liveWindowUntil: Date.now() + 60_000 };
  assert.equal(guardCommand('osascript -e \'x\'', open).decision, 'allow');
  const expired = { ...ctx, liveWindowUntil: Date.now() - 1 };
  assert.equal(guardCommand('osascript -e \'x\'', expired).decision, 'deny');
  assert.equal(guardCommand('osascript -e \'x\'', ctx).decision, 'deny', 'no window at all: still denied');
  // The window never reopens the commands it was never meant for.
  assert.equal(guardCommand('git push origin x', open).decision, 'deny', 'a live-check window is not a push window');
});

test('the owner\'s personal folders are off limits even to read, for every tool and for Bash', () => {
  const home = os.homedir();
  const paths = [
    join(home, 'Documents', 'taxes.pdf'), join(home, 'Desktop', 'notes.txt'), join(home, 'Downloads', 'x.zip'),
    join(home, 'Pictures', 'p.png'), join(home, 'Movies', 'm.mov'), join(home, 'Music', 's.mp3'),
    join(home, 'Library', 'Mail', 'x'), join(home, 'Library', 'Messages', 'x'), join(home, 'Library', 'Calendars', 'x'),
    join(home, 'Library', 'Application Support', 'AddressBook', 'x'), join(home, 'Library', 'Containers', 'x'),
  ];
  for (const p of paths) {
    assert.equal(guardTool('Read', { file_path: p }, ctx).decision, 'deny', p);
    assert.equal(guardTool('Edit', { file_path: p }, ctx).decision, 'deny', p);
    assert.equal(guardTool('Write', { file_path: p }, ctx).decision, 'deny', p);
  }
  assert.equal(guardCommand(`cat ${join(home, 'Documents', 'taxes.pdf')}`, ctx).decision, 'deny');
  assert.equal(guardCommand('ls ~/Desktop', ctx).decision, 'deny');
  assert.equal(guardCommand('cat $HOME/Downloads/x', ctx).decision, 'deny');
  // Reading ordinary code is still free, and a live-check window never reopens these folders.
  assert.equal(guardTool('Read', { file_path: '/Users/o/claude-dev/README.md' }, ctx).decision, 'allow');
  const open = { ...ctx, liveWindowUntil: Date.now() + 60_000 };
  assert.equal(guardCommand('ls ~/Desktop', open).decision, 'deny', 'protected folders have no live-check exception');
});

function tempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  const g = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  mkdirSync(join(root, 'mobile'), { recursive: true }); mkdirSync(join(root, 'services', 'agent-svc'), { recursive: true });
  writeFileSync(join(root, 'mobile', 'a.txt'), 'a'); writeFileSync(join(root, 'services', 'agent-svc', 'phone.py'), 'p');
  mkdirSync(join(root, '.venv')); writeFileSync(join(root, '.venv', 'marker'), 'venv');
  writeFileSync(join(root, '.gitignore'), '.venv\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  g(['checkout', '-q', '-b', 'feat/mobile']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('an employee gets its own worktree from the base tip, on an emp/ branch, with the venv linked', () => {
  const repo = tempRepo();
  const workDir = mkdtempSync(join(tmpdir(), 'work-'));
  try {
    const tara = { id: 'tara', name: 'Tara', roleId: 'lead', level: 1 as const, permanent: true, charterIds: ['mobile'], unitId: 'platforms', chapterIds: [], reportsTo: null, workspace: { repo: repo.root, branch: 'feat/mobile' }, budget: { inrPerDay: 1, concurrentSessions: 1 }, state: 'idle' as const };
    const wt = ensureWorktree(workDir, tara, 'as_1');
    assert.equal(wt.path, join(workDir, 'tara', repo.root.split('/').pop()!));
    assert.equal(wt.branch, 'emp/tara/as_1');
    assert.equal(wt.created, true);
    assert.ok(existsSync(join(wt.path, 'mobile', 'a.txt')));
    assert.ok(lstatSync(join(wt.path, '.venv')).isSymbolicLink(), 'the venv is linked, not copied');
    assert.deepEqual(changedFiles(wt.path, 'feat/mobile'), []);

    // Work on the branch shows up as changed files and commits; the base is untouched.
    writeFileSync(join(wt.path, 'mobile', 'b.txt'), 'b');
    writeFileSync(join(wt.path, 'services', 'agent-svc', 'phone.py'), 'changed');
    assert.deepEqual(changedFiles(wt.path, 'feat/mobile'), ['mobile/b.txt', 'services/agent-svc/phone.py']);
    execFileSync('git', ['-C', wt.path, 'add', '-A']); execFileSync('git', ['-C', wt.path, 'commit', '-q', '-m', 'work']);
    assert.equal(commitsSince(wt.path, 'feat/mobile').length, 1);
    assert.equal(execFileSync('git', ['-C', repo.root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'the main checkout is clean');
    assert.equal(execFileSync('git', ['-C', repo.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'feat/mobile');

    // A second call for another work item switches the branch when clean; the same path is reused.
    const again = ensureWorktree(workDir, tara, 'as_2');
    assert.equal(again.path, wt.path);
    assert.equal(again.branch, 'emp/tara/as_2');
    assert.equal(again.created, false);
  } finally {
    repo.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('a session never runs in a main checkout, gets the guard hook and the forbidden commands, and report_done refuses foreign changes', async () => {
  const repo = tempRepo();
  const workDir = mkdtempSync(join(tmpdir(), 'work-'));
  const { wp, tmp } = testWorkplace({ IRIS_WORK_DIR: workDir });
  const fake = installFakeRuntime();
  try {
    // Point Tara's repo at the temp repo; the org's main checkouts include it.
    const tara = wp.org.employees.find(e => e.id === 'tara')!;
    tara.workspace = { repo: repo.root, branch: 'feat/mobile' };
    wp.org.repos.push({ id: 'iris-mobile', root: repo.root, branch: 'feat/mobile' });
    wp.org.map.push({ kind: 'path', key: 'iris-mobile:mobile', primary: 'mobile', contributors: [], consulted: [] });
    wp.org.map.push({ kind: 'path', key: 'iris-mobile:services/agent-svc', primary: 'experts', contributors: [], consulted: [] });
    // The seed's iris-mobile root entry would own everything; narrow it for this test.
    wp.org.map = wp.org.map.filter(m => m.key !== 'iris-mobile:');

    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', charterId: 'mobile' });
    const agent = employees.assign(wp, a.id);
    await new Promise(r => setTimeout(r, 5));
    const s = fake.last();
    assert.ok(!isMainCheckout(wp.org, s.options.cwd), `cwd ${s.options.cwd} is not a main checkout`);
    assert.ok(s.options.cwd.startsWith(workDir));
    assert.equal(agent.workspace, 'worktree');
    assert.ok(s.options.hooks?.PreToolUse?.[0]?.hooks.length === 1);
    assert.ok(s.options.disallowedTools!.includes('Bash(git push:*)'));
    assert.ok(s.options.systemPromptAppend!.includes('Never work in the main checkout'));
    assert.ok(s.options.systemPromptAppend!.includes('Paths your charters own'));

    // The hook denies an edit in the main checkout and outside the charter, allows an owned one.
    const hook = s.options.hooks!.PreToolUse![0]!.hooks[0]!;
    const run = (tool: string, input: Record<string, unknown>) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: s.options.cwd } as never, 't', { signal: new AbortController().signal });
    const denied = await run('Edit', { file_path: join(repo.root, 'mobile', 'a.txt') }) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput!.permissionDecisionReason, /main checkout/);
    const foreign = await run('Write', { file_path: join(s.options.cwd, 'services', 'agent-svc', 'phone.py') }) as typeof denied;
    assert.match(foreign.hookSpecificOutput!.permissionDecisionReason, /owned by experts/);
    const ok = await run('Write', { file_path: join(s.options.cwd, 'mobile', 'new.swift') }) as typeof denied;
    assert.equal(ok.hookSpecificOutput, undefined);
    const push = await run('Bash', { command: 'git push origin HEAD' }) as typeof denied;
    assert.equal(push.hookSpecificOutput?.permissionDecision, 'deny');

    // A foreign change on the branch is refused as evidence.
    writeFileSync(join(s.options.cwd, 'services', 'agent-svc', 'phone.py'), 'sneaky');
    const found = employees.foreignChanges(wp, tara, { path: s.options.cwd, branch: 'emp/tara/' + a.id, base: 'feat/mobile', repo: repo.root, created: true });
    assert.deepEqual(found, ['services/agent-svc/phone.py']);
    writeFileSync(join(s.options.cwd, 'services', 'agent-svc', 'phone.py'), 'p');
    writeFileSync(join(s.options.cwd, 'mobile', 'ok.txt'), 'fine');
    assert.deepEqual(employees.foreignChanges(wp, tara, { path: s.options.cwd, branch: '', base: 'feat/mobile', repo: repo.root, created: true }), []);
    // A contributor charter's change passes too, as the edit hook already allows it (Dev, app.py, 5 Oct).
    wp.org.map.unshift({ kind: 'path', key: 'iris-mobile:services/agent-svc/phone.py', primary: 'experts', contributors: [...tara.charterIds], consulted: [] });
    writeFileSync(join(s.options.cwd, 'services', 'agent-svc', 'phone.py'), 'contributed');
    assert.deepEqual(employees.foreignChanges(wp, tara, { path: s.options.cwd, branch: '', base: 'feat/mobile', repo: repo.root, created: true }), []);
  } finally {
    fake.restore();
    tmp.cleanup();
    repo.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('a contributor charter may edit a shared file; consulted may not; others still go through the primary', () => {
  const shared: MapEntry = { kind: 'path', key: 'iris:services/agent-svc/app.py', primary: 'experts', contributors: ['conversation', 'character'], consulted: ['memory'] };
  const base = { ...ctx, worktree: '/Users/o/iris-work/dev/claude-dev', map: [entry('iris:services/agent-svc', 'experts'), shared] };
  assert.equal(guardEdit('services/agent-svc/app.py', { ...base, charterIds: ['conversation', 'character'] }).decision, 'allow');
  assert.equal(guardEdit('services/agent-svc/app.py', { ...base, charterIds: ['memory'] }).decision, 'deny', 'consulted reviews, does not edit');
  assert.equal(guardEdit('services/agent-svc/app.py', { ...base, charterIds: ['mobile'] }).decision, 'deny');
  assert.equal(guardEdit('services/agent-svc/phone.py', { ...base, charterIds: ['conversation'] }).decision, 'deny', 'the rest of agent-svc stays experts-only');
});
