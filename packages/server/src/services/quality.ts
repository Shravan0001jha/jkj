import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The security guards the server runs on every push (checkpoint 10; docs/LLD-github-flow.md §5).
 *
 * Three guards judge only what a branch adds or changes since the trunk (the trunk already tracks old
 * build output; that never blocks a story): build output (`dist-*` and friends), leaked secrets
 * (gitleaks over the branch's commits, so a key added and deleted again is still caught), and a
 * file-size limit. They are the push gate: nothing they refuse ever reaches GitHub.
 *
 * The test suites are not run here any more (owner, 4 Oct): the author runs `scripts/pre-pr.sh` on
 * their commit and `workplace/tests` reports its results (pre-pr.ts). An `areas` key in quality.yaml
 * is ignored.
 */

export interface QualityConfig {
  maxFileBytes: number;
  buildOutput: RegExp[];
  secretScan: { command: string; config?: string };
}

export const DEFAULT_BUILD_OUTPUT = [
  '(^|/)dist-[^/]*(/|$)',
  '(^|/)node_modules/',
  '(^|/)__pycache__/',
  '\\.pyc$',
  '\\.(dmg|ipa|apk|aab)$',
];
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export function parseConfig(text: string): QualityConfig {
  const raw = (text.trim() ? parse(text) : {}) as Record<string, unknown> | null ?? {};
  const max = Number(raw['maxFileBytes']);
  const patterns = Array.isArray(raw['buildOutput']) ? (raw['buildOutput'] as unknown[]).map(String) : DEFAULT_BUILD_OUTPUT;
  const scan = (raw['secretScan'] ?? {}) as Record<string, unknown>;
  return {
    maxFileBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_FILE_BYTES,
    buildOutput: patterns.map(p => new RegExp(p)),
    secretScan: {
      command: typeof scan['command'] === 'string' && scan['command'].trim() ? scan['command'].trim() : 'gitleaks',
      ...(typeof scan['config'] === 'string' && scan['config'].trim() ? { config: scan['config'].trim() } : {}),
    },
  };
}

/** `<workplaceDir>/quality.yaml`, or the defaults when there is none. */
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
    .map(f => `build output: ${f} is build output (dist-* and the like are never committed); delete it on your branch and commit`);
}

export function fileSizeProblems(repo: string, base: string, head: string, cfg: QualityConfig): string[] {
  const files = changes(repo, base, head);
  if (!files.length) return [];
  const sha = git(repo, ['rev-parse', head]).trim();
  const lines = git(repo, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], files.map(f => `${sha}:${f}`).join('\n') + '\n').split('\n');
  const out: string[] = [];
  files.forEach((f, i) => {
    const [type, size] = (lines[i] ?? '').split(' ');
    if (type === 'blob' && Number(size) > cfg.maxFileBytes) out.push(`file size: ${f} is ${Number(size)} bytes, over the ${cfg.maxFileBytes}-byte limit; delete it on your branch and commit`);
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
    if (code !== 7) return [`secret scan could not run (${e.code === 'ENOENT' ? `${cfg.secretScan.command} is not installed` : `exit ${code}`}); nothing is pushed until it can, so escalate to the COO`];
  }
  if (code === 0) return [];
  let findings: { RuleID?: string; File?: string; StartLine?: number; Commit?: string }[] = [];
  try { findings = JSON.parse(stdout || '[]'); } catch { return ['secret scan could not run (its report was unreadable); escalate to the COO']; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of findings) {
    const line = `leaked secret: ${f.RuleID ?? 'secret'} in ${f.File ?? '?'}:${f.StartLine ?? '?'} (commit ${(f.Commit ?? '').slice(0, 8)}); escalate to the COO now, because the key must be rotated and the commit removed from your branch history, which only the COO can do`;
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  return out.length ? out : ['leaked secret: the scan reported a leak; escalate to the COO now'];
}

/** Every guard, all reported (not the first only): the push gate and the first step of a run. */
export function guardProblems(repo: string, base: string, head: string, cfg: QualityConfig): string[] {
  return [...buildOutputProblems(repo, base, head, cfg), ...fileSizeProblems(repo, base, head, cfg), ...secretProblems(repo, base, head, cfg)];
}
