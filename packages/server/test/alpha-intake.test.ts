import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as alpha from '../src/services/alpha-intake.js';
import { testWorkplace } from './fakes/workplace.js';

/** Alpha intake (owner, 3 Oct): triaged tester bugs become Bug bash stories; fixes flow back. */

function fakeBackend(bugs: alpha.AlphaBug[]) {
  const calls: { url: string; body?: unknown }[] = [];
  const fn = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (url.includes('/workplace/bugs?status=unfiled')) return new Response(JSON.stringify({ bugs }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('a triaged bug becomes one ranked story under Bug bash, its id goes back, and a done story reports the fix once', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Bug bash: zero known bugs' }, 'owner');
    // Exactly what the iris-alpha backend sends (bug_view + evidence), so the test cannot drift from it.
    const bug: alpha.AlphaBug = { bug_id: 'B1', title: 'Windows app does not open', summary: 'Crashes on launch', priority: 'P0', platforms: ['windows'], affected_testers: ['a@x.com', 'b@x.com'], affected_count: 2, evidence: [{ report_id: 'R1', what_happened: 'Double-click, nothing', platform: 'windows', app_version: '0.2.17', files: [{ url: 'https://example/s.png', type: 'image/png' }] }] };
    const cfg = { apiBase: 'https://alpha.example', token: 't' };
    const be = fakeBackend([bug]);
    const r1 = await alpha.tick(wp, cfg, be.fn);
    assert.deepEqual(r1.filed, ['B1']);
    const stories = items.plan(wp).unfiled.find(c => c.epic.id === epic.id)!;
    assert.equal(stories.progress.storiesTotal, 1);
    const filedCall = be.calls.find(c => c.url.endsWith('/workplace/bugs/B1/filed'))!;
    const storyId = (filedCall.body as { story_id: string }).story_id;
    const s = items.get(wp, storyId)!;
    assert.match(s.title, /^\[Alpha P0\] Windows app does not open/);
    assert.match(String((s as { body?: string }).body), /Testers affected: 2/);
    assert.match(String((s as { body?: string }).body), /alpha bug B1/);
    assert.match(String((s as { body?: string }).body), /https:\/\/example\/s\.png/);
    assert.match(String((s as { body?: string }).body), /What happened: Double-click, nothing/);

    // Same bug offered again (backend missed the ack): no second story.
    await alpha.tick(wp, cfg, be.fn);
    assert.equal(items.plan(wp).unfiled.find(c => c.epic.id === epic.id)!.progress.storiesTotal, 1);

    // Done → fixed reported exactly once.
    items.update(wp, storyId, { status: 'in-progress', assigneeId: 'dev', reason: 'test: moved' } as never, 'asha');
    items.update(wp, storyId, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'dev');
    items.update(wp, storyId, { status: 'done', reason: 'test: moved' }, 'nikhil');
    const be2 = fakeBackend([]);
    const r2 = await alpha.tick(wp, cfg, be2.fn);
    assert.deepEqual(r2.fixed, ['B1']);
    assert.deepEqual(be2.calls.find(c => c.url.endsWith('/workplace/bugs/B1/fixed'))!.body, { version: 'next-build' });
    const r3 = await alpha.tick(wp, cfg, fakeBackend([]).fn);
    assert.deepEqual(r3.fixed, []);
  } finally {
    tmp.cleanup();
  }
});

test('no config file means intake stays off', () => {
  assert.equal(alpha.readConfig('/nonexistent-dir'), null);
});
