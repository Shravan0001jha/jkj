import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as agents from '../src/services/agents.js';
import * as coo from '../src/services/coo.js';
import { installFakeRuntime, type FakeRuntime, type FakeSession } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * 4 Oct, 08:49 UTC: the COO told Asha (POST /api/talk) to lift a hold and start work. Her session
 * (run_bkgqs7wz) took it, called status_of five times, and the loop detector interrupted it and
 * ended the session. The interrupt's own "error_during_execution" result arrived just after the
 * handoff prompt, so the handoff wait ended at once and the session closed 8 ms later: no handoff,
 * and the COO's message was gone with the session. Now a talk message the session had not finished
 * acting on is delivered again in the next session, and the handoff wait ignores a stale result.
 */

const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));

function setup() {
  const t = testWorkplace();
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  return { ...t, fake, done: () => { fake.restore(); t.tmp.cleanup(); } };
}

const COO = 'COO decision: the hold is LIFTED. Assign the 2 ready stories to idle people now.';

test('the 4 Oct incident: a COO message cut off by a stall-end is delivered again, and the handoff turn is not cut short', async () => {
  const { wp, fake, done } = setup();
  try {
    employees.talk(wp, 'asha', 'Manager digest (every 20 min while work is active): act on what needs you.', [], { autonomous: true });
    await tick();
    const s = of(fake, 'asha')[0]!;
    s.say('Confirmed stale; nothing left for me on it.');
    s.result();
    await tick();

    const agent = employees.talk(wp, 'asha', COO);
    s.say('Running the floor: gathering state first.');
    for (const who of ['mira', 'kabir', 'neel', 'ira', 'arjun']) s.tool('mcp__workplace__status_of', { query: who });

    // The stall path: interrupt, then end the session. The interrupted turn's result lands after the
    // handoff prompt, as it did live.
    fake.onSend = (session, text) => { if (session === s && /session is ending/.test(text)) s.result({ subtype: 'error_during_execution' }); };
    await runs.interruptRun(agent.id);
    const ending = employees.endSession(wp, agent.id, 2_000, true, { redeliver: true });
    await tick(40);
    assert.equal(s.closed, false, 'the stale result of the interrupted turn does not end the handoff wait');

    s.say('Status and handoff written.');
    s.result();
    await ending;
    assert.equal(s.closed, true);
    await tick();

    const next = of(fake, 'asha').at(-1)!;
    assert.notEqual(next, s, 'a new session for Asha');
    assert.ok(next.options.prompt.includes(COO), 'carrying the COO message');
    assert.match(next.options.prompt, /Delivered again/);
  } finally {
    done();
  }
});

test('a message queued into a busy session that closes before it ran is delivered in a new session', async () => {
  const { wp, fake, done } = setup();
  try {
    employees.talk(wp, 'asha', 'Team Room moderation: two threads.', [], { autonomous: true });
    await tick();
    const s = of(fake, 'asha')[0]!;
    s.tool('mcp__workplace__room_read', { threadId: 'th_1' });
    employees.talk(wp, 'asha', COO);              // mid-turn: queued behind the running turn
    s.say('Thread one resolved.');                 // the same model call: the message has not reached the model
    s.result({ subtype: 'error_max_turns' });
    await tick();
    employees.close(wp, employees.openSession('asha')!.agentId, 'stale (test)', { redeliver: true });
    await tick();
    assert.equal(s.closed, true);
    const next = of(fake, 'asha').at(-1)!;
    assert.notEqual(next, s);
    assert.ok(next.options.prompt.includes(COO));
  } finally {
    done();
  }
});

test('a message injected mid-turn and acted on is answered: closing the session delivers nothing again', async () => {
  const { wp, fake, done } = setup();
  try {
    employees.talk(wp, 'asha', 'Team Room moderation: two threads.', [], { autonomous: true });
    await tick();
    const s = of(fake, 'asha')[0]!;
    employees.talk(wp, 'asha', COO);
    s.tool('mcp__workplace__room_read', { threadId: 'th_1' });
    s.tool('mcp__workplace__item_update', { id: 'st_1', assigneeId: 'kabir' });   // the next model call, after the tool result: the message is in
    s.say('Assigned both stories.');
    s.result();
    await tick();
    employees.close(wp, employees.openSession('asha')!.agentId, 'stale (test)', { redeliver: true });
    await tick();
    assert.equal(of(fake, 'asha').length, 1, 'no second session');
  } finally {
    done();
  }
});

test('the owner pressing Stop is not undone: his interrupted message is not delivered again', async () => {
  const { wp, fake, done } = setup();
  try {
    const agent = employees.talk(wp, 'asha', 'Rewrite every spec from scratch.');
    await tick();
    const s = of(fake, 'asha')[0]!;
    s.say('Starting on the specs.');
    await agents.interruptAgent(agent.id);
    s.result({ subtype: 'error_during_execution' });
    await tick();
    employees.close(wp, agent.id, 'stale (test)', { redeliver: true });
    await tick();
    assert.equal(of(fake, 'asha').length, 1);
  } finally {
    done();
  }
});

test('delivered again only once: a second loss goes to the COO instead of a loop of sessions', async () => {
  const { wp, fake, done } = setup();
  try {
    const first = employees.talk(wp, 'asha', COO);
    await tick();
    employees.close(wp, first.id, 'stale (test)', { redeliver: true });
    await tick();
    const second: FakeSession = of(fake, 'asha').at(-1)!;
    assert.equal(of(fake, 'asha').length, 2);
    employees.close(wp, employees.openSession('asha')!.agentId, 'stale (test)', { redeliver: true });
    await tick();
    assert.equal(of(fake, 'asha').length, 2, 'no third session');
    assert.equal(second.closed, true);
    assert.ok(coo.listItems(wp, 'open').some(i => /Asha/.test(i.title) && /not delivered/i.test(i.title) && i.body.includes('hold is LIFTED')));
  } finally {
    done();
  }
});
