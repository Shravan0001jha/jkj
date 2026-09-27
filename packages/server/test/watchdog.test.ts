import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog, type Link, type BootMarks } from '../src/services/watchdog.js';

/**
 * The watchdog (docs/RESILIENCE-workplace.md §4): the tunnel down for more than five minutes is one
 * incident → one "down" ping, retried until it is delivered, then one "back" ping; a crash loop is
 * one "restarting" ping and one "stable" ping. Never a third message for the same incident.
 */

const MIN = 60_000;

function harness(opts: { link?: Link; deliver?: boolean; boots?: BootMarks; bootedAt?: number } = {}) {
  const state = { now: 1_000_000_000_000, link: opts.link ?? 'connected' as Link, deliver: opts.deliver ?? true };
  const sent: string[] = [];
  let tries = 0;
  const dog = new Watchdog({
    link: () => state.link,
    notify: async text => { tries += 1; if (state.deliver) sent.push(text); return state.deliver; },
    now: () => state.now,
    downAfterMs: 5 * MIN,
    retryMs: MIN,
    stableAfterMs: 15 * MIN,
    bootedAt: opts.bootedAt ?? state.now,
    ...(opts.boots ? { boots: opts.boots } : {}),
  });
  const advance = async (ms: number, step = 30_000) => {
    const end = state.now + ms;
    while (state.now < end) { state.now = Math.min(end, state.now + step); await dog.tick(); }
  };
  return { dog, state, sent, tries: () => tries, advance };
}

function fakeMarks(recent: number[], total = recent.length): BootMarks & { alerted: string | null } {
  const m = {
    alerted: null as string | null,
    history: () => ({ total, recent: recent.map(t => new Date(t).toISOString()) }),
    crashLoopAlertedAt: () => m.alerted,
    markCrashLoop: (at: string | null) => { m.alerted = at; },
  };
  return m;
}

test('tunnel down under five minutes is a blip: no ping at all', async () => {
  const h = harness();
  await h.dog.tick();
  h.state.link = 'offline';
  await h.advance(4 * MIN);
  h.state.link = 'connected';
  await h.advance(2 * MIN);
  assert.deepEqual(h.sent, []);
  assert.equal(h.dog.state.incidents, 0);
  assert.equal(h.dog.state.downSince, null);
});

test('down for more than five minutes: one "down" ping, silence while it stays down, one "back" ping on recovery', async () => {
  const h = harness();
  await h.dog.tick();
  h.state.link = 'connecting';
  await h.advance(5 * MIN + 30_000);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /tunnel down/);
  assert.match(h.sent[0]!, /5 min/);
  assert.ok(h.dog.state.incident?.alertedAt, 'the incident remembers the ping');

  await h.advance(60 * MIN);
  assert.equal(h.sent.length, 1, 'an hour more of the same outage adds nothing');

  h.state.link = 'connected';
  await h.advance(MIN);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /tunnel back/);
  assert.match(h.sent[1]!, /66 min/);
  assert.equal(h.dog.state.incident, null, 'closed');
  assert.equal(h.dog.state.last?.recoveredAt, new Date(h.state.now).toISOString());
  assert.equal(h.dog.state.incidents, 1);

  // A second outage later is a second incident with its own two pings.
  h.state.link = 'offline';
  await h.advance(6 * MIN);
  h.state.link = 'connected';
  await h.advance(MIN);
  assert.equal(h.sent.length, 4);
  assert.equal(h.dog.state.incidents, 2);
});

test('when the ping cannot be delivered (no internet at all) it is retried once a minute until it is, and still counts once', async () => {
  const h = harness({ deliver: false });
  await h.dog.tick();
  h.state.link = 'offline';
  await h.advance(5 * MIN + 30_000);
  const firstTries = h.tries();
  assert.ok(firstTries >= 1, 'tried');
  assert.equal(h.sent.length, 0);
  await h.advance(5 * MIN);
  assert.ok(h.tries() - firstTries >= 4 && h.tries() - firstTries <= 6, `about one try per minute: ${h.tries() - firstTries}`);
  assert.equal(h.dog.state.incident?.alertedAt, null);

  h.state.deliver = true;
  await h.advance(MIN);
  assert.equal(h.sent.length, 1, 'delivered once');
  await h.advance(10 * MIN);
  assert.equal(h.sent.length, 1, 'never repeated');
});

test('recovered before the "down" ping ever got out: one combined ping, not two', async () => {
  const h = harness({ deliver: false });
  await h.dog.tick();
  h.state.link = 'offline';
  await h.advance(20 * MIN);
  assert.equal(h.sent.length, 0);
  h.state.link = 'connected';
  h.state.deliver = true;
  await h.advance(2 * MIN);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /was down/);
  assert.match(h.sent[0]!, /20 min/);
  assert.equal(h.dog.state.incident, null);
  assert.equal(h.dog.state.incidents, 1);
});

test('the owner\'s off switch and an unconfigured tunnel are not incidents', async () => {
  const h = harness({ link: 'not-configured' });
  await h.advance(30 * MIN);
  assert.deepEqual(h.sent, []);
  h.state.link = 'connected';
  await h.dog.tick();
  h.state.link = 'off';
  await h.advance(30 * MIN);
  assert.deepEqual(h.sent, []);
  assert.equal(h.dog.state.incident, null);
  // Off part-way through an open incident closes it quietly: the owner chose it.
  h.state.link = 'offline';
  await h.advance(6 * MIN);
  assert.equal(h.sent.length, 1);
  h.state.link = 'off';
  await h.advance(2 * MIN);
  assert.equal(h.sent.length, 1, 'no "back" ping for a deliberate off');
  assert.equal(h.dog.state.incident, null);
});

test('crash loop: three starts in ten minutes → one "restarting" ping; the next restart within the hour stays quiet; 15 min up → one "stable" ping', async () => {
  const now = 1_000_000_000_000;
  const marks = fakeMarks([now - 8 * MIN, now - 3 * MIN, now]);
  const h = harness({ boots: marks, bootedAt: now });
  await h.dog.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /restarting repeatedly/);
  assert.match(h.sent[0]!, /3 starts/);
  assert.equal(marks.alerted, new Date(now).toISOString());

  // The process dies again two minutes later and a new one boots: it sees the mark and says nothing.
  const again = fakeMarks([now - 8 * MIN, now - 3 * MIN, now, now + 2 * MIN]);
  again.alerted = marks.alerted;
  const h2 = harness({ boots: again, bootedAt: now + 2 * MIN });
  h2.state.now = now + 2 * MIN;
  await h2.dog.tick();
  assert.equal(h2.sent.length, 0, 'already alerted this incident');

  // This one lives: after 15 minutes up it reports stable and clears the mark for the next incident.
  await h2.advance(14 * MIN);
  assert.equal(h2.sent.length, 0);
  await h2.advance(2 * MIN);
  assert.equal(h2.sent.length, 1);
  assert.match(h2.sent[0]!, /stable again/);
  assert.equal(again.alerted, null, 'mark cleared');
  await h2.advance(60 * MIN);
  assert.equal(h2.sent.length, 1);
});

test('two starts in ten minutes, or three spread over a day, are not a crash loop', async () => {
  const now = 1_000_000_000_000;
  const two = harness({ boots: fakeMarks([now - 5 * MIN, now]), bootedAt: now });
  await two.advance(20 * MIN);
  assert.deepEqual(two.sent, []);
  const spread = harness({ boots: fakeMarks([now - 20 * 60 * MIN, now - 9 * 60 * MIN, now]), bootedAt: now });
  await spread.advance(20 * MIN);
  assert.deepEqual(spread.sent, []);
});

test('a stale crash-loop mark from an earlier day does not suppress a new loop', async () => {
  const now = 1_000_000_000_000;
  const marks = fakeMarks([now - 6 * MIN, now - 2 * MIN, now]);
  marks.alerted = new Date(now - 26 * 60 * MIN).toISOString();
  const h = harness({ boots: marks, bootedAt: now });
  await h.dog.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /restarting repeatedly/);
});

test('the state the health check shows: link, down since, the open incident, the last one, counts', async () => {
  const h = harness();
  await h.dog.tick();
  assert.deepEqual(h.dog.state, { link: 'connected', downSince: null, incident: null, last: null, incidents: 0, crashLoop: { alertedAt: null, stableAt: null } });
  h.state.link = 'offline';
  await h.dog.tick();
  assert.equal(h.dog.state.downSince, new Date(h.state.now).toISOString());
  assert.equal(h.dog.state.incident, null, 'not yet an incident');
});
