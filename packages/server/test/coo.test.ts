import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as coo from '../src/services/coo.js';
import * as room from '../src/services/room.js';
import * as employees from '../src/services/employees.js';
import * as inbox from '../src/services/inbox.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The COO bridge (owner, 29 Sep): "Claude — COO" is a virtual employee — shown in Office and Org,
 * never spawned, reached only through the bridge files and /api/coo/* (tested at the route level
 * in api.test.ts / routes-validate.test.ts for the loopback guard). Escalation routing (Team Room
 * → COO → owner, with a 30-minute offline fallback) lives here too.
 */

test('the coo employee is virtual: shown in the org, never spawned or talked to directly', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const e = wp.org.employees.find(x => x.id === 'coo');
    assert.ok(e, 'coo is in the seed organisation');
    assert.equal(e!.virtual, true);
    assert.equal(wp.org.employees.find(x => x.id === 'asha')!.reportsTo, 'coo', 'Asha reports to the COO');
    assert.throws(() => employees.spawn(wp, 'coo', { prompt: 'hi' }), /not spawned by the Workplace/);
    assert.throws(() => employees.talk(wp, 'coo', 'hi'), /POST \/api\/coo\/message/);
  } finally {
    tmp.cleanup();
  }
});

test('presence: offline with no heartbeat, online right after one, offline again once it goes stale', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(coo.presence(wp).online, false);
    coo.touchHeartbeatForTest(wp);
    assert.equal(coo.presence(wp).online, true);
    assert.equal(coo.presence(wp, 0).online, false, 'a zero threshold treats even a fresh heartbeat as stale');
    const card = employees.card(wp, 'coo');
    assert.equal(card.employee.state, 'online');
    coo.touchHeartbeatForTest(wp, new Date(Date.now() - 10 * 60_000));
    assert.equal(coo.presence(wp).online, false);
    assert.equal(employees.card(wp, 'coo').employee.state, 'offline');
    assert.equal(employees.card(wp, 'coo').employee.stateReason, 'messages wait; Asha handles routine');
  } finally {
    tmp.cleanup();
  }
});

test('the owner talks to the COO: appended to the transcript and the bridge inbox file; the lead replies through /api/coo/reply', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const sent = coo.sendOwnerMessage(wp, 'Ship the release tonight?');
    assert.equal(sent.from, 'owner');
    assert.match(coo.readInboxFileForTest(wp), /Ship the release tonight\?/);

    const reply = coo.replyFromCoo(wp, { inReplyTo: sent.id, text: 'Yes, once QA signs off.', details: 'Nikhil is verifying the last assignment now.' });
    assert.equal(reply.from, 'coo');
    assert.equal(reply.summary, 'Yes, once QA signs off.');
    assert.equal(reply.inReplyTo, sent.id);

    const log = coo.transcript(wp);
    assert.deepEqual(log.map(m => m.id), [sent.id, reply.id]);
    // No mirroring: nothing but what the owner sent and what the lead replied is ever in here.
    assert.ok(log.every(m => m.from === 'owner' || m.from === 'coo'));
  } finally {
    tmp.cleanup();
  }
});

test('routeEscalation: reaches only the COO while it is online; falls back to the owner Inbox once it has been offline for 30 minutes', () => {
  const { wp, tmp } = testWorkplace();
  try {
    coo.touchHeartbeatForTest(wp);
    const online = coo.routeEscalation(wp, { title: 'Split mobile?', body: 'The queue keeps growing.', by: 'asha' });
    assert.equal(online.ownerInboxId, undefined, 'while online, no owner Inbox item yet');
    assert.equal(coo.getItem(wp, online.item.id)!.state, 'open');
    assert.equal(inbox.ownerList(wp, 'open').length, 0);

    coo.touchHeartbeatForTest(wp, new Date(Date.now() - 31 * 60_000));
    const offline = coo.routeEscalation(wp, { title: 'Raise the cap?', body: 'A release is blocked.', by: 'asha' });
    assert.ok(offline.ownerInboxId, 'offline for 30+ minutes: falls back to the owner directly');
    assert.equal(inbox.get(wp, offline.ownerInboxId!)!.title, 'Raise the cap?');
    assert.equal(coo.getItem(wp, offline.item.id)!.state, 'forwarded');
    assert.equal(coo.getItem(wp, offline.item.id)!.forward!.auto, true);
  } finally {
    tmp.cleanup();
  }
});

test('the COO answers within its own authority (no owner Inbox item), or forwards with a recommendation (becomes one)', () => {
  const { wp, tmp } = testWorkplace();
  try {
    coo.touchHeartbeatForTest(wp);
    const { item } = coo.routeEscalation(wp, { title: 'Merge two charters?', body: 'They overlap.', by: 'asha' });

    const answered = coo.answerItem(wp, { itemId: item.id, optionId: 'no', note: 'Keep them separate for now.' });
    assert.equal(answered.state, 'answered');
    assert.equal(inbox.ownerList(wp, 'open').length, 0, 'settled by the COO; the owner never sees it');
    assert.throws(() => coo.answerItem(wp, { itemId: item.id, optionId: 'no' }), /already answered/);

    const { item: item2 } = coo.routeEscalation(wp, { title: 'Money above the cap?', body: 'A release needs it.', by: 'asha' });
    const owned = coo.forwardItem(wp, { itemId: item2.id, recommendation: 'Approve; the spend is one-off and under 5% of the cap.' });
    assert.match(owned.body, /The COO's recommendation: Approve/);
    assert.equal(coo.getItem(wp, item2.id)!.state, 'forwarded');
  } finally {
    tmp.cleanup();
  }
});

test('a Team Room escalation routes through the COO first; falls back to the owner only when the COO is offline (the default in a fresh workplace)', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { thread } = room.createThread(wp, { title: 'Who owns app.py?', text: 'Three plans stopped here.', by: 'mira', charterIds: ['experts'] });
    // No heartbeat has ever been touched: offline by default, so this behaves as it always did.
    const fallenBack = room.escalate(wp, thread.id, { title: 'Who owns app.py?', body: 'One file, three owners.', by: 'asha' });
    assert.ok('affects' in fallenBack, 'an InboxItem reached the owner directly');
    assert.deepEqual(room.getThread(wp, thread.id)!.escalations, [fallenBack.id]);

    coo.touchHeartbeatForTest(wp);
    const { thread: thread2 } = room.createThread(wp, { title: 'Rename a chapter?', text: 'Cosmetic only.', by: 'dev', charterIds: [] });
    const toCoo = room.escalate(wp, thread2.id, { title: 'Rename a chapter?', body: 'Cosmetic only.', by: 'asha' });
    assert.ok(!('affects' in toCoo), 'online: it went to the COO, not the owner\'s Inbox');
    assert.equal((toCoo as { state: string }).state, 'open');
  } finally {
    tmp.cleanup();
  }
});

test('pollPresence emits coo.presence only when online ↔ offline actually flips, to every socket (not just loopback)', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const events: { presence: { online: boolean } }[] = [];
    wp.on(e => { if (e.type === 'coo.presence') events.push(e); });

    coo.pollPresence(wp); // first poll (still offline): seeds, no event
    assert.equal(events.length, 0);
    coo.pollPresence(wp); // unchanged: no event
    assert.equal(events.length, 0);

    coo.touchHeartbeatForTest(wp);
    coo.pollPresence(wp); // offline -> online: one event
    assert.equal(events.length, 1);
    assert.equal(events[0]!.presence.online, true);
    coo.pollPresence(wp); // still online: no event
    assert.equal(events.length, 1);

    coo.touchHeartbeatForTest(wp, new Date(Date.now() - 10 * 60_000));
    coo.pollPresence(wp); // online -> offline: one event
    assert.equal(events.length, 2);
    assert.equal(events[1]!.presence.online, false);
  } finally {
    tmp.cleanup();
  }
});

test('the approved live-check window is off by default, opens for a fixed number of minutes, and closes on its own', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(coo.liveWindowUntil(wp, 'tara'), null, 'off by default');
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), false);

    const window = coo.openLiveWindow(wp, 'tara', 10);
    assert.equal(window.employeeId, 'tara');
    assert.ok(coo.liveWindowUntil(wp, 'tara')! > Date.now());
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), true);
    // A different employee is untouched.
    assert.equal(coo.isLiveWindowOpen(wp, 'mira'), false);

    // It closes on its own once the minutes pass (an injected "now" past `until`, no real sleep).
    const past = Date.parse(window.until) + 1;
    assert.equal(coo.isLiveWindowOpen(wp, 'tara', past), false);
    // A fresh window after it closes opens again.
    coo.openLiveWindow(wp, 'tara', 5);
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), true);

    assert.throws(() => coo.openLiveWindow(wp, 'tara', 0), /positive number/);
    assert.throws(() => coo.openLiveWindow(wp, 'tara', -5), /positive number/);
  } finally {
    tmp.cleanup();
  }
});
