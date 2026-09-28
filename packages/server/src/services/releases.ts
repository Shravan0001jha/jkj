import { spawn as spawnProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Release, ReleaseReadiness, Shippable } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { gate, requestApproval } from './approvals.js';
import * as inbox from './inbox.js';
import * as work from './work.js';
import * as spend from './spend.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, Conflict } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Releases and deploys, gated (HLD D8, LLD §8).
 *
 * Every shippable maps to the real script in the right checkout. `run`
 * refuses without an approved Inbox item for exactly this release id; the
 * script's output streams to the socket and is kept on the row. QA prepares,
 * the owner approves, nothing runs on its own.
 */

export interface ScriptSpec {
  cwd: string;
  command: string;
  args: string[];
  /** What the script does, for the approval text. */
  note: string;
  /** The gate action: release or deploy. */
  action: 'release' | 'deploy';
}

export function scriptFor(wp: Workplace, shippable: Shippable, version: string): ScriptSpec {
  const iris = wp.org.repos.find(r => r.id === 'iris')?.root ?? '';
  const deploy = wp.org.repos.find(r => r.id === 'iris-deploy')?.root ?? iris;
  const mobile = wp.org.repos.find(r => r.id === 'iris-mobile')?.root ?? iris;
  switch (shippable) {
    case 'desktop-mac':
      return { cwd: iris, command: join(iris, 'scripts/release-iris.sh'), args: [version], note: 'Bundles the agent, builds and notarises the Mac app, uploads the DMG, bumps latest.json, invalidates the CDN. Kills the installed Iris and does not relaunch it.', action: 'release' };
    case 'desktop-intel':
      return { cwd: iris, command: join(iris, 'scripts/release-iris-x64.sh'), args: [version], note: 'The Intel build of the same release.', action: 'release' };
    case 'windows':
      return { cwd: iris, command: 'pwsh', args: [join(iris, 'scripts/release-iris-win.ps1'), version], note: 'The Windows release; a human teammate also develops Windows.', action: 'release' };
    case 'ios':
      return { cwd: join(mobile, 'mobile/ios'), command: join(mobile, 'mobile/ios/testflight.sh'), args: [version], note: 'Archive and upload to TestFlight through App Store Connect.', action: 'release' };
    case 'android':
      return { cwd: join(mobile, 'mobile/android'), command: './gradlew', args: ['bundleRelease'], note: 'A signed Android bundle; the store upload is a separate step.', action: 'release' };
    case 'server-api':
      return { cwd: deploy, command: join(deploy, 'scripts/deploy-api.sh'), args: [], note: 'Deploys iris-api from the deploy worktree only. Back up /opt/iris-api/iris.db first.', action: 'deploy' };
    case 'server-agent':
      return { cwd: deploy, command: join(deploy, 'scripts/deploy-agent.sh'), args: [], note: 'Deploys the cloud agent from the deploy worktree only.', action: 'deploy' };
    case 'website':
      return { cwd: iris, command: join(iris, 'scripts/deploy-web.sh'), args: [], note: 'Deploys web/ to S3 and CloudFront.', action: 'deploy' };
  }
}

export type Spawner = (spec: ScriptSpec, onLine: (line: string) => void) => Promise<{ code: number }>;

export const realSpawner: Spawner = (spec, onLine) => new Promise(resolve => {
  const child = spawnProcess(spec.command, spec.args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const feed = (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.trim()) onLine(line); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('close', code => resolve({ code: code ?? 1 }));
  child.on('error', err => { onLine(`spawn failed: ${err.message}`); resolve({ code: 1 }); });
});

let spawner: Spawner = realSpawner;
export function useSpawner(fn: Spawner | null): void {
  spawner = fn ?? realSpawner;
}

export function propose(wp: Workplace, shippable: Shippable, version: string, by = 'nikhil'): Release {
  if (!version.trim()) throw new BadRequest('A release needs a version.');
  const spec = scriptFor(wp, shippable, version);
  const release: Release = {
    id: newId('rel'),
    shippable,
    version: version.trim(),
    state: 'proposed',
    unreleased: unreleasedFor(wp, shippable),
    inboxId: '',
    createdAt: now(),
  };
  const item = requestApproval(wp, spec.action, release.id, {
    kind: 'release',
    title: `${spec.action === 'release' ? 'Release' : 'Deploy'} ${shippable} ${version}`,
    body: `${spec.note}\n\nRuns: ${spec.command} ${spec.args.join(' ')}\nIn: ${spec.cwd}\n\nMerged but unreleased (${release.unreleased.length}):\n${release.unreleased.map(u => `- ${u}`).join('\n') || '- nothing recorded'}`,
    raisedBy: by,
    context: { releaseId: release.id, shippable, version },
  });
  release.inboxId = item.id;
  wp.db.prepare('insert into releases (id, shippable, version, state, created_at, json) values (?, ?, ?, ?, ?, ?)').run(release.id, shippable, release.version, release.state, release.createdAt, JSON.stringify(release));
  wp.emit({ type: 'release.updated', release });
  return release;
}

export function list(wp: Workplace): Release[] {
  return rowsJson<Release>(wp.db.prepare('select json from releases order by created_at desc, rowid desc').all()).map(r => ({ ...r, state: liveState(wp, r) }));
}

export function get(wp: Workplace, id: string): Release | undefined {
  const r = rowJson<Release>(wp.db.prepare('select json from releases where id = ?').get(id));
  return r ? { ...r, state: liveState(wp, r) } : undefined;
}

/** proposed/approved/rejected follow the Inbox; running/done/failed are the script's. */
function liveState(wp: Workplace, r: Release): Release['state'] {
  if (r.state === 'running' || r.state === 'done' || r.state === 'failed') return r.state;
  const item = inbox.get(wp, r.inboxId);
  if (item?.state !== 'answered') return 'proposed';
  return item.answer?.optionId === 'approve' ? 'approved' : 'rejected';
}

/** The gate, then the real script. Never without an approved item. */
/** Run an approved release to the end. Tests and the CLI wait; the HTTP route uses `start`. */
export async function run(wp: Workplace, id: string): Promise<Release> {
  return start(wp, id).done;
}

/**
 * Validate and start an approved release, returning at once with the `running` row; `done`
 * settles when the script ends. A release takes minutes and the phone reaches us through a relay
 * with a request timeout, so the route answers 202 and progress arrives as `release.log` /
 * `release.updated` events (28 Sep, phone end to end).
 */
export function start(wp: Workplace, id: string): { release: Release; done: Promise<Release> } {
  const release = get(wp, id);
  if (!release) throw new BadRequest(`No release ${id}`);
  if (release.state === 'running') throw new Conflict(`${id} is already running`);
  if (release.state === 'done') throw new Conflict(`${id} already ran`);
  const spec = scriptFor(wp, release.shippable, release.version);
  const g = gate(wp, spec.action, id);
  if (!g.allowed) throw new BadRequest(`Refused: ${g.reason}`);

  const running: Release = { ...release, state: 'running', log: '' };
  save(wp, running);
  log.info('releases', `running ${spec.command} ${spec.args.join(' ')} in ${spec.cwd} (approved in ${g.inboxId})`);
  return { release: running, done: finish(wp, release, spec) };
}

async function finish(wp: Workplace, release: Release, spec: ReturnType<typeof scriptFor>): Promise<Release> {
  const lines: string[] = [];
  const { code } = await spawner(spec, line => {
    lines.push(line);
    wp.emit({ type: 'release.log', id: release.id, line });
  });
  const finished: Release = { ...release, state: code === 0 ? 'done' : 'failed', log: lines.join('\n') };
  save(wp, finished);
  // Real money, estimated (HLD D9b): an upload, transfer and a CloudFront invalidation, or a deploy's transfer.
  const estimate = spec.action === 'release' ? 2 : 1;
  spend.record(wp, { employeeId: 'nikhil', source: 'aws', basis: 'estimated', what: `${spec.action} ${release.shippable} ${release.version} (${spec.command.split('/').pop()})`, inr: estimate });
  wp.emit({ type: 'alert', level: code === 0 ? 'info' : 'blocked', title: `${release.shippable} ${release.version} ${code === 0 ? 'released' : 'failed'}`, body: lines.slice(-3).join(' · ') });
  return finished;
}

function save(wp: Workplace, r: Release): void {
  wp.db.prepare('update releases set state = ?, json = ? where id = ?').run(r.state, JSON.stringify(r), r.id);
  wp.emit({ type: 'release.updated', release: r });
}

/** Assignments done for this shippable's platforms and not yet in a done release. */
const SHIPPABLES: Shippable[] = ['desktop-mac', 'desktop-intel', 'windows', 'ios', 'android', 'server-api', 'server-agent', 'website'];

/** Per shippable: what is done and unreleased, the release in flight, the last one done (29 Sep, phone). */
export function readiness(wp: Workplace): ReleaseReadiness[] {
  const all = list(wp);
  return SHIPPABLES.map(shippable => {
    const mine = all.filter(r => r.shippable === shippable);
    const open = mine.find(r => r.state === 'proposed' || r.state === 'approved' || r.state === 'running');
    const last = mine.find(r => r.state === 'done');
    return { shippable, unreleased: unreleasedFor(wp, shippable), ...(open ? { open } : {}), ...(last ? { last } : {}) };
  });
}

export function unreleasedFor(wp: Workplace, shippable: Shippable): string[] {
  const platforms: Record<Shippable, string[]> = {
    'desktop-mac': ['mac'], 'desktop-intel': ['intel', 'mac'], windows: ['windows'], ios: ['ios', 'ipad'], android: ['android'],
    'server-api': ['server'], 'server-agent': ['server'], website: ['web'],
  };
  const releasedAt = list(wp).filter(r => r.shippable === shippable && r.state === 'done').map(r => r.createdAt).sort().at(-1) ?? '';
  return work.list(wp, { kind: 'assignment', state: 'done' })
    .filter(a => a.updatedAt > releasedAt && a.platformIds.some(p => platforms[shippable].includes(p)))
    .map(a => `${a.id} ${a.title}`);
}
