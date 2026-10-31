import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyTimeline } from '../src/services/metrics/timeline.js';
import { waitCause, type CauseCtx } from '../src/services/metrics/causes.js';
import { forecast } from '../src/services/metrics/forecast.js';
import { buildSnapshot, type Rows } from '../src/services/metrics/snapshot.js';

/** LLD-dashboard §2-§4: every number comes from rows the Workplace wrote itself. */

const H = 3_600_000;
const D = 24 * H;
const t0 = Date.parse('2026-10-20T00:00:00Z');

test('timeline: one segment per status, the last runs to now', () => {
  const segs = storyTimeline([
    { itemId: 's1', at: t0, from: 'ready', to: 'in-progress' },
    { itemId: 's1', at: t0 + 2 * H, from: 'in-progress', to: 'in-review' },
    { itemId: 's1', at: t0 + 5 * H, from: 'in-review', to: 'in-progress' },
  ], t0 + 6 * H);
  assert.deepEqual(segs.map(s => [s.status, (s.to - s.from) / H]), [['in-progress', 2], ['in-review', 3], ['in-progress', 1]]);
});

test('timeline: out-of-order rows are sorted; done ends the timeline', () => {
  const segs = storyTimeline([
    { itemId: 's1', at: t0 + 2 * H, from: 'in-review', to: 'done' },
    { itemId: 's1', at: t0, from: 'ready', to: 'in-review' },
  ], t0 + 10 * H);
  assert.deepEqual(segs.map(s => s.status), ['in-review']);
  assert.equal(segs[0]!.to, t0 + 2 * H);
});

const ctx = (over: Partial<CauseCtx> = {}): CauseCtx => ({
  holds: [], caps: [], stagingDown: [], notes: [], inbox: [], assigneeBusy: () => 0, startsAfter: undefined, devApprovalAt: undefined, ...over,
});

test('causes: first match wins, in the LLD order', () => {
  const seg = { status: 'in-review', from: t0, to: t0 + 4 * H };
  assert.equal(waitCause(seg, ctx()).cause, 'review');
  assert.equal(waitCause(seg, ctx({ holds: [{ from: t0 - H, to: t0 + H }] })).cause, 'paused/pace-hold');
  assert.equal(waitCause(seg, ctx({ caps: [{ from: t0, to: t0 + H }] })).cause, 'budget-cap');
  assert.equal(waitCause(seg, ctx({ stagingDown: [{ from: t0, to: t0 + H }] })).cause, 'staging-down');
  assert.equal(waitCause(seg, ctx({ devApprovalAt: t0 + H })).detail, 'approval 2');
  assert.equal(waitCause(seg, ctx()).detail, 'approval 1');
});

test('causes: blocked splits into dependency, mac-or-device, owner-decision, else unknown', () => {
  const seg = { status: 'blocked', from: t0, to: t0 + 4 * H };
  assert.equal(waitCause(seg, ctx({ startsAfter: 'as_x' })).cause, 'dependency');
  assert.equal(waitCause(seg, ctx({ notes: [{ at: t0 + H, text: 'needs the owner Mac for a live check' }] })).cause, 'mac-or-device');
  assert.equal(waitCause(seg, ctx({ inbox: [{ createdAt: t0 + H, answeredAt: t0 + 3 * H }] })).cause, 'owner-decision');
  assert.equal(waitCause(seg, ctx()).cause, 'unknown');
});

test('causes: ready behind a busy assignee; parked', () => {
  assert.equal(waitCause({ status: 'ready', from: t0, to: t0 + 4 * H }, ctx({ assigneeBusy: () => 0.8 })).cause, 'queued-behind-busy');
  assert.equal(waitCause({ status: 'ready', from: t0, to: t0 + 4 * H }, ctx({ assigneeBusy: () => 0.2 })).cause, 'unknown');
  assert.equal(waitCause({ status: 'parked', from: t0, to: t0 + 4 * H }, ctx()).cause, 'parked');
});

test('forecast: median and p90 cycle over people, plus fixed days', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const f = forecast(6, [1, 1, 2, 2, 3, 10], 3, 2, now);
  assert.equal(f.p50, '2026-11-07');   // ceil(6 * 2 / 3) = 4, + 2 fixed
  assert.ok(f.p90 >= f.p50);
  assert.equal(forecast(0, [1], 1, 2, now).p50, '2026-11-03');
  assert.equal(forecast(3, [], 0, 2, now).p50, null);   // no history means no forecast, not a made-up date
});

const rows = (): Rows => ({
  now: Date.parse('2026-11-01T00:00:00Z'),
  epics: [
    { id: 'ep1', title: 'Alarms', status: 'in-progress', statusSince: t0, targetDate: '2026-11-06', createdAt: t0 - 10 * D, targetHistory: [] },
    { id: 'ep2', title: 'Old', status: 'done', statusSince: t0 + D, targetDate: '2026-10-19', createdAt: t0 - 20 * D, targetHistory: [{ at: t0 - 15 * D, from: null, to: '2026-10-15' }] },
  ],
  stories: [
    { id: 's1', epicId: 'ep1', title: 'Repeat alarms', status: 'done', employeeId: 'a', charterId: 'server', createdAt: t0 - D },
    { id: 's2', epicId: 'ep1', title: 'Named timers', status: 'in-review', employeeId: 'b', charterId: 'server', createdAt: t0 - D },
    { id: 's3', epicId: 'ep2', title: 'Old thing', status: 'done', employeeId: 'a', charterId: 'server', createdAt: t0 - 12 * D },
  ],
  transitions: [
    { itemId: 's1', at: t0, from: 'ready', to: 'in-progress' },
    { itemId: 's1', at: t0 + D, from: 'in-progress', to: 'in-review' },
    { itemId: 's1', at: t0 + D + 2 * H, from: 'in-review', to: 'in-progress' },
    { itemId: 's1', at: t0 + 2 * D, from: 'in-progress', to: 'in-review' },
    { itemId: 's1', at: t0 + 3 * D, from: 'in-review', to: 'done' },
    { itemId: 's2', at: t0 + 5 * D, from: 'ready', to: 'in-progress' },
    { itemId: 's2', at: t0 + 6 * D, from: 'in-progress', to: 'in-review' },
    { itemId: 's3', at: t0 - 11 * D, from: 'ready', to: 'in-progress' },
    { itemId: 's3', at: t0 - 10 * D, from: 'in-progress', to: 'done' },
  ],
  holds: [], caps: [], stagingDown: [], notes: [], inbox: [], costByStory: { s1: 100, s2: 50 },
  devApprovals: {}, startsAfter: {},
});

test('snapshot: v1 shape, states, health, send-backs, cost and lost days', () => {
  const snap = buildSnapshot(rows());
  assert.equal(snap.version, 1);
  const ep1 = snap.features.find(f => f.id === 'ep1')!;
  assert.equal(ep1.state, 'in-progress');
  assert.equal(ep1.committedDate, '2026-11-06');
  assert.equal(ep1.costInr, 150);
  assert.equal(ep1.sendBacks, 1);
  assert.equal(ep1.scope.find(s => s.label === 'Repeat alarms')!.status, 'merged');
  assert.equal(ep1.scope.find(s => s.label === 'Named timers')!.status, 'building');
  assert.ok(ep1.lostDays['review']! > 0);
  const ep2 = snap.features.find(f => f.id === 'ep2')!;
  assert.equal(ep2.state, 'delivered');
  assert.equal(ep2.originalDate, '2026-10-15');
  assert.equal(ep2.health, 'delivered');
  assert.ok(snap.gaps.lostDaysByCause.length > 0);
  assert.ok(snap.unknownShare >= 0 && snap.unknownShare <= 1);
});

test('snapshot: a feature past its committed date is late', () => {
  const r = rows();
  r.epics[0]!.targetDate = '2026-10-30';
  assert.equal(buildSnapshot(r).features.find(f => f.id === 'ep1')!.health, 'late');
});

test('splitWait: only the overlapping part is charged to a pause; parked is charged whole', async () => {
  const { splitWait } = await import('../src/services/metrics/causes.js');
  const seg = { status: 'in-review', from: t0, to: t0 + 10 * H };
  const parts = splitWait(seg, ctx({ holds: [{ from: t0 + 8 * H, to: t0 + 20 * H }] }));
  const by = Object.fromEntries(parts.map(p => [p.cause, p.ms / H]));
  assert.equal(by['paused/pace-hold'], 2);
  assert.equal(by['review'], 8);
  const parked = splitWait({ status: 'parked', from: t0, to: t0 + 10 * H }, ctx({ holds: [{ from: t0, to: t0 + 20 * H }] }));
  assert.deepEqual(parked.map(p => p.cause), ['parked']);
});

test('snapshot: every story closed means delivered, even if nobody closed the feature', () => {
  const r = rows();
  r.stories[1]!.status = 'done';
  r.transitions.push({ itemId: 's2', at: t0 + 7 * D, from: 'in-review', to: 'done' });
  const f = buildSnapshot(r).features.find(x => x.id === 'ep1')!;
  assert.equal(f.state, 'delivered');
  assert.equal(f.deliveredAt, new Date(t0 + 7 * D).toISOString());
});

test('GET /api/metrics/snapshot: 404 until the job has run, then the file as JSON', async () => {
  const { boot, call } = await import('./fakes/boot.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const b = await boot();
  try {
    assert.equal((await call(b.base, 'GET', '/api/metrics/snapshot')).status, 404);
    mkdirSync(join(b.tmp.dir, 'metrics'), { recursive: true });
    writeFileSync(join(b.tmp.dir, 'metrics', 'snapshot-v1.json'), JSON.stringify({ version: 1, features: [] }));
    const got = await call<Record<string, unknown>>(b.base, 'GET', '/api/metrics/snapshot');
    assert.equal(got.status, 200);
    assert.equal(got.body['version'], 1);
  } finally { await b.stop(); }
});

test('throughput forecast: own finish rate; stalled features get no date', async () => {
  const { throughputForecast } = await import('../src/services/metrics/forecast.js');
  const now = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(throughputForecast(7, 14, 2, now).p50, '2026-11-10');   // 1/day -> 7 + 2
  assert.deepEqual(throughputForecast(5, 0, 2, now), { p50: null, p90: null });
  assert.equal(throughputForecast(0, 0, 2, now).p50, '2026-11-03');
});
