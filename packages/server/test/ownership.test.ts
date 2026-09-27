import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapEntry, Requirement } from '@jkj/shared';
import { lint, resolve, route, type LintFs } from '../src/services/ownership.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

const entry = (kind: MapEntry['kind'], key: string, primary: string, consulted: string[] = []): MapEntry =>
  ({ kind, key, primary, contributors: [], consulted });

const map: MapEntry[] = [
  entry('path', 'iris:services/agent-svc', 'experts', ['conversation']),
  entry('path', 'iris:services/agent-svc/memory_client.py', 'memory'),
  entry('path', 'iris:services/iris-api/', 'server'),
  entry('service', 'iris-api', 'server'),
  entry('platform', 'ios', 'mobile'),
  entry('keyword', 'errand', 'experts', ['mobile']),
  entry('keyword', 'voice', 'conversation'),
  entry('requirement-group', 'Memory', 'memory'),
  entry('requirement', 'REQ-MEMORY-03', 'server'),
];

const requirements: Requirement[] = [
  { id: 'REQ-MEMORY-01', group: 'Memory', section: '§3', title: 'Remembers preferences', segments: [], status: 'built', evidence: [], charterId: null, featureIds: [] },
  { id: 'REQ-MEMORY-03', group: 'Memory', section: '§3', title: 'Evolves over time', segments: [], status: 'partial', evidence: [], charterId: null, featureIds: [] },
  { id: 'REQ-SOCIAL-01', group: 'Social', section: '§3', title: 'Iris Park', segments: [], status: 'missing', evidence: [], charterId: null, featureIds: [] },
];

test('paths resolve by longest prefix', () => {
  assert.equal(resolve(map, { kind: 'path', key: 'iris:services/agent-svc/experts/browser.py' })?.primary, 'experts');
  assert.equal(resolve(map, { kind: 'path', key: 'iris:services/agent-svc/memory_client.py' })?.primary, 'memory');
  assert.equal(resolve(map, { kind: 'path', key: 'iris:services/iris-api/app.py' })?.primary, 'server');
  assert.equal(resolve(map, { kind: 'path', key: 'iris:services/iris-api' })?.primary, 'server');
  // A prefix must end at a path boundary: agent-svc-old is not agent-svc.
  assert.equal(resolve(map, { kind: 'path', key: 'iris:services/agent-svc-old/x.py' }), null);
  // A bare "<repo>:" key is the repo root and covers every path in it.
  const withRoot = [...map, entry('path', 'iris-deploy:', 'server')];
  assert.equal(resolve(withRoot, { kind: 'path', key: 'iris-deploy:scripts/deploy-api.sh' })?.primary, 'server');
  assert.equal(resolve(withRoot, { kind: 'path', key: 'iris-deploy:' })?.primary, 'server');
  assert.equal(resolve(withRoot, { kind: 'path', key: 'iris-deployment:x' }), null);
});

test('requirements resolve by id first, then by group', () => {
  assert.equal(resolve(map, { kind: 'requirement', key: 'REQ-MEMORY-01' }, requirements)?.primary, 'memory');
  assert.equal(resolve(map, { kind: 'requirement', key: 'REQ-MEMORY-03' }, requirements)?.primary, 'server');
  assert.equal(resolve(map, { kind: 'requirement', key: 'REQ-SOCIAL-01' }, requirements), null);
  assert.equal(resolve(map, { kind: 'requirement', key: 'REQ-NOPE-01' }, requirements), null);
});

test('everything else resolves exactly', () => {
  assert.equal(resolve(map, { kind: 'service', key: 'iris-api' })?.primary, 'server');
  assert.equal(resolve(map, { kind: 'service', key: 'iris-api-2' }), null);
  assert.equal(resolve(map, { kind: 'platform', key: 'ios' })?.primary, 'mobile');
});

test('route collects one hit per primary with the things that put it there, plus consulted', () => {
  const result = route(map, {
    title: 'Phone→Mac errand flow',
    body: 'An errand stated on the phone runs on the Mac; voice confirmation.',
    things: [
      { kind: 'path', key: 'iris:services/agent-svc/phone.py' },
      { kind: 'service', key: 'iris-api' },
      { kind: 'platform', key: 'ios' },
    ],
  });
  assert.deepEqual(result.primaries.map(h => h.charterId), ['experts', 'conversation', 'mobile', 'server']);
  const experts = result.primaries.find(h => h.charterId === 'experts')!;
  assert.deepEqual(experts.because, [
    { kind: 'path', key: 'iris:services/agent-svc/phone.py' },
    { kind: 'keyword', key: 'errand' },
  ]);
  // consulted excludes charters that are already primaries
  assert.deepEqual(result.consulted, []);
  assert.deepEqual(result.unresolved, []);
});

test('route lists what it could not resolve instead of dropping it', () => {
  const result = route(map, { things: [{ kind: 'service', key: 'nothing-here' }] });
  assert.deepEqual(result.primaries, []);
  assert.deepEqual(result.unresolved, [{ kind: 'service', key: 'nothing-here' }]);
});

test('keywords match whole words only', () => {
  assert.equal(route(map, { title: 'invoice pipeline' }).primaries.length, 0);   // "voice" inside "invoice"
  assert.equal(route(map, { title: 'the voice loop' }).primaries[0]?.charterId, 'conversation');
});

/* ---------- lint ---------- */

const fakeFs = (dirs: Record<string, string[]>, missing: string[] = []): LintFs => ({
  exists: p => !missing.some(m => p.endsWith(m)),
  topLevelDirs: root => dirs[root] ?? [],
});

test('the seed organisation lints clean apart from disk-dependent checks', () => {
  const wp = tmpWorkplace();
  try {
    const findings = lint(wp.org, [], fakeFs({}));
    assert.deepEqual(findings, []);
  } finally {
    wp.cleanup();
  }
});

test('each lint code fires on the fault it names', () => {
  const wp = tmpWorkplace();
  try {
    const org = wp.org;
    const root = org.repos[0]!.root;

    // orphan: a top-level directory nobody owns
    let f = lint(org, [], fakeFs({ [root]: ['mystery-dir'] }));
    assert.ok(f.some(x => x.code === 'orphan' && x.subject === 'iris:mystery-dir'));
    assert.ok(!f.some(x => x.code === 'orphan' && x.subject === 'iris:desktop'));

    // overlap: two primaries for one thing
    org.map.push({ kind: 'platform', key: 'ios', primary: 'server', contributors: [], consulted: [] });
    f = lint(org, [], fakeFs({}));
    assert.ok(f.some(x => x.code === 'overlap' && x.subject === 'platform:ios'));
    org.map.pop();

    // dead: a path that is gone
    f = lint(org, [], fakeFs({}, ['services/agent-svc/speaker.py']));
    assert.ok(f.some(x => x.code === 'dead' && x.subject === 'iris:services/agent-svc/speaker.py'));

    // unowned-requirement
    f = lint(org, [{ ...requirements[2]!, group: 'Nowhere' }], fakeFs({}));
    assert.ok(f.some(x => x.code === 'unowned-requirement' && x.subject === 'REQ-SOCIAL-01'));

    // unheld-charter
    const tara = org.employees.find(e => e.id === 'tara')!;
    const held = tara.charterIds;
    tara.charterIds = [];
    org.charters.get('mobile')!.holderIds = [];
    f = lint(org, [], fakeFs({}));
    assert.ok(f.some(x => x.code === 'unheld-charter' && x.subject === 'mobile'));
    tara.charterIds = held;

    // unknown-ref
    org.map.push({ kind: 'keyword', key: 'zzz', primary: 'no-such-charter', contributors: [], consulted: [] });
    f = lint(org, [], fakeFs({}));
    assert.ok(f.some(x => x.code === 'unknown-ref' && x.severity === 'error'));
  } finally {
    wp.cleanup();
  }
});
