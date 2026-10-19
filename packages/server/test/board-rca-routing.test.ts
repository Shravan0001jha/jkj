import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as dispatch from '../src/services/dispatch.js';
import * as hygiene from '../src/services/hygiene.js';
import * as manager from '../src/services/manager.js';
import * as cos from '../src/services/cos.js';
import { rawGet } from '../src/services/v2-map.js';
import * as employees from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Board bug 5 (19 Oct): five Ready stories in ft_mv438x2svlhtf sat with no assignee for 7+ hours. A bug
 * filed with its RCA is created unassigned "for the Chief of Staff to route", but the dispatcher only
 * routes stories ASSIGNED to her, and nothing she is sent (alerts, the 20-min digest, the 5-min tick,
 * which only moderates the Room) ever listed an unassigned story. The hourly hygiene report named only the
 * top one, and only to the COO. Asha could not find them either: status_of is a text search and the epic
 * read stops at 15 children. She routed them within minutes of the COO naming them.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const MIN = 60_000;
const RCA = ['## RCA', '- Symptom: quarter to 12am rings at 11:45am', '- Root cause: the 12 o\'clock branch flips am/pm', '- Why it escaped: no 12am case in the table', '- Fix: treat 12 as 0 before the offset', '- Regression guard: a 12am/12pm row in the shared case table'].join('\n');

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const told = (emp: string): string[] => runtime.sessions.filter(x => x.options.cwd.includes(`/${emp}/`)).flatMap(x => [x.options.prompt, ...x.sent.map(m => m.text)]);

test('a bug filed with its RCA (unassigned, "the Chief of Staff routes it") is handed to Asha\'s routing by the dispatcher', async () => {
  const { wp, tmp } = testWorkplace();
  withOauth(tmp.dir);
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Phone without a Mac' }, 'owner');
    const bug = items.create(wp, { level: 'story', type: 'bug', parentId: epic.id, title: 'timeparse.py: quarter to 12am flips am/pm', body: RCA }, 'nikhil');
    assert.equal(rawGet(wp, bug.id)!.employeeId, undefined, 'filed unassigned, by design');
    const r = dispatch.dispatch(wp, 'asha');
    assert.equal(r.itemId, bug.id, 'Asha\'s queue holds the unassigned story');
    assert.equal(rawGet(wp, bug.id)!.employeeId, 'asha');
    assert.ok(told('asha').some(t => t.startsWith('Route this:') && t.includes(bug.id)), 'she gets the routing prompt');
    await new Promise(r => setTimeout(r, 50));
  } finally { tmp.cleanup(); }
});

test('class: unassigned Ready or focus-Backlog stories are all in Asha\'s routing queue; tasks, epics and held items are not', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Phone without a Mac' }, 'owner');
    items.setFocus(wp, [epic.id], 'owner');
    const a = items.create(wp, { level: 'story', parentId: epic.id, title: 'Filed by the owner, nobody named' }, 'owner');
    const b = items.create(wp, { level: 'story', parentId: epic.id, title: 'In focus, Backlog', status: 'backlog' }, 'nikhil');
    const held = items.create(wp, { level: 'story', parentId: epic.id, title: 'Parked', assigneeId: 'kabir' }, 'owner');
    items.update(wp, held.id, { assigneeId: '', note: 'unassign' } as never, 'owner');
    items.update(wp, held.id, { status: 'parked', note: 'later', resumeWhen: 'the owner says' }, 'owner');
    const ids = dispatch.queue(wp, 'asha').map(w => w.id);
    assert.ok(ids.includes(a.id), 'unassigned Ready');
    assert.ok(ids.includes(b.id), 'unassigned focus Backlog');
    assert.ok(!ids.includes(held.id), 'a parked story is not routed');
    assert.ok(!ids.includes(epic.id));
  } finally { tmp.cleanup(); }
});

test('the Chief of Staff tick runs every 10 minutes and hands Asha the concrete list: unrouted Ready stories and wrong statuses', () => {
  const { wp, tmp } = testWorkplace();
  withOauth(tmp.dir);
  try {
    assert.equal(cos.COS_TICK_MS, 10 * MIN);
    const epic = items.create(wp, { level: 'epic', title: 'Phone without a Mac' }, 'owner');
    const t0 = Date.now();
    // Nothing on the board: nothing sent.
    assert.equal(cos.boardCheck(wp, t0), null);
    const a = items.create(wp, { level: 'story', parentId: epic.id, title: 'Nobody has it' }, 'owner');
    const blocked = items.create(wp, { level: 'story', parentId: epic.id, title: 'Blocked on a done story', assigneeId: 'kabir' }, 'owner');
    const dep = items.create(wp, { level: 'story', parentId: epic.id, title: 'Dependency', assigneeId: 'mira' }, 'owner');
    items.update(wp, blocked.id, { status: 'blocked', waitingOn: dep.id, blockedReason: 'needs the dependency', note: 'blocked' }, 'kabir');
    items.update(wp, dep.id, { status: 'done', resolution: 'wont-do', note: 'dropped' }, 'owner');
    // An unrouted story is not news before it has waited 10 minutes (the dispatcher gets the first chance);
    // a wrong status is a fact at once.
    const early = cos.boardCheck(wp, t0 + 1 * MIN);
    assert.ok(early && !early.includes(a.id) && early.includes(blocked.id));
    // Her session from that check has ended (between turns it would be a message into it).
    for (const x of employees.allSessions()) employees.close(wp, x.agentId, 'ended');
    const text = cos.boardCheck(wp, t0 + 11 * MIN);
    assert.ok(text);
    assert.match(text, new RegExp(`${a.id}.*Nobody has it`));
    assert.match(text, /item_update .*assigneeId/);
    assert.match(text, new RegExp(`${blocked.id}`));
    const rec = manager.list(wp).filter(r => r.key.startsWith('board:')).pop();
    assert.ok(rec, 'queued to Asha through the manager (delivered between her turns, never dropped)');
    assert.equal(rec.state, 'delivered');
    assert.ok(told('asha').some(t => t.includes(a.id)), 'it reached her session');
  } finally { tmp.cleanup(); }
});

test('class: hygiene (f) names every unassigned Ready story, not only the top of the queue', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Phone without a Mac' }, 'owner');
    const a = items.create(wp, { level: 'story', parentId: epic.id, title: 'One' }, 'owner');
    const b = items.create(wp, { level: 'story', parentId: epic.id, title: 'Two' }, 'owner');
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const r = hygiene.sweep(wp, t0 + 16 * MIN).violations.filter(v => v.rule === 'unrouted-top').map(v => v.itemId).sort();
    assert.deepEqual(r, [a.id, b.id].sort());
  } finally { tmp.cleanup(); }
});
