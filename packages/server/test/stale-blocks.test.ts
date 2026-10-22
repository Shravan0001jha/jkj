import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as hygiene from '../src/services/hygiene.js';
import * as lifecycleWatch from '../src/services/lifecycle-watch.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * RCA (owner, 22 Oct): a story sat Blocked on a Done item (13h, then again). The release ran only on the blocker's
 * own finish event, once per pair, and a block raised on an already-Done item got no event at all.
 */
const runtime = installFakeRuntime();
after(() => runtime.restore());

function setup() {
  const t = testWorkplace();
  const epic = items.create(t.wp, { level: 'epic', title: 'Practice' }, 'owner');
  const story = (title: string, assigneeId = 'tara') => items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId } as never, 'owner');
  const raw = (id: string) => rawGet(t.wp, id)!;
  const patch = (id: string, p: Partial<WorkItem>) => work.saveQuiet(t.wp, { ...raw(id), ...p });
  const close = (id: string, extra: Partial<WorkItem> = {}) => patch(id, { status: 'done', resolution: 'done', statusSince: new Date().toISOString(), ...extra });
  const block = (id: string, p: Partial<WorkItem>) => patch(id, { status: 'blocked', blockedSince: new Date().toISOString(), blockedReason: 'waits', ...p });
  const woke = () => runtime.sessions.flatMap(x => [x.options.prompt, ...x.sent.map(m => m.text)]).filter(x => /Unblocked:/.test(String(x)));
  return { ...t, story, raw, patch, close, block, woke, done: async () => { await new Promise(r => setTimeout(r, 200)); t.tmp.cleanup(); } };
}

test('a block raised on an item that is already Done is released when saved, with a comment and a wake', async () => {
  const { wp, story, raw, close, block, woke, done } = setup();
  try {
    const dep = story('Dep', 'nikhil'); const s = story('Waiter');
    close(dep.id); block(s.id, { waitingOn: dep.id });
    lifecycleWatch.onItem(wp, s.id);
    assert.equal(raw(s.id).status, 'ready');
    assert.ok(woke().length >= 1, 'assignee woken');
  } finally { await done(); }
});

test('a Done blocker releases a block whose once-per-pair key was already spent', async () => {
  const { wp, story, raw, close, block, done } = setup();
  try {
    const dep = story('Dep', 'nikhil'); const s = story('Waiter');
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`dep-ready:${s.id}:${dep.id}`, 'x');
    block(s.id, { waitingOn: dep.id, startsAfter: dep.id });
    close(dep.id);
    lifecycleWatch.onFinished(wp, dep.id);
    assert.equal(raw(s.id).status, 'ready');
    assert.equal(raw(s.id).startsAfter, undefined);
  } finally { await done(); }
});

test('not released while it also waits on something else still open (the COO, or another open item)', async () => {
  const { wp, story, raw, close, block, done } = setup();
  try {
    const dep = story('Dep', 'nikhil'); const other = story('Other', 'nikhil'); const a = story('A'); const b = story('B');
    close(dep.id);
    block(a.id, { waitingOn: 'coo', startsAfter: dep.id });
    block(b.id, { waitingOn: other.id, startsAfter: dep.id });
    lifecycleWatch.onFinished(wp, dep.id); lifecycleWatch.releaseStale(wp);
    assert.equal(raw(a.id).status, 'blocked');
    assert.equal(raw(b.id).status, 'blocked');
    assert.ok(!hygiene.report(wp).violations.some(v => v.itemId === a.id), 'hygiene does not flag a block that really waits on the COO');
  } finally { await done(); }
});

test('Done with an unmerged PR does not release; the sweep releases a stale block no event ever reached, and hygiene (c) agrees', async () => {
  const { wp, story, raw, close, block, done } = setup();
  try {
    const dep = story('Dep', 'nikhil'); const s = story('Waiter'); const u = story('Unmerged', 'nikhil'); const w2 = story('W2');
    close(u.id, { pr: { number: 1, url: 'u', branch: 'b', base: 'main', headSha: 'x', pushedAt: 'x' } as never });
    block(w2.id, { waitingOn: u.id });
    close(dep.id); block(s.id, { waitingOn: dep.id });
    assert.ok(hygiene.report(wp).violations.some(v => v.itemId === s.id && v.rule === 'bad-block'));
    assert.ok(!hygiene.report(wp).violations.some(v => v.itemId === w2.id));
    hygiene.sweep(wp);
    assert.equal(raw(s.id).status, 'ready');
    assert.equal(raw(w2.id).status, 'blocked');
  } finally { await done(); }
});
