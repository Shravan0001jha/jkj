import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitOrg, loadOrg, orgHistory, parseCharter, renderCharter, saveOrgFiles, writeEmployeeFile, readEmployeeFile } from '../src/services/org.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

test('the seed loads with every reference resolving', () => {
  const wp = tmpWorkplace();
  try {
    const org = wp.org;
    assert.equal(org.employees.length, 7);
    assert.equal(org.charters.size, 12);
    assert.equal(org.units.length, 4);
    for (const e of org.employees) {
      assert.ok(org.roles.some(r => r.id === e.roleId), `${e.id} role`);
      assert.ok(org.units.some(u => u.id === e.unitId), `${e.id} unit`);
      for (const c of e.charterIds) assert.ok(org.charters.has(c), `${e.id} holds ${c}`);
    }
    // Levels: chief of staff 0, leads 1; nobody is a hire in the seed.
    assert.equal(org.employees.find(e => e.id === 'asha')!.level, 0);
    assert.ok(org.employees.filter(e => e.id !== 'asha').every(e => e.level === 1));
    assert.ok(org.employees.every(e => e.permanent));
    // Holders are derived from employees.
    assert.deepEqual(org.charters.get('mobile')!.holderIds, ['tara']);
    assert.deepEqual(org.charters.get('memory')!.holderIds, ['kabir']);
    // Every charter is held.
    for (const c of org.charters.values()) assert.ok(c.holderIds.length > 0, `${c.id} held`);
    // Owned things come from the map.
    assert.ok(org.charters.get('experts')!.owns.some(o => o.key === 'iris:services/agent-svc/experts'));
    assert.ok(org.handbook.length > 500);
    assert.equal(org.unitDocs.size, 4);
  } finally {
    wp.cleanup();
  }
});

test('a charter with the wrong axis is refused with its path', () => {
  assert.throws(
    () => parseCharter('---\nid: x\ntitle: X\naxis: device\n---\n## Mission and scope\n- a\n', '/tmp/x.md'),
    /\/tmp\/x\.md: axis must be/,
  );
  assert.throws(() => parseCharter('no front matter', '/tmp/y.md'), /\/tmp\/y\.md: a charter starts/);
});

test('a charter file whose id does not match its name is refused', () => {
  const wp = tmpWorkplace();
  try {
    writeFileSync(join(wp.dir, 'charters', 'wrong.md'), '---\nid: other\ntitle: T\naxis: function\n---\n## Mission and scope\n- a\n');
    assert.throws(() => loadOrg(wp.dir), /wrong\.md: front-matter id "other"/);
  } finally {
    wp.cleanup();
  }
});

test('an employee pointing at an unknown charter is refused', () => {
  const wp = tmpWorkplace();
  try {
    const text = readFileSync(join(wp.dir, 'org.yaml'), 'utf8').replace('charterIds: [mobile]', 'charterIds: [mobile, nope]');
    writeFileSync(join(wp.dir, 'org.yaml'), text);
    assert.throws(() => loadOrg(wp.dir), /employee tara holds unknown charter nope/);
  } finally {
    wp.cleanup();
  }
});

test('charter sections are parsed into fields and rendered back losslessly', () => {
  const wp = tmpWorkplace();
  try {
    const c = wp.org.charters.get('conversation')!;
    assert.ok(c.rules.length > 0, 'rules parsed');
    assert.ok(c.definitionOfDone.length > 0, 'definition of done parsed');
    assert.ok(c.buildTestShip.length > 0, 'build/test/ship parsed');
    assert.ok(c.mission.length > 10);
    const again = parseCharter(renderCharter(c), c.path);
    assert.equal(again.body, c.body);
    assert.equal(again.id, c.id);
  } finally {
    wp.cleanup();
  }
});

test('saving the org files and committing produces history', () => {
  const wp = tmpWorkplace();
  try {
    commitOrg(wp.dir, 'Seed the first organisation');
    const org = wp.org;
    org.units.push({ id: 'growth', title: 'Growth', parentId: 'product', kind: 'chapter' });
    saveOrgFiles(org);
    writeEmployeeFile(org, 'tara', 'status.md', 'doing: x\ndone: y\nblocked: -\n');
    const sha = commitOrg(wp.dir, 'Add the Growth chapter: because the definition names segments');
    assert.ok(sha);
    const history = orgHistory(wp.dir);
    assert.equal(history[0]!.message, 'Add the Growth chapter: because the definition names segments');
    assert.equal(history[1]!.message, 'Seed the first organisation');
    const reloaded = wp.reload();
    assert.ok(reloaded.units.some(u => u.id === 'growth'));
    assert.equal(readEmployeeFile(reloaded, 'tara', 'status.md'), 'doing: x\ndone: y\nblocked: -\n');
    // Nothing to commit is not an error.
    assert.equal(commitOrg(wp.dir, 'nothing'), null);
  } finally {
    wp.cleanup();
  }
});
