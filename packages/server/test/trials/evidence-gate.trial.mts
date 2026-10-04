/**
 * The real gate for run_evidence (docs/LLD-evidence.md §8): a throwaway story branch in a temp clone
 * of the Iris repo (never ~/claude-dev itself), the Android app built at that commit with the real
 * builder (gradle, pointed at staging), staging started if it is down, and the real robot runner on
 * slot 1 against staging. Prints the phases with their times and the run's summary; never a secret.
 *
 *   GATE_FEATURES=queries npx tsx test/trials/evidence-gate.trial.mts      (from packages/server)
 *
 * GATE_FEATURES is a comma list of runs, one per entry separated by ';' (e.g. "setup;queries": the
 * second reuses the first's build). GATE_KEEP=<dir> keeps the evidence there. Not part of `npm test`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { testWorkplace } from '../fakes/workplace.js';
import * as evidence from '../../src/services/evidence.js';
import * as items from '../../src/services/items.js';
import { employee } from '../../src/services/employees.js';
import { rawGet } from '../../src/services/v2-map.js';

const SOURCE = join(homedir(), 'claude-dev');
const TRUNK = 'feat/iris-character';
const keep = process.env['GATE_KEEP'] ?? join(tmpdir(), `iris-evidence-gate-${Date.now()}`);
mkdirSync(keep, { recursive: true });
const clone = join(keep, 'iris-clone');
const g = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const t0 = Date.now();
const at = (): string => `${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s`;

const { wp, tmp } = testWorkplace({ WORKPLACE_EVIDENCE_DIR: join(keep, 'evidence') });
try {
  if (!existsSync(clone)) execFileSync('git', ['clone', '-q', '--branch', TRUNK, SOURCE, clone], { stdio: 'pipe' });
  g(clone, ['config', 'user.email', 'gate@iris.local']); g(clone, ['config', 'user.name', 'Evidence gate']);
  const kabir = employee(wp, 'kabir');
  kabir.workspace = { ...kabir.workspace, repo: clone, branch: TRUNK };

  const epic = items.create(wp, { level: 'epic', title: 'Evidence gate' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Evidence gate: throwaway story', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const branch = `emp/kabir/${story.id}`;
  // An app change, so Android is built at the story's own commit (not the trunk's cached build).
  g(clone, ['checkout', '-q', '-b', branch, TRUNK]);
  const kt = join(clone, 'mobile/android/app/src/main/java/com/irisforu/iris/net/Api.kt');
  appendFileSync(kt, '\n// evidence gate: throwaway story commit\n');
  g(clone, ['commit', '-q', '-am', 'Evidence gate: throwaway app change']);
  const head = g(clone, ['rev-parse', 'HEAD']).trim();
  g(clone, ['checkout', '-q', TRUNK]);
  console.log(`${at()}  story ${story.id} on ${branch} @ ${head.slice(0, 8)} (clone ${clone})`);
  console.log(`${at()}  staging health before: ${await fetch(`${wp.config.evidence.stagingUrl}/healthz`, { signal: AbortSignal.timeout(5000) }).then(r => r.status, () => 'down')}`);

  for (const features of (process.env['GATE_FEATURES'] ?? 'queries').split(';').map(s => s.trim()).filter(Boolean)) {
    const r = evidence.request(wp, { itemId: story.id, by: 'kabir', platforms: 'android', features });
    console.log(`${at()}  run_evidence android / ${features}: ${r.message}`);
    if (!r.ok) continue;
    let last = '';
    const timer = setInterval(() => {
      const j = evidence.state(wp).slots.find(s => s.job)?.job;
      const phase = j ? `${j.state}${j.phase ? ` (${j.phase})` : ''}` : 'idle';
      if (phase !== last) { console.log(`${at()}  ${phase}`); last = phase; }
    }, 1000);
    await evidence.settled(wp);
    clearInterval(timer);
    const rec = rawGet(wp, story.id)!.evidenceRun!;
    console.log(`${at()}  result: ${rec.state} — ${rec.passed} passed, ${rec.failed} failed, ${rec.durationS} s${rec.note ? ` — ${rec.note}` : ''}`);
    const runDir = join(wp.config.evidence.dir, story.id, rec.run);
    if (existsSync(join(runDir, 'summary.txt'))) console.log(readFileSync(join(runDir, 'summary.txt'), 'utf8'));
    console.log(`run dir: ${runDir}`);
  }
  const builds = join(wp.config.evidence.dir, '_builds', 'android');
  for (const d of existsSync(builds) ? readdirSync(builds) : []) {
    try { const m = JSON.parse(readFileSync(join(builds, d, 'build.json'), 'utf8')) as { source: string; ms: number }; console.log(`build ${d}: source ${m.source.slice(0, 8)}, ${Math.round(m.ms / 1000)} s`); } catch { /* not a build */ }
  }
} finally {
  evidence.stopAll(wp);
  // The slot checkout is a worktree of the clone: drop it from the clone, keep the evidence.
  try { g(clone, ['worktree', 'prune']); } catch { /* none */ }
  tmp.cleanup();
}
