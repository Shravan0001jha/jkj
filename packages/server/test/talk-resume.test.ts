import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as employees from '../src/services/employees.js';
import * as spend from '../src/services/spend.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * QA, 2 Oct: a Workplace restart ended every talk/review session (no assignment) and nothing brought
 * them back; assignment sessions already resumed through `resume:<id>`. Now a talk session that was
 * mid-turn when the Workplace went down (an orderly shutdown, or a crash found on boot) resumes its
 * own SDK conversation on boot with a short "the Workplace restarted" message. A talk that had
 * finished its turn, or ended normally, is left alone.
 */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));

async function midTurnTalk(wp: Wp, fake: FakeRuntime, emp = 'mira') {
  employees.talk(wp, emp, 'Look into the duck-under-speech bug', [], { autonomous: true });
  await tick();
  return of(fake, emp).at(-1)!;
}

test('an orderly shutdown mid-turn: the boot resumes the talk\'s own conversation with a restart note, once', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const first = await midTurnTalk(wp, fake);
    employees.closeAll(wp, 'shutdown');
    assert.equal(employees.openSession('mira'), undefined);

    const result = await employees.resumeAfterShutdown(wp, 5);
    await tick();
    assert.deepEqual(result.resumedTalks.map(t => t.employeeId), ['mira']);
    const again = of(fake, 'mira').at(-1)!;
    assert.notEqual(again, first);
    assert.equal(again.options.resume, first.sessionId, 'the same SDK conversation, not a fresh one');
    assert.match(again.options.prompt, /Workplace restarted.*continue where you left off/i);
    assert.ok(employees.openSession('mira'));

    employees.closeAll(wp, 'test teardown');
    assert.deepEqual((await employees.resumeAfterShutdown(wp, 5)).resumedTalks, [], 'consumed: a second boot does nothing');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a talk whose turn had finished, or that ended normally, is not resumed', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const idle = await midTurnTalk(wp, fake, 'mira');
    idle.result();
    await tick();
    const ended = await midTurnTalk(wp, fake, 'kabir');
    employees.close(wp, employees.openSession('kabir')!.agentId, 'ended');
    void ended;
    employees.closeAll(wp, 'shutdown');
    const before = fake.sessions.length;
    const result = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(result.resumedTalks, []);
    assert.equal(fake.sessions.length, before);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a crash (open talk rows found on boot): a mid-turn talk resumes, an idle one does not, a probe never', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const running = await midTurnTalk(wp, fake, 'mira');
    const idle = await midTurnTalk(wp, fake, 'kabir');
    idle.result();
    employees.talk(wp, 'tara', 'probe: are you there?', [], { autonomous: true, probe: true });
    await tick();
    // The process dies: rows are still open when the next boot looks.
    employees.recoverAfterRestart(wp);
    employees.closeAll(wp, 'test teardown of the dead process');
    const result = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(result.resumedTalks.map(t => t.employeeId), ['mira']);
    assert.equal(of(fake, 'mira').at(-1)!.options.resume, running.sessionId);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a capped or busy employee is not resumed now; the marker waits for the next boot', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    await midTurnTalk(wp, fake, 'mira');
    employees.closeAll(wp, 'shutdown');
    const day = spend.dayOf();
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${day}:employee:mira`, new Date().toISOString());
    const capped = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(capped.resumedTalks, []);
    assert.ok(capped.skipped.some(s => s.id.includes('mira') || /mira/i.test(s.reason)));
    wp.db.prepare('delete from settings where key = ?').run(`paused:${day}:employee:mira`);

    employees.talk(wp, 'mira', 'something else', [], { autonomous: true });
    await tick();
    const busy = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(busy.resumedTalks, [], 'one session at a time: an open session is not displaced');
    employees.closeAll(wp, 'test teardown');
    assert.deepEqual((await employees.resumeAfterShutdown(wp, 5)).resumedTalks.map(t => t.employeeId), ['mira'], 'the next boot takes it');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
