import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as areas from '../src/services/areas.js';
import * as status from '../src/services/status.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * status_of / GET /api/status resolve item ids (as_*, ft_*, any v2 id), an id inside the question,
 * and per-charter story titles with or without their " — <Charter>" suffix.
 */

function seed(wp: ReturnType<typeof testWorkplace>['wp']) {
  const memory = areas.create(wp, { title: 'Memory' }, 'owner');
  const epic = items.create(wp, { level: 'epic', title: 'Greeting context contract', areaId: memory.id }, 'owner');
  const forMemory = items.create(wp, { level: 'story', parentId: epic.id, title: 'Greeting context contract — Memory', assigneeId: 'kabir' }, 'asha');
  const forExperts = items.create(wp, { level: 'story', parentId: epic.id, title: 'Greeting context contract — Experts', assigneeId: 'mira' }, 'asha');
  const greeting = items.create(wp, { level: 'story', parentId: epic.id, title: 'Daily greeting, weather-aware — Desktop (Mac)', assigneeId: 'rohan' }, 'asha');
  return { memory, epic, forMemory, forExperts, greeting };
}

test('an exact item id resolves to that item: assignment (as_*), feature (ft_*) and v2-created ids', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, greeting } = seed(wp);
    const legacy = work.create(wp, { kind: 'assignment', title: 'Phone to Mac errand flow — Desktop (Mac)', charterId: 'desktop-mac', by: 'owner' });
    const feature = work.create(wp, { kind: 'feature', title: 'Phone to Mac errand flow', by: 'owner' });
    for (const id of [greeting.id, epic.id, legacy.id, feature.id]) {
      const a = status.answer(wp, id);
      assert.equal(a.matches.length, 1, `${id} resolves`);
      assert.equal(a.matches[0]!.item.id, id);
      assert.equal(a.line, a.matches[0]!.line);
      assert.equal(a.matches[0]!.href, `item/${id}`);
    }
    assert.match(legacy.id, /^as_/);
    assert.match(feature.id, /^ft_/);
    const unknown = status.answer(wp, 'as_nothinghere1');
    assert.equal(unknown.matches.length, 0);
    assert.equal(unknown.line, 'Nothing in the plan matches "as_nothinghere1".');
  } finally {
    tmp.cleanup();
  }
});

test('an id inside the question resolves, and every id named is answered', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { greeting, forMemory } = seed(wp);
    const one = status.answer(wp, `what's the status of ${greeting.id}?`);
    assert.deepEqual(one.matches.map(m => m.item.id), [greeting.id]);
    const two = status.answer(wp, `how are ${greeting.id} and (${forMemory.id}) doing`);
    assert.deepEqual(two.matches.map(m => m.item.id), [greeting.id, forMemory.id]);
  } finally {
    tmp.cleanup();
  }
});

test('a merged id answers with the item it was merged into', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { forMemory, forExperts } = seed(wp);
    items.merge(wp, forExperts.id, forMemory.id, 'owner');
    const a = status.answer(wp, forExperts.id);
    assert.deepEqual(a.matches.map(m => m.item.id), [forMemory.id]);
  } finally {
    tmp.cleanup();
  }
});

test('per-charter titles: the base title finds every charter piece, the full title finds that one (not the area)', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { forMemory, forExperts, greeting } = seed(wp);
    const full = status.answer(wp, 'Greeting context contract — Memory');
    assert.equal(full.matches[0]!.item.id, forMemory.id, 'the exact title wins over the Memory area');
    const base = status.answer(wp, 'greeting context contract');
    const ids = base.matches.map(m => m.item.id);
    assert.ok(ids.includes(forMemory.id) && ids.includes(forExperts.id), 'both charter pieces are answered');
    const short = status.answer(wp, 'status of Daily greeting, weather-aware');
    assert.equal(short.matches[0]!.item.id, greeting.id);
    const named = status.answer(wp, 'Daily greeting, weather-aware (Desktop (Mac))');
    assert.equal(named.matches[0]!.item.id, greeting.id);
  } finally {
    tmp.cleanup();
  }
});

test('GET /api/status?q=<id> answers the item', async () => {
  const b = await boot();
  try {
    const { greeting } = seed(b.running.wp);
    const res = await call<{ matches: { item: { id: string } }[] }>(b.base, 'GET', `/api/status?q=${encodeURIComponent(greeting.id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.matches[0]!.item.id, greeting.id);
  } finally {
    await b.stop();
  }
});
