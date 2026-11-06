import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bt from '../src/services/batch-test.js';
import { testWorkplace } from './fakes/workplace.js';

/** Owner, 4 Nov: batched pre-merge testing + Vikram's fast lane (docs/HLD-batched-testing.md). */

const T0 = Date.parse('2026-11-04T06:00:00Z');
const MIN = 60_000;

const req = (itemId: string, features: string[], atMs = T0, extra: Partial<bt.BatchRequest> = {}): bt.BatchRequest =>
  ({ itemId, headSha: `h-${itemId}`, by: 'dev', features, at: new Date(atMs).toISOString(), attempt: 1, ...extra });

test('featureOf reads the feature from a suite failure line', () => {
  assert.equal(bt.featureOf('android reminder.complete.nomac FAIL: Assert that ...'), 'reminder');
  assert.equal(bt.featureOf('android phoneasks.nomac.14 FAIL: calendar.agenda'), 'phoneasks');
  assert.equal(bt.featureOf('ios setup.account_token FAIL'), 'setup');
  assert.equal(bt.featureOf('DEFERRED (2): BLOCKED by a known infra gap'), null);
  assert.equal(bt.featureOf(''), null);
});

test('verdicts: one claimant fails, others pass, shared feature is ambiguous, undeclared feature is an orphan', () => {
  const rs = [req('a', ['reminder']), req('b', ['calendar']), req('c', ['timer', 'calendar']), req('d', ['image'])];
  const v = bt.verdicts(rs, [
    'android reminder.create.nomac FAIL: x',
    'android calendar.list FAIL: y',
    'android memory.recall FAIL: z',
  ], 'failure');
  assert.deepEqual(v.fail, { a: ['android reminder.create.nomac FAIL: x'] });
  assert.deepEqual(v.ambiguous.map(x => [x.feature, x.claimants]), [['calendar', ['b', 'c']]]);
  assert.deepEqual(v.orphan, ['android memory.recall FAIL: z']);
  assert.deepEqual(v.pass, ['d'], 'only a PR with no failing or ambiguous feature passes');
  const ok = bt.verdicts(rs, [], 'success');
  assert.deepEqual(ok.pass, ['a', 'b', 'c', 'd']);
  assert.deepEqual(ok.fail, {});
});

test('due: 10 queued, or the oldest waited 60 min (240 at the cap), or a fast request', () => {
  const nine = Array.from({ length: 9 }, (_, i) => req(`s${i}`, ['reminder'], T0));
  assert.equal(bt.due(nine, T0 + 59 * MIN, false), false);
  assert.equal(bt.due([...nine, req('s9', ['x'], T0)], T0 + MIN, false), true, '10 queued');
  assert.equal(bt.due(nine, T0 + 60 * MIN, false), true, 'oldest is 60 min old');
  assert.equal(bt.due(nine, T0 + 60 * MIN, true), false, 'cap reached: waits longer');
  assert.equal(bt.due(nine, T0 + 240 * MIN, true), true);
  assert.equal(bt.due([req('f', ['reminder'], T0, { fast: true })], T0, false), true, 'fast goes at once');
  assert.equal(bt.due([], T0 + 999 * MIN, false), false);
});

test('estimateInr: Linux minutes plus model turns', () => {
  assert.equal(bt.estimateInr(0), 15);
  assert.equal(bt.estimateInr(25 * 60), 28);
});

function fakeDeps(over: Partial<bt.Deps> = {}) {
  const calls = { assembled: [] as string[][], enqueued: [] as bt.EnqueueSpec[], verdicts: [] as [string, string, string][], alerts: [] as string[], qa: [] as string[] };
  const deps: bt.Deps = {
    headOf: id => `h-${id}`,
    isCto: by => by === 'vikram',
    assemble: async rs => { calls.assembled.push(rs.map(r => r.itemId)); return { branch: 'batch/x', sha: `sha-${rs.map(r => r.itemId).join('+')}`, dropped: [] }; },
    enqueue: spec => { calls.enqueued.push(spec); return `job-${calls.enqueued.length}`; },
    verdict: async (id, state, note) => { calls.verdicts.push([id, state, note]); },
    alert: text => { calls.alerts.push(text); },
    onHold: () => false,
    qaStory: b => { calls.qa.push(b.id); return `qa-${b.id}`; },
    ...over,
  };
  return { deps, calls };
}

test('request: queues, refreshes a duplicate, and only the CTO may use the fast lane within ₹1,000 a month', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps } = fakeDeps();
    assert.equal(bt.request(wp, { itemId: 'a', by: 'dev', features: ['reminder'] }, deps, T0).ok, true);
    const again = bt.request(wp, { itemId: 'a', by: 'dev', features: ['reminder', 'calendar'] }, deps, T0 + MIN);
    assert.equal(again.ok, true);
    assert.deepEqual(bt.queue(wp).map(r => [r.itemId, r.features.join(',')]), [['a', 'reminder,calendar']], 'a duplicate refreshes, not doubles');
    const notCto = bt.request(wp, { itemId: 'b', by: 'dev', features: ['x'], fast: true }, deps, T0);
    assert.equal(notCto.ok, false);
    assert.match(notCto.message, /CTO/);
    assert.equal(bt.request(wp, { itemId: 'c', by: 'vikram', features: ['x'], fast: true }, deps, T0).ok, true);
    bt.addSpend(wp, 'fast', 990, T0);
    const over = bt.request(wp, { itemId: 'd', by: 'vikram', features: ['x'], fast: true }, deps, T0);
    assert.equal(over.ok, false);
    assert.match(over.message, /1,000/);
    assert.equal(bt.request(wp, { itemId: 'e', by: 'dev', features: [] }, deps, T0).ok, false, 'features are required');
    assert.equal(bt.request(wp, { itemId: 'z', by: 'dev', features: ['x'] }, { ...deps, headOf: () => null }, T0).ok, false, 'no PR head, nothing to batch');
  } finally { tmp.cleanup(); }
});

test('tick: starts one batch when due (fast first), drops a conflicting PR, and waits while one runs or on hold', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps, calls } = fakeDeps({
      assemble: async rs => { calls.assembled.push(rs.map(r => r.itemId)); return { branch: 'batch/1', sha: 'combo', dropped: [{ itemId: 'b', why: 'merge conflict in agent.py' }] }; },
    });
    for (const id of ['a', 'b', 'c']) bt.request(wp, { itemId: id, by: 'dev', features: ['reminder'] }, deps, T0);
    assert.equal(await bt.tick(wp, T0 + 10 * MIN, deps), null, 'not due yet');
    assert.equal(await bt.tick(wp, T0 + 10 * MIN, { ...deps, onHold: () => true }), null);
    const b = await bt.tick(wp, T0 + 61 * MIN, deps);
    assert.ok(b);
    assert.deepEqual(calls.assembled, [['a', 'b', 'c']]);
    assert.deepEqual(b!.requests.map(r => r.itemId), ['a', 'c'], 'the conflicting PR is dropped');
    assert.equal(calls.enqueued[0]!.sha, 'combo');
    assert.deepEqual(calls.enqueued[0]!.features, ['reminder']);
    assert.match(calls.alerts.join('|') + JSON.stringify(bt.state(wp)), /agent\.py/);
    assert.equal(bt.queue(wp).length, 0);
    assert.equal(await bt.tick(wp, T0 + 200 * MIN, deps), null, 'one batch at a time');
  } finally { tmp.cleanup(); }
});

test('onResult: pass gives a verdict per PR and records spend; one claimant fails; a moved head re-queues', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const heads: Record<string, string> = { a: 'h-a', b: 'h-b', c: 'h-c' };
    const { deps, calls } = fakeDeps({ headOf: id => heads[id] ?? null });
    for (const [id, f] of [['a', 'reminder'], ['b', 'calendar'], ['c', 'timer']] as const) bt.request(wp, { itemId: id, by: 'dev', features: [f] }, deps, T0);
    const b = (await bt.tick(wp, T0 + 61 * MIN, deps))!;
    heads['c'] = 'h-c2';   // c pushed during the batch
    await bt.onResult(wp, b.id, { state: 'failure', failures: ['android calendar.list FAIL: y'], durationS: 1500, report: 'r' }, deps, T0 + 90 * MIN);
    assert.deepEqual(calls.verdicts.map(v => [v[0], v[1]]), [['a', 'success'], ['b', 'failure']]);
    assert.deepEqual(bt.queue(wp).map(r => r.itemId), ['c'], 'the moved PR goes back to the queue');
    assert.equal(bt.state(wp).current, null);
    assert.equal(bt.spend(wp, T0).batchInr, 28);
  } finally { tmp.cleanup(); }
});

test('onResult: an ambiguous failure splits once; the split result places the blame', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps, calls } = fakeDeps();
    for (const id of ['a', 'b', 'c']) bt.request(wp, { itemId: id, by: 'dev', features: id === 'c' ? ['timer'] : ['calendar'] }, deps, T0);
    const b = (await bt.tick(wp, T0 + 61 * MIN, deps))!;
    await bt.onResult(wp, b.id, { state: 'failure', failures: ['android calendar.list FAIL: y'], durationS: 600, report: 'r' }, deps, T0 + 80 * MIN);
    assert.deepEqual(calls.verdicts.map(v => [v[0], v[1]]), [['c', 'success']], 'only the clear PR gets a verdict now');
    const split = bt.state(wp).current!;
    assert.ok(split.split);
    assert.equal(split.split!.suspect, 'b', 'the most recently queued claimant is left out');
    assert.deepEqual(split.requests.map(r => r.itemId), ['a']);
    // the split run passes without b: b is to blame, a passes
    await bt.onResult(wp, split.id, { state: 'success', failures: [], durationS: 600, report: 'r2' }, deps, T0 + 100 * MIN);
    assert.deepEqual(calls.verdicts.slice(1).map(v => [v[0], v[1]]), [['a', 'success'], ['b', 'failure']]);
    assert.equal(bt.state(wp).current, null);
  } finally { tmp.cleanup(); }
});

test('onResult: a repeat failure in the split fails every remaining claimant; no third run', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps, calls } = fakeDeps();
    for (const id of ['a', 'b']) bt.request(wp, { itemId: id, by: 'dev', features: ['calendar'] }, deps, T0);
    const b = (await bt.tick(wp, T0 + 61 * MIN, deps))!;
    await bt.onResult(wp, b.id, { state: 'failure', failures: ['android calendar.list FAIL: y'], durationS: 60, report: 'r' }, deps, T0 + 70 * MIN);
    const split = bt.state(wp).current!;
    await bt.onResult(wp, split.id, { state: 'failure', failures: ['android calendar.list FAIL: y'], durationS: 60, report: 'r2' }, deps, T0 + 80 * MIN);
    assert.deepEqual(calls.verdicts.map(v => [v[0], v[1]]).sort(), [['a', 'failure'], ['b', 'failure']]);
    assert.equal(bt.state(wp).current, null);
  } finally { tmp.cleanup(); }
});

test('onResult: a run error re-queues everyone once at the front, then alerts the COO', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps, calls } = fakeDeps();
    bt.request(wp, { itemId: 'a', by: 'dev', features: ['reminder'] }, deps, T0);
    const b = (await bt.tick(wp, T0 + 61 * MIN, deps))!;
    bt.request(wp, { itemId: 'n', by: 'dev', features: ['x'] }, deps, T0 + 62 * MIN);
    await bt.onResult(wp, b.id, { state: 'error', failures: [], durationS: 30, report: 'r', note: 'no staging' }, deps, T0 + 63 * MIN);
    assert.deepEqual(bt.queue(wp).map(r => [r.itemId, r.attempt]), [['a', 2], ['n', 1]]);
    assert.equal(calls.verdicts.length, 0);
    const b2 = (await bt.tick(wp, T0 + 200 * MIN, deps))!;
    await bt.onResult(wp, b2.id, { state: 'error', failures: [], durationS: 30, report: 'r', note: 'no staging' }, deps, T0 + 201 * MIN);
    assert.ok(calls.alerts.some(a => /could not run twice/.test(a)));
    assert.deepEqual(bt.queue(wp).map(r => r.itemId), ['n'], 'the twice-errored request is dropped, not looped');
  } finally { tmp.cleanup(); }
});

test('routes: android-only, mode on, not a release gate', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(bt.routes(wp, { platforms: 'android', releaseGate: false, fast: false }), true);
    assert.equal(bt.routes(wp, { platforms: 'android,ios', releaseGate: true, fast: false }), false);
    assert.equal(bt.routes(wp, { platforms: 'android', releaseGate: true, fast: false }), false);
    bt.setMode(wp, 'off');
    assert.equal(bt.routes(wp, { platforms: 'android', releaseGate: false, fast: false }), false);
  } finally { tmp.cleanup(); }
});

test('gitAssemble: trunk + PR heads merged in order; a conflicting PR is dropped with its files, the rest kept', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'bt-git-'));
  const repo = join(root, 'iris');
  const g = (...a: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '-q', '-b', 'trunk', repo]);
    writeFileSync(join(repo, 'agent.py'), 'a = 1\n'); g('add', '.'); g('commit', '-qm', 'base');
    const branch = (name: string, file: string, body: string): string => { g('checkout', '-qb', name, 'trunk'); writeFileSync(join(repo, file), body); g('add', '.'); g('commit', '-qm', name); const sha = g('rev-parse', 'HEAD'); g('checkout', '-q', 'trunk'); return sha; };
    const a = branch('a', 'one.py', 'x\n');
    const b = branch('b', 'agent.py', 'a = 2\n');
    const c = branch('c', 'agent.py', 'a = 3\n');   // conflicts with b once b is in
    const out = bt.gitAssemble(repo, 'trunk', [
      { itemId: 'A', headSha: a, by: 'd', features: ['x'], at: '', attempt: 1 },
      { itemId: 'B', headSha: b, by: 'd', features: ['x'], at: '', attempt: 1 },
      { itemId: 'C', headSha: c, by: 'd', features: ['x'], at: '', attempt: 1 },
    ], 'test1');
    assert.equal(out.branch, 'batch/test1');
    assert.deepEqual(out.dropped.map(d => d.itemId), ['C']);
    assert.match(out.dropped[0]!.why, /agent\.py/);
    for (const sha of [a, b]) execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, out.sha]);
    assert.throws(() => execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', c, out.sha], { stdio: 'ignore' }));
    assert.equal(g('worktree', 'list').split('\n').length, 1, 'the scratch worktree is removed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("modelFor: robot runs use the cheaper model unless a request tests the model's own choices", () => {
  assert.equal(bt.modelFor([req('a', ['reminder']), req('b', ['calendar'])]), 'cheap');
  assert.equal(bt.modelFor([req('a', ['reminder']), req('b', ['phoneasks'])]), 'default', 'phoneasks checks what the model decides');
  assert.equal(bt.modelFor([req('a', ['reminder'], T0, { modelChoice: true })]), 'default', 'a request can say it tests model choice');
  assert.deepEqual([...bt.MODEL_CHOICE_FEATURES].sort(), ['phoneasks']);
});

test('tick: every batch staging deploy files one QA story and passes the robot model; a split files its own', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps, calls } = fakeDeps();
    bt.request(wp, { itemId: 'a', by: 'dev', features: ['calendar'] }, deps, T0);
    bt.request(wp, { itemId: 'b', by: 'dev', features: ['calendar'] }, deps, T0 + 1);
    const b = (await bt.tick(wp, T0 + 61 * MIN, deps))!;
    assert.deepEqual(calls.qa, [b.id], 'one QA story for the batch');
    assert.equal(bt.state(wp).current!.qaStoryId, `qa-${b.id}`);
    assert.equal(calls.enqueued[0]!.robotModel, 'cheap');
    await bt.onResult(wp, b.id, { state: 'failure', failures: ['android calendar.list FAIL: y'], durationS: 60, report: 'r' }, deps, T0 + 70 * MIN);
    assert.equal(calls.qa.length, 2, 'the split rerun is a new deploy: its own QA story');
    bt.request(wp, { itemId: 'p', by: 'dev', features: ['phoneasks'] }, deps, T0);
  } finally { tmp.cleanup(); }
});

test('request: modelChoice is kept on the request', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { deps } = fakeDeps();
    bt.request(wp, { itemId: 'a', by: 'dev', features: ['reminder'], modelChoice: true }, deps, T0);
    assert.equal(bt.queue(wp)[0]!.modelChoice, true);
  } finally { tmp.cleanup(); }
});
