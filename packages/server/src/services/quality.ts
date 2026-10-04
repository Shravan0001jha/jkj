import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { log } from '../util/logger.js';

/**
 * The quality checks the Mac runs for `workplace/tests` (checkpoint 10; docs/LLD-github-flow.md §5).
 *
 * Three guards judge only what a branch adds or changes since the trunk (the trunk already tracks old
 * build output; that never blocks a story): build output (`dist-*` and friends), leaked secrets
 * (gitleaks over the branch's commits, so a key added and deleted again is still caught), and a
 * file-size limit. The guards are also the push gate: nothing they refuse ever reaches GitHub.
 * Then each touched area's commands from `quality.yaml` run in the worktree, one run at a time.
 */

export interface QualityCheck { name: string; run: string; extensions?: string[]; timeoutSec: number }
export interface QualityArea { id: string; paths: string[]; checks: QualityCheck[] }
export interface QualityConfig {
  maxFileBytes: number;
  buildOutput: RegExp[];
  secretScan: { command: string; config?: string };
  areas: QualityArea[];
}

export interface QualityResult {
  state: 'success' | 'failure' | 'error';
  summary: string;
  details?: string;
}

export const DEFAULT_BUILD_OUTPUT = [
  '(^|/)dist-[^/]*(/|$)',
  '(^|/)node_modules/',
  '(^|/)__pycache__/',
  '\\.pyc$',
  '\\.(dmg|ipa|apk|aab)$',
];
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 600;
const OUTPUT_TAIL = 3000;

export function parseConfig(text: string): QualityConfig {
  const raw = (text.trim() ? parse(text) : {}) as Record<string, unknown> | null ?? {};
  const max = Number(raw['maxFileBytes']);
  const patterns = Array.isArray(raw['buildOutput']) ? (raw['buildOutput'] as unknown[]).map(String) : DEFAULT_BUILD_OUTPUT;
  const scan = (raw['secretScan'] ?? {}) as Record<string, unknown>;
  const areas: QualityArea[] = [];
  for (const [id, value] of Object.entries((raw['areas'] ?? {}) as Record<string, Record<string, unknown>>)) {
    const paths = Array.isArray(value?.['paths']) ? (value['paths'] as unknown[]).map(String) : [];
    const checks = (Array.isArray(value?.['checks']) ? value['checks'] as Record<string, unknown>[] : []).map((c, i) => {
      if (typeof c?.['run'] !== 'string' || !c['run'].trim()) throw new Error(`quality.yaml: areas.${id}.checks[${i}] needs a "run" command`);
      const t = Number(c['timeoutSec']);
      return {
        name: typeof c['name'] === 'string' && c['name'].trim() ? c['name'].trim() : `check ${i + 1}`,
        run: c['run'],
        ...(Array.isArray(c['extensions']) ? { extensions: (c['extensions'] as unknown[]).map(String) } : {}),
        timeoutSec: Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_SEC,
      };
    });
    areas.push({ id, paths, checks });
  }
  return {
    maxFileBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_FILE_BYTES,
    buildOutput: patterns.map(p => new RegExp(p)),
    secretScan: {
      command: typeof scan['command'] === 'string' && scan['command'].trim() ? scan['command'].trim() : 'gitleaks',
      ...(typeof scan['config'] === 'string' && scan['config'].trim() ? { config: scan['config'].trim() } : {}),
    },
    areas,
  };
}

/** `<workplaceDir>/quality.yaml`, or the defaults (guards only, no area commands) when there is none. */
export function loadConfig(workplaceDir: string): QualityConfig {
  const path = join(workplaceDir, 'quality.yaml');
  return parseConfig(existsSync(path) ? readFileSync(path, 'utf8') : '');
}

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });

/** Files the branch adds or changes since it left the trunk (deletions excluded). */
export function changes(repo: string, base: string, head: string): string[] {
  const out = git(repo, ['diff', '--name-status', '--no-renames', '-z', `${base}...${head}`]);
  const parts = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (!parts[i]!.startsWith('D')) files.push(parts[i + 1]!);
  return files;
}

export function buildOutputProblems(repo: string, base: string, head: string, cfg: QualityConfig): string[] {
  return changes(repo, base, head)
    .filter(f => cfg.buildOutput.some(p => p.test(f)))
    .map(f => `build output: ${f} (never commit dist-* or other build output; remove it from the branch)`);
}

export function fileSizeProblems(repo: string, base: string, head: string, cfg: QualityConfig): string[] {
  const files = changes(repo, base, head);
  if (!files.length) return [];
  const sha = git(repo, ['rev-parse', head]).trim();
  const lines = git(repo, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], files.map(f => `${sha}:${f}`).join('\n') + '\n').split('\n');
  const out: string[] = [];
  files.forEach((f, i) => {
    const [type, size] = (lines[i] ?? '').split(' ');
    if (type === 'blob' && Number(size) > cfg.maxFileBytes) out.push(`file size: ${f} is ${Number(size)} bytes (limit ${cfg.maxFileBytes})`);
  });
  return out;
}

/**
 * gitleaks over the branch's commits (`base..head`), redacted. A finding is reported as its rule and
 * place only, never the match. A scanner that is missing or errors refuses: it fails closed.
 */
export function secretProblems(repo: string, base: string, head: string, cfg: QualityConfig): string[] {
  const args = ['git', repo, `--log-opts=${base}..${head}`, '--redact', '--no-banner', '--no-color', '--log-level', 'error',
    '--report-format', 'json', '--report-path', '-', '--exit-code', '7', ...(cfg.secretScan.config ? ['--config', cfg.secretScan.config] : [])];
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(cfg.secretScan.command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; code?: string };
    code = e.status ?? -1;
    stdout = e.stdout ?? '';
    if (code !== 7) return [`secret scan could not run (${e.code === 'ENOENT' ? `${cfg.secretScan.command} is not installed: brew install gitleaks` : `exit ${code}`}); refused until it can`];
  }
  if (code === 0) return [];
  let findings: { RuleID?: string; File?: string; StartLine?: number; Commit?: string }[] = [];
  try { findings = JSON.parse(stdout || '[]'); } catch { return ['secret scan: findings could not be read; refused']; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of findings) {
    const line = `secret: ${f.RuleID ?? 'secret'} in ${f.File ?? '?'}:${f.StartLine ?? '?'} (commit ${(f.Commit ?? '').slice(0, 8)}); remove it from the branch history and rotate it`;
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  return out.length ? out : ['secret scan reported a leak; refused'];
}

/** Every guard, all reported (not the first only): the push gate and the first step of a run. */
export function guardProblems(repo: string, base: string, head: string, cfg: QualityConfig): string[] {
  return [...buildOutputProblems(repo, base, head, cfg), ...fileSizeProblems(repo, base, head, cfg), ...secretProblems(repo, base, head, cfg)];
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function runCommand(cwd: string, command: string, env: Record<string, string>, timeoutSec: number): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise(resolve => {
    // Its own process group, so a time-out kills the whole command, not just the shell.
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const take = (b: Buffer): void => { output = (output + b.toString()).slice(-OUTPUT_TAIL * 2); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = (signal: NodeJS.Signals): void => { try { process.kill(-child.pid!, signal); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 2000).unref(); }, timeoutSec * 1000);
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, output: String(err), timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, output: output.slice(-OUTPUT_TAIL), timedOut }); });
  });
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * One run at a time on this Mac (heavy builds are capped): runs queue behind each other. `prepare`
 * (putting a checkout on the head) runs inside the queue, so two runs never share a checkout.
 */
export function run(worktree: string, base: string, head: string, cfg: QualityConfig, prepare?: () => void): Promise<QualityResult> {
  const next = queue.then(async (): Promise<QualityResult> => {
    try { prepare?.(); } catch (err) { return { state: 'error', summary: `checks not run: could not prepare the checkout (${err instanceof Error ? err.message.split('\n')[0] : err})` }; }
    return runNow(worktree, base, head, cfg);
  });
  queue = next.catch(() => undefined);
  return next;
}

async function runNow(worktree: string, base: string, head: string, cfg: QualityConfig): Promise<QualityResult> {
  let sha: string;
  try {
    sha = git(worktree, ['rev-parse', head]).trim();
    const at = git(worktree, ['rev-parse', 'HEAD']).trim();
    if (at !== sha) return { state: 'error', summary: `the worktree is not at ${sha.slice(0, 8)} (it is at ${at.slice(0, 8)}); checks not run` };
  } catch (err) {
    return { state: 'error', summary: `checks not run: ${err instanceof Error ? err.message.split('\n')[0] : err}` };
  }
  const guards = guardProblems(worktree, base, sha, cfg);
  if (guards.length) {
    const kinds = [...new Set(guards.map(g => g.split(':')[0]))].join(', ');
    return { state: 'failure', summary: `refused: ${kinds}`, details: guards.join('\n') };
  }
  const changed = changes(worktree, base, sha);
  const passed: string[] = [];
  const failed: string[] = [];
  const details: string[] = [];
  for (const area of cfg.areas) {
    const mine = changed.filter(f => area.paths.some(p => f.startsWith(p)));
    if (!mine.length) continue;
    for (const check of area.checks) {
      const files = check.extensions ? mine.filter(f => check.extensions!.some(e => f.endsWith(e))) : mine;
      const label = `${area.id} ${check.name}`;
      if (check.run.includes('{files}') && !files.length) { details.push(`${label}: skipped (no matching files)`); continue; }
      const command = check.run.split('{files}').join(files.map(shellQuote).join(' '));
      const started = Date.now();
      const r = await runCommand(worktree, command, { CHANGED_FILES: files.join('\n'), QUALITY_AREA: area.id }, check.timeoutSec);
      const secs = Math.round((Date.now() - started) / 1000);
      if (r.ok) { passed.push(label); details.push(`${label}: passed (${secs}s)`); }
      else {
        failed.push(label);
        details.push(`${label}: ${r.timedOut ? `timed out after ${check.timeoutSec}s` : 'failed'} (${secs}s)\n${r.output.trim()}`);
      }
    }
  }
  log.info('quality', `${sha.slice(0, 8)}: ${failed.length ? `failed ${failed.join(', ')}` : `green (${passed.join(', ') || 'guards only'})`}`);
  if (failed.length) return { state: 'failure', summary: `failed: ${failed.join(', ')}`, details: details.join('\n') };
  return { state: 'success', summary: `green: guards${passed.length ? `, ${passed.join(', ')}` : ''}`, details: details.join('\n') };
}
