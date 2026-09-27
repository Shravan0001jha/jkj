import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '@jkj/shared';
import { assembleContext, PLAN_FIRST, unitChain } from '../src/services/context-layers.js';
import { writeEmployeeFile } from '../src/services/org.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

const assignment: WorkItem = {
  id: 'as_1', kind: 'assignment', title: 'Phone→Mac errand: iOS side', body: 'Add the errand composer to the iPhone app.',
  state: 'proposed', requirementIds: ['REQ-CROSSDEVICE-02'], platformIds: ['ios'], createdAt: '', updatedAt: '', history: [],
};

test('layers come in the documented order: handbook, unit, charters, status/handoff, assignment', () => {
  const wp = tmpWorkplace();
  try {
    writeEmployeeFile(wp.org, 'tara', 'status.md', 'doing: iOS errands\ndone: -\nblocked: -\n');
    writeEmployeeFile(wp.org, 'tara', 'handoff.md', 'Next: wire the composer to /v1/relay.\n');
    const tara = wp.org.employees.find(e => e.id === 'tara')!;
    const ctx = assembleContext(wp.org, tara, { assignment });
    assert.deepEqual(ctx.layers.map(l => l.id), [
      'handbook', 'unit:platforms', 'charter:mobile', 'role:lead', 'status', 'handoff', 'assignment',
    ]);
    const order = ['## Company handbook', '## Unit: Platforms', '## Charter:', '## Status', '## Handoff', '## Assignment:'];
    let last = -1;
    for (const marker of order) {
      const i = ctx.append.indexOf(marker);
      assert.ok(i > last, `${marker} in order`);
      last = i;
    }
    assert.ok(ctx.append.includes('wire the composer to /v1/relay'));
    assert.ok(ctx.append.includes(PLAN_FIRST));
    assert.ok(ctx.append.startsWith('You are Tara'));
    assert.equal(ctx.truncated, false);
  } finally {
    wp.cleanup();
  }
});

test('a chapter member gets the chapter doc too', () => {
  const wp = tmpWorkplace();
  try {
    const kabir = wp.org.employees.find(e => e.id === 'kabir')!;
    const ctx = assembleContext(wp.org, kabir);
    assert.deepEqual(ctx.layers.filter(l => l.id.startsWith('unit:') || l.id.startsWith('chapter:')).map(l => l.id),
      ['unit:capabilities', 'chapter:platforms']);
    assert.deepEqual(ctx.layers.filter(l => l.id.startsWith('charter:')).map(l => l.id), ['charter:memory', 'charter:server']);
  } finally {
    wp.cleanup();
  }
});

test('moving a charter to another unit changes only the unit layer', () => {
  const wp = tmpWorkplace();
  try {
    const org = wp.org;
    const tara = org.employees.find(e => e.id === 'tara')!;
    const before = assembleContext(org, tara);
    tara.unitId = 'capabilities';
    const after = assembleContext(org, tara);
    assert.equal(before.layers.find(l => l.id.startsWith('unit:'))!.id, 'unit:platforms');
    assert.equal(after.layers.find(l => l.id.startsWith('unit:'))!.id, 'unit:capabilities');
    const strip = (ids: string[]) => ids.filter(i => !i.startsWith('unit:'));
    assert.deepEqual(strip(before.layers.map(l => l.id)), strip(after.layers.map(l => l.id)));
    assert.equal(before.layers.find(l => l.id === 'charter:mobile')!.body, after.layers.find(l => l.id === 'charter:mobile')!.body);
  } finally {
    wp.cleanup();
  }
});

test('a nested unit inherits its parent chain, outermost first', () => {
  const wp = tmpWorkplace();
  try {
    wp.org.units.push({ id: 'ios-pod', title: 'iOS pod', parentId: 'platforms', kind: 'unit' });
    assert.deepEqual(unitChain(wp.org, 'ios-pod').map(u => u.id), ['platforms', 'ios-pod']);
  } finally {
    wp.cleanup();
  }
});

test('over the token cap, charter detail is trimmed and the result says so', () => {
  const wp = tmpWorkplace();
  try {
    const dev = wp.org.employees.find(e => e.id === 'dev')!;
    const full = assembleContext(wp.org, dev, { maxTokens: 100_000 });
    const tight = assembleContext(wp.org, dev, { maxTokens: Math.round(full.tokens * 0.6) });
    assert.equal(full.truncated, false);
    assert.equal(tight.truncated, true);
    assert.ok(tight.tokens < full.tokens);
    assert.ok(tight.append.includes('## Company handbook'), 'the handbook is never dropped first');
  } finally {
    wp.cleanup();
  }
});
