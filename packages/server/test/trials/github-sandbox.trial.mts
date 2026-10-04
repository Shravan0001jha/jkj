/**
 * One real end-to-end run of the GitHub flow against a sandbox repository (never iris, never
 * ~/claude-dev): push, PR, statuses, two approvals, merge on GitHub, branch deleted, and the
 * fast-forward sync into a temp clone. Also checks that a planted key never leaves the Mac.
 *
 *   npx tsx test/trials/github-sandbox.trial.mts            (from packages/server)
 *
 * Uses the real Apps through ~/iris-ops/github/token.py. Prints PR numbers, SHAs and states; never a
 * token. Not part of `npm test` (it talks to GitHub).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { testWorkplace } from '../fakes/workplace.js';
import * as flow from '../../src/services/github-flow.js';
import * as items from '../../src/services/items.js';
import * as work from '../../src/services/work.js';
import { RealGitHub } from '../../src/services/github-port.js';
import { employee } from '../../src/services/employees.js';
import { ensureWorktree } from '../../src/services/worktrees.js';
import { rawGet } from '../../src/services/v2-map.js';

const ORG = 'shravan0001jha-iris-hq';
const REPO = process.env['TRIAL_REPO'] ?? 'iris-sandbox';
const TRUNK = process.env['TRIAL_TRUNK'] ?? 'main';
if (REPO === 'iris') throw new Error('The trial never runs against iris.');
const GH = join(homedir(), 'iris-ops', 'github');

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = ''): void => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { wp, tmp } = testWorkplace({
  WORKPLACE_GITHUB_ORG: ORG, WORKPLACE_GITHUB_REPO: REPO, WORKPLACE_GITHUB_TRUNK: TRUNK,
  WORKPLACE_GITHUB_TOKEN_SCRIPT: join(GH, 'token.py'), WORKPLACE_GITHUB_PYTHON: join(GH, '.venv', 'bin', 'python'),
});
const port = new RealGitHub({ org: ORG, repo: REPO, tokenScript: join(GH, 'token.py'), python: join(GH, '.venv', 'bin', 'python'), pushApp: 'iris-workplace', reviewApp: 'iris-review' });
flow.useGitHub(wp, port);
const clone = mkdtempSync(join(tmpdir(), 'iris-trial-clone-'));
const g = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function api(path: string, slug = 'iris-workplace'): Promise<unknown> {
  const tok = execFileSync(join(GH, '.venv', 'bin', 'python'), [join(GH, 'token.py'), slug], { encoding: 'utf8' }).trim();
  const res = await fetch(`https://api.github.com/repos/${ORG}/${REPO}${path}`, { headers: { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json' } });
  return res.json();
}

try {
  // The trunk checkout: a temp clone of the sandbox, authenticated like the server's own git.
  const auth = await port.gitAuth();
  execFileSync('git', ['clone', '-q', '--branch', TRUNK, auth.url, clone], { env: { ...process.env, ...auth.env }, stdio: 'pipe' });
  g(clone, ['config', 'user.email', 'trial@iris.local']); g(clone, ['config', 'user.name', 'Workplace trial']);
  const kabir = employee(wp, 'kabir');
  kabir.workspace = { ...kabir.workspace, repo: clone, branch: TRUNK };
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'secretScan:\n  command: /opt/homebrew/bin/gitleaks\nareas:\n  trials:\n    paths: [trials/]\n    checks:\n      - name: lint\n        run: test -n "{files}"\n        extensions: [.md]\n');
  flow.setMode(wp, 'on', 'coo');

  const epic = items.create(wp, { level: 'epic', title: 'GitHub flow trial' }, 'owner');
  const mk = (title: string) => items.create(wp, { level: 'story', title, parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const evidence = { tests: { passed: 1, failed: 0, command: 'trial' }, commits: ['x'], liveVerified: [], notVerified: [] };

  // 1. A planted key: refused before anything reaches GitHub.
  const bad = mk('Trial: planted key');
  const badWt = ensureWorktree(wp.config.workDir, kabir, bad.id).path;
  mkdirSync(join(badWt, 'trials'), { recursive: true });
  writeFileSync(join(badWt, 'trials', `${bad.id}.py`), `TOKEN = "${'ghp_' + 'Tr1alK3yN0tR3alAbCdEfGhIjKlMnOpQrStUv'}"\n`);
  g(badWt, ['add', '-A']); g(badWt, ['commit', '-q', '-m', 'trial: planted key']);
  work.reportDone(wp, bad.id, evidence, 'kabir');
  const refused = await flow.onReview(wp, bad.id, 'kabir');
  const badRemote = await api(`/branches/${encodeURIComponent(`emp/kabir/${bad.id}`)}`) as { name?: string };
  check('planted key refused, branch never pushed', !!refused.refused?.length && !badRemote.name, refused.refused?.[0] ?? '');

  // 2. The real path.
  const story = mk('Trial: GitHub flow end to end');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  mkdirSync(join(wt, 'trials'), { recursive: true });
  writeFileSync(join(wt, 'trials', `${story.id}.md`), `# Workplace GitHub flow trial ${new Date().toISOString()}\n`);
  g(wt, ['add', '-A']); g(wt, ['commit', '-q', '-m', `trial: ${story.id}`]);
  const head = g(wt, ['rev-parse', 'HEAD']).trim();
  work.reportDone(wp, story.id, evidence, 'kabir');
  const r = await flow.onReview(wp, story.id, 'kabir');
  check('pushed and PR opened', !!r.pr, r.pr ? `PR #${r.pr.number} ${r.pr.url}` : (r.error ?? r.refused?.join('; ') ?? r.skipped ?? ''));
  await r.tests;
  const pr = rawGet(wp, story.id)!.pr!;
  check('PR number stored on the item', pr.number === r.pr?.number && pr.headSha === head, `#${pr.number} @ ${head.slice(0, 8)}`);
  const ghPr = await api(`/pulls/${pr.number}`) as { base: { ref: string }; head: { ref: string; sha: string }; title: string };
  check('PR targets the trunk from the story branch', ghPr.base.ref === TRUNK && ghPr.head.ref === `emp/kabir/${story.id}` && ghPr.head.sha === head, `${ghPr.head.ref} → ${ghPr.base.ref}`);
  check('workplace/tests green', pr.tests?.state === 'success', pr.tests?.summary ?? '');

  const early = await flow.merge(wp, story.id, 'coo').then(() => 'merged?!', (e: Error) => e.message);
  check('merge refused before approvals', /approval/.test(early), early);
  await flow.approve(wp, story.id, 'dev');
  await flow.approve(wp, story.id, 'nikhil');
  // Newest first: the first one per context is its current state.
  const list = await api(`/commits/${head}/statuses`, 'iris-review') as { context: string; state: string; creator?: { login: string } }[];
  const by = (c: string) => list.find(s => s.context === c);
  const contexts = ['workplace/review', 'workplace/tests', 'workplace/evidence'];
  check('statuses posted by iris-review', by('workplace/review')?.state === 'success' && by('workplace/tests')?.state === 'success' && by('workplace/evidence')?.state === 'pending'
    && contexts.every(c => /iris-review/.test(by(c)?.creator?.login ?? '')),
    contexts.map(c => `${c}=${by(c)?.state} (${by(c)?.creator?.login})`).join(', '));

  const before = g(clone, ['rev-parse', 'HEAD']).trim();
  const m = await flow.merge(wp, story.id, 'coo');
  check('merged on GitHub', m.merged, m.sha ?? '');
  const after = await api(`/pulls/${pr.number}`) as { merged: boolean; merge_commit_sha: string };
  check('GitHub says merged', after.merged === true, after.merge_commit_sha);
  const gone = await api(`/branches/${encodeURIComponent(`emp/kabir/${story.id}`)}`) as { name?: string };
  check('story branch deleted', !gone.name);
  const local = g(clone, ['rev-parse', 'HEAD']).trim();
  check('temp clone fast-forwarded to the merge', m.synced === true && local !== before && local === after.merge_commit_sha, `${before.slice(0, 8)} → ${local.slice(0, 8)}`);
  check('mode still on (no fallback)', flow.mode(wp) === 'on');
} catch (err) {
  check('trial ran', false, err instanceof Error ? err.message : String(err));
} finally {
  await flow.settled();
  tmp.cleanup();
  rmSync(clone, { recursive: true, force: true });
  const failed = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
