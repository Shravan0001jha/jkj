import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrRecord, WorkItem } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import * as employees from '../src/services/employees.js';
import * as manager from '../src/services/manager.js';
import * as floor from '../src/services/floor.js';
import * as dispatch from '../src/services/dispatch.js';
import * as hygiene from '../src/services/hygiene.js';
import * as lifecycleWatch from '../src/services/lifecycle-watch.js';
import { writeGithubMode } from '../src/services/review-policy.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The Jira-style lifecycle and the hygiene monitor (docs/HLD-jira-lifecycle.md): the true status,
 * blockers that say what they wait on and where it stands, startsAfter, merge → Merged → Done, and the
 * seven hygiene rules with their Asha (10 min) and COO (60 min) reports.
 */

const MIN = 60_000;
const runtime = installFakeRuntime();
after(() => runtime.restore());

function setup() {
  const t = testWorkplace();
  mkdirSync(join(t.tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(t.tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
  const epic = items.create(t.wp, { level: 'epic', title: 'Practice' }, 'owner');
  const story = (title: string, assigneeId?: string, extra: Record<string, unknown> = {}) =>
    items.create(t.wp, { level: 'story', parentId: epic.id, title, ...(assigneeId ? { assigneeId } : {}), ...extra } as never, 'owner');
  const raw = (id: string) => rawGet(t.wp, id)!;
  const patch = (id: string, p: Partial<WorkItem>) => work.saveQuiet(t.wp, { ...raw(id), ...p });
  return { ...t, epic, story, raw, patch, done: async () => { await new Promise(r => setTimeout(r, 200)); t.tmp.cleanup(); } };
}

const pr = (extra: Partial<PrRecord> = {}): PrRecord => ({ number: 7, url: 'https://github.com/o/r/pull/7', branch: 'emp/tara/x', base: 'main', headSha: 'abc123', pushedAt: '2026-10-05T10:00:00Z', evidence: 'success', tests: { state: 'success', sha: 'abc123', at: '2026-10-05T10:00:00Z', summary: 'ok' }, ...extra });
const approval = (by: string, episode: string) => ({ by, at: '2026-10-05T10:01:00Z', sha: 'abc123', episode });
const hygieneAlerts = (wp: Parameters<typeof manager.list>[0]) => manager.list(wp).filter(a => a.key.startsWith('hygiene:'));
const cooHygiene = (wp: Parameters<typeof coo.listItems>[0]) => coo.listItems(wp).filter(i => i.kind === 'hygiene');
const rules = (r: hygiene.SweepResult) => r.violations.map(v => `${v.rule}:${v.itemId}`).sort();

/* ---------- the true status and the payload ---------- */

test('trueStatus: On hold with its reason, and the PR stages In review → QA → Approved → Merged → Done, with the PR on the item', async () => {
  const { wp, story, raw, patch, done } = setup();
  try {
    writeGithubMode(wp, 'shadow');
    const parked = story('Parked', 'tara');
    items.update(wp, parked.id, { status: 'backlog', hold: true, note: 'needs the owner at the Mac' }, 'owner');
    const p = items.require$(wp, parked.id);
    assert.equal(p.trueStatus, 'on-hold');
    assert.equal(p.holdReason, 'needs the owner at the Mac');

    const s = story('Version footer', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'dev' }, 'tara');
    patch(s.id, { pr: pr() });
    let it = items.require$(wp, s.id);
    assert.equal(it.trueStatus, 'in-review');
    assert.deepEqual({ n: it.pr?.number, url: it.pr?.url, stage: it.pr?.stage, tests: it.pr?.tests }, { n: 7, url: 'https://github.com/o/r/pull/7', stage: 'dev', tests: 'success' }, 'the PR is shown on the story');
    const ep = raw(s.id).statusSince!;
    patch(s.id, { pr: pr({ devApproval: approval('dev', ep) }) });
    assert.equal(items.require$(wp, s.id).trueStatus, 'qa');
    patch(s.id, { pr: pr({ devApproval: approval('dev', ep), qaApproval: approval('nikhil', ep) }) });
    assert.equal(items.require$(wp, s.id).trueStatus, 'approved');
    // QA's approval makes it done (the flow does this); unmerged it is still Approved, not Done.
    patch(s.id, { status: 'done', resolution: 'done' });
    assert.equal(items.require$(wp, s.id).trueStatus, 'approved');
    patch(s.id, { pr: { ...raw(s.id).pr!, merged: { at: '2026-10-05T11:00:00Z', sha: 'm1', by: 'coo' } } });
    it = items.require$(wp, s.id);
    assert.equal(it.trueStatus, 'merged');
    assert.equal(it.pr?.stage, 'merged');
  } finally { await done(); }
});

test('a bug is a story-level item of type bug; cant-reproduce is a resolution', async () => {
  const { wp, story, done } = setup();
  try {
    const b = story('Crash on launch', 'tara', { type: 'bug' });
    assert.equal(items.require$(wp, b.id).type, 'bug');
    assert.equal(items.require$(wp, b.id).level, 'story');
    items.update(wp, b.id, { status: 'done', resolution: 'cant-reproduce' }, 'owner');
    assert.equal(items.require$(wp, b.id).resolution, 'cant-reproduce');
  } finally { await done(); }
});

/* ---------- enforcement ---------- */

test('Blocked needs waitingOn and blockedReason (each refusal says the next step); On hold needs a reason', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Store listing', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    assert.throws(() => items.update(wp, s.id, { status: 'blocked', waitingOn: 'owner' }, 'tara'), /Blocked needs a reason: add blockedReason/);
    assert.throws(() => items.update(wp, s.id, { status: 'blocked', blockedReason: 'the key' }, 'tara'), /Blocked needs who it is waiting on: set waitingOn/);
    assert.throws(() => items.update(wp, s.id, { status: 'blocked', blockedReason: 'x', waitingOn: 'nobody-at-all' }, 'tara'), /not a person, an item id/);
    const it = items.update(wp, s.id, { status: 'blocked', blockedReason: 'needs the release first', waitingOn: 'release' }, 'tara');
    assert.equal(it.status, 'blocked');
    assert.deepEqual({ kind: it.blocker?.kind, status: it.blocker?.status }, { kind: 'release', status: 'no release planned' });

    const h = story('Mac-only check', 'tara');
    assert.throws(() => items.update(wp, h.id, { hold: true }, 'owner'), /On hold needs a reason/);
  } finally { await done(); }
});

test('a block stays current: waitingOn and blockedReason edit in place, its since kept; the blocker status follows the linked item', async () => {
  const { wp, story, raw, done } = setup();
  try {
    const dep = story('Server endpoint', 'kabir');
    const s = story('Client screen', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    items.update(wp, s.id, { status: 'blocked', blockedReason: 'waits on the server', waitingOn: 'coo' }, 'tara');
    const since = raw(s.id).blockedSince;
    let it = items.update(wp, s.id, { waitingOn: dep.id, blockedReason: 'needs the endpoint' }, 'tara');
    assert.equal(it.status, 'blocked');
    assert.equal(raw(s.id).blockedSince, since, 'the block keeps its since');
    assert.deepEqual({ kind: it.blocker?.kind, label: it.blocker?.label, status: it.blocker?.status, reason: it.blocker?.reason }, { kind: 'item', label: 'Server endpoint', status: 'Ready', reason: 'needs the endpoint' });
    items.update(wp, dep.id, { status: 'in-progress' }, 'kabir');
    it = items.require$(wp, s.id);
    assert.equal(it.blocker?.status, 'In progress', 'the linked item moved: the blocker status shows it');
  } finally { await done(); }
});

test('startsAfter: shown with the blocker status, never dispatched early; on its finish the dependent flips to Ready and the assignee is told', async () => {
  const { wp, story, done } = setup();
  try {
    items.setFocus(wp, [items.list(wp, { level: 'epic' })[0]!.id], 'coo');
    const a = story('Schema', 'kabir');
    const b = story('Migration', 'tara', { startsAfter: a.id });
    const c = story('Backfill', 'mira');
    items.update(wp, c.id, { status: 'in-progress' }, 'mira');
    items.update(wp, c.id, { status: 'blocked', startsAfter: a.id }, 'mira');
    let bi = items.require$(wp, b.id);
    assert.equal(bi.trueStatus, 'blocked');
    assert.deepEqual(bi.startsAfter, { id: a.id, title: 'Schema', status: 'Ready', done: false });
    assert.equal(bi.blocker?.reason, 'Starts after "Schema"');
    assert.equal(items.require$(wp, c.id).blocker?.reason, 'Starts after "Schema"', 'startsAfter is a concrete blocker');
    assert.ok(!dispatch.queue(wp, 'tara').some(w => w.id === b.id), 'not dispatched before Schema finishes');
    assert.ok(!hygiene.report(wp).violations.some(v => v.rule === 'bad-block'), 'a block with startsAfter is concrete: no violation');
    assert.throws(() => items.update(wp, a.id, { startsAfter: b.id }, 'owner'), /would make a loop/);

    items.update(wp, a.id, { status: 'in-progress' }, 'kabir');
    items.update(wp, a.id, { status: 'in-review', reviewerId: 'nikhil' }, 'kabir');
    items.update(wp, a.id, { status: 'done' }, 'nikhil');
    lifecycleWatch.onItem(wp, a.id);
    bi = items.require$(wp, b.id);
    assert.equal(bi.trueStatus, 'ready');
    assert.equal(bi.startsAfter?.done, true);
    assert.equal(items.require$(wp, c.id).status, 'ready', 'the blocked dependent flipped to Ready');
    assert.ok(trail.activityFor(wp, b.id).some(x => /"Schema" is Done.*told Tara/.test(x.text ?? '')));
    assert.ok(trail.activityFor(wp, c.id).some(x => /moved to Ready; told Mira/.test(x.text ?? '')));
    assert.deepEqual(lifecycleWatch.onFinished(wp, a.id), [], 'once');
  } finally { await done(); }
});

test('PR merged: the story moves to Merged and Asha is told; she closes it to Done (an assignee may not)', async () => {
  const { wp, story, raw, patch, done } = setup();
  try {
    writeGithubMode(wp, 'on');
    const s = story('Settings version', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'dev' }, 'tara');
    patch(s.id, { pr: pr({ merged: { at: '2026-10-05T11:00:00Z', sha: 'm1', by: 'coo' } }) });
    assert.equal(lifecycleWatch.onMerged(wp, s.id, 'coo'), 'moved');
    assert.equal(raw(s.id).status, 'done');
    assert.equal(items.require$(wp, s.id).trueStatus, 'merged');
    const told = manager.list(wp).find(a => a.key.startsWith(`merged:${s.id}`));
    assert.ok(told && /Close it: item_update/.test(told.text ?? ''));
    assert.throws(() => items.update(wp, s.id, { status: 'done' }, 'tara'), /Asha's call/);
    const it = items.update(wp, s.id, { status: 'done' }, 'asha');
    assert.equal(it.trueStatus, 'done');
    assert.ok(it.closedAt);
  } finally { await done(); }
});

/* ---------- the hygiene rules ---------- */

test('(a) the top of a person\'s queue: idle for 10 min is a violation; working on a lower item is too; Asha\'s top is to be routed', async () => {
  const { wp, story, done } = setup();
  try {
    const top = story('Top story', 'tara');
    const t0 = Date.now();
    assert.deepEqual(rules(hygiene.sweep(wp, t0)), []);
    assert.deepEqual(rules(hygiene.sweep(wp, t0 + 9 * MIN)), [], 'not before 10 min');
    let r = hygiene.sweep(wp, t0 + 11 * MIN);
    assert.deepEqual(rules(r), [`top-idle:${top.id}`]);
    assert.match(r.violations[0]!.what, /top of Tara's queue \(Ready\), and Tara is idle/);
    assert.match(r.violations[0]!.fix, /start Tara on it/);
    assert.equal(r.violations[0]!.minutes, 11);

    const lower = story('Lower story', 'tara');
    employees.assign(wp, lower.id);
    r = hygiene.sweep(wp, t0 + 12 * MIN);
    const v = r.violations.find(x => x.rule === 'top-idle')!;
    assert.match(v.what, /Tara is on lower-ranked "Lower story"/);
    employees.close(wp, employees.openSession('tara')!.agentId, 'switching'); // not a queued switch
    employees.assign(wp, top.id);
    assert.ok(!hygiene.sweep(wp, t0 + 13 * MIN).violations.some(x => x.itemId === top.id && x.rule === 'top-idle'), 'on it now');

    const route = story('Needs routing', 'asha');
    const t1 = t0 + 20 * MIN;
    hygiene.sweep(wp, t1);
    r = hygiene.sweep(wp, t1 + 11 * MIN);
    assert.match(r.violations.find(x => x.itemId === route.id)!.what, /Asha's routing queue, not routed/);
  } finally { await done(); }
});

test('(b) In progress with no live session for 10 min (the stuck rule), reported once, not also as (a)', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Orphan', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const r = hygiene.sweep(wp, t0 + 11 * MIN);
    assert.deepEqual(rules(r), [`no-session:${s.id}`]);
    assert.match(r.violations[0]!.fix, /wake Tara/);
  } finally { await done(); }
});

test('(c) Blocked without a concrete blocker, or blocked on a closed item, at once', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const bare = story('Bare block', 'tara');
    patch(bare.id, { status: 'blocked', state: 'blocked', blockedReason: 'stuck', statusSince: new Date().toISOString() });
    const dep = story('Abandoned', 'kabir');
    const s = story('Waits on abandoned', 'mira');
    items.update(wp, s.id, { status: 'in-progress' }, 'mira');
    items.update(wp, s.id, { status: 'blocked', waitingOn: dep.id, blockedReason: 'needs it' }, 'mira');
    items.update(wp, dep.id, { status: 'done', resolution: 'wont-do' }, 'owner');
    const r = hygiene.sweep(wp, Date.now());
    const c = r.violations.filter(v => v.rule === 'bad-block');
    assert.deepEqual(c.map(v => v.itemId).sort(), [bare.id, s.id].sort());
    assert.match(c.find(v => v.itemId === bare.id)!.what, /no waitingOn/);
    assert.match(c.find(v => v.itemId === s.id)!.what, /Blocked on "Abandoned", which is Done \(wont-do\)/);
  } finally { await done(); }
});

test('(d) In review with no reviewer, or (mode on) a story with no PR', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const a = story('No reviewer', 'tara');
    patch(a.id, { status: 'in-review', state: 'review', statusSince: new Date().toISOString() });
    writeGithubMode(wp, 'on');
    // Kabir's repo: one story branch with a commit (code to submit), another story with no branch.
    const repo = mkdtempSync(join(tmpdir(), 'hyg-'));
    const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    g('init', '-q', '-b', 'trunk'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const kabir = wp.org.employees.find(e => e.id === 'kabir')!;
    kabir.workspace = { ...kabir.workspace, repo, branch: 'trunk' };
    const b = story('No PR', 'kabir');
    g('checkout', '-q', '-b', `emp/kabir/${b.id}`); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work'); g('checkout', '-q', 'trunk');
    items.update(wp, b.id, { status: 'in-progress' }, 'kabir');
    items.update(wp, b.id, { status: 'in-review', reviewerId: 'dev' }, 'kabir');
    const c = story('Live check with a teammate, no code', 'kabir');
    items.update(wp, c.id, { status: 'in-progress' }, 'kabir');
    items.update(wp, c.id, { status: 'in-review', reviewerId: 'tara' }, 'kabir');
    const d = hygiene.sweep(wp, Date.now()).violations.filter(v => v.rule === 'bad-review');
    assert.match(d.find(v => v.itemId === a.id)!.what, /no reviewer/);
    assert.match(d.find(v => v.itemId === b.id)!.what, /no pull request/);
    assert.ok(!d.some(v => v.itemId === c.id), 'a sign-off wait with no code needs no PR');
    rmSync(repo, { recursive: true, force: true });
  } finally { await done(); }
});

test('(e) Done with an unmerged, unapproved PR is a violation; Approved-awaiting-merge is not', async () => {
  const { wp, story, raw, patch, done } = setup();
  try {
    writeGithubMode(wp, 'on');
    const bad = story('Done too early', 'tara');
    patch(bad.id, { status: 'done', state: 'done', resolution: 'done', pr: pr() });
    const ok = story('Approved', 'kabir');
    items.update(wp, ok.id, { status: 'in-progress' }, 'kabir');
    items.update(wp, ok.id, { status: 'in-review', reviewerId: 'dev' }, 'kabir');
    const ep = raw(ok.id).statusSince!;
    patch(ok.id, { status: 'done', state: 'done', resolution: 'done', pr: pr({ devApproval: approval('dev', ep), qaApproval: approval('nikhil', ep) }) });
    const e = hygiene.sweep(wp, Date.now()).violations.filter(v => v.rule === 'done-unmerged');
    assert.deepEqual(e.map(v => v.itemId), [bad.id]);
    assert.match(e[0]!.what, /PR #7 is not merged/);
  } finally { await done(); }
});

test('(f) an unassigned Ready item at the top of the global queue for 15 min', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Nobody has it');
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    assert.deepEqual(rules(hygiene.sweep(wp, t0 + 14 * MIN)), []);
    const r = hygiene.sweep(wp, t0 + 16 * MIN);
    assert.deepEqual(rules(r), [`unrouted-top:${s.id}`]);
    assert.match(r.violations[0]!.fix, /Asha routes it/);
  } finally { await done(); }
});

test('(g) the assignee is whoever works on it: a live session by someone else for 10 min is a violation', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Shared screen', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    employees.assign(wp, s.id);
    items.update(wp, s.id, { assigneeId: 'dev' }, 'owner');
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const r = hygiene.sweep(wp, t0 + 11 * MIN);
    const g = r.violations.find(v => v.rule === 'wrong-assignee')!;
    assert.equal(g.itemId, s.id);
    assert.match(g.what, /Tara is working on it, but it is assigned to Dev/);
    assert.match(g.fix, /reassign it to Tara/);
  } finally { await done(); }
});

/* ---------- the paused floor, dedupe and the two cadences ---------- */

test('paused floor: the monitor is silent and its clocks restart after the resume', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const s = story('Idle top', 'tara');
    const bare = story('Bare', 'kabir');
    patch(bare.id, { status: 'blocked', state: 'blocked', statusSince: new Date().toISOString() });
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    floor.setPaused(wp, true, 'maintenance', 'owner');
    const coosBefore = cooHygiene(wp).length;
    const r = hygiene.sweep(wp, t0 + 61 * MIN);
    assert.deepEqual(r, { violations: [], asha: null, coo: null });
    assert.equal(cooHygiene(wp).length, coosBefore);
    floor.setPaused(wp, false, '', 'owner');
    const after = hygiene.sweep(wp, t0 + 62 * MIN);
    assert.ok(!after.violations.some(v => v.itemId === s.id), 'the 10-min clock started again at the resume');
    assert.ok(hygiene.sweep(wp, t0 + 73 * MIN).violations.some(v => v.itemId === s.id));
  } finally { await done(); }
});

test('hygiene no longer tells Asha (LLD-rework W2 §6): violations are still computed, no alert and no session', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const a = story('Bare A', 'tara');
    patch(a.id, { status: 'blocked', state: 'blocked', statusSince: new Date().toISOString() });
    const t0 = Date.now();
    const sessions = runtime.sessions.length;
    for (const m of [0, 11, 22, 33]) {
      const r = hygiene.sweep(wp, t0 + m * MIN);
      assert.equal(r.asha, null);
      assert.ok(r.violations.some(v => v.rule === 'bad-block' && v.itemId === a.id), 'still computed');
    }
    assert.equal(hygieneAlerts(wp).length, 0);
    assert.equal(runtime.sessions.length, sessions, 'no session for Asha');
  } finally { await done(); }
});

test('COO every 60 min: one hygiene bridge item with counts and the 3 oldest; nothing when clean', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const t0 = Date.now();
    assert.equal(hygiene.sweep(wp, t0).coo, null, 'clean: nothing');
    assert.equal(cooHygiene(wp).length, 0);
    const ids = ['One', 'Two', 'Three', 'Four'].map((t, i) => {
      const s = story(t, 'tara');
      patch(s.id, { status: 'blocked', state: 'blocked', statusSince: new Date(t0 - (10 - i) * MIN).toISOString() });
      return s.id;
    });
    assert.equal(hygiene.sweep(wp, t0 + 30 * MIN).coo, null, 'not before 60 min');
    const r = hygiene.sweep(wp, t0 + 61 * MIN);
    assert.ok(r.coo);
    const [item] = cooHygiene(wp);
    assert.match(item!.title, /Board hygiene: 4 violations, \d+% clean/);
    assert.match(item!.body, /By rule: \(c\) bad-block 4\./);
    assert.ok(item!.body.includes('"One"') && item!.body.includes('"Three"') && !item!.body.includes('"Four"'), 'the 3 oldest');
    assert.equal(hygiene.sweep(wp, t0 + 90 * MIN).coo, null);
    assert.ok(hygiene.sweep(wp, t0 + 122 * MIN).coo, 'again after another hour');
    assert.equal(cooHygiene(wp).length, 2);
    assert.ok(coo.readInboxFileForTest(wp).includes('"kind":"hygiene"'));
    void ids;
  } finally { await done(); }
});

test('GET /api/hygiene report: violations and the clean percentage', async () => {
  const { wp, story, patch, done } = setup();
  try {
    story('Fine 1', 'tara');
    story('Fine 2', 'kabir');
    story('Fine 3', 'mira');
    const bad = story('Bad', 'dev');
    patch(bad.id, { status: 'blocked', state: 'blocked', statusSince: new Date().toISOString() });
    const rep = hygiene.report(wp);
    assert.equal(rep.open, 4);
    assert.equal(rep.clean, 3);
    assert.equal(rep.cleanPct, 75);
    assert.equal(rep.counts['bad-block'], 1);
    assert.equal(rep.violations[0]!.itemId, bad.id);
  } finally { await done(); }
});
