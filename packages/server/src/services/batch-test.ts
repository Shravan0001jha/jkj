import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Workplace } from './workplace.js';
import * as coo from './coo.js';
import * as trail from './trail.js';
import * as githubFlow from './github-flow.js';
import * as evidence from './evidence.js';
import { rawGet } from './v2-map.js';
import { isCto, isQa } from './review-policy.js';
import * as items from './items.js';
import { log } from '../util/logger.js';

/**
 * Batched pre-merge testing + fast lane (owner, 4 Nov; docs/HLD-batched-testing.md, LLD-batched-testing.md).
 * Android run_evidence requests queue here; when 10 are queued or the oldest waited 60 min (240 at the
 * month's batch cap), one combined build (trunk + every queued PR head) gets ONE robot run through the
 * evidence engine, and each PR gets its own verdict. Vikram (CTO) may spend from a ₹1,000/month fast lane
 * to run one request at once.
 */

export interface BatchRequest { itemId: string; headSha: string; by: string; features: string[]; at: string; attempt: number; fast?: true;
  /** The request tests what the model itself decides: the batch then runs on the default (real) model. */
  modelChoice?: true }
export interface Batch {
  id: string; at: string; requests: BatchRequest[]; dropped: { itemId: string; why: string }[];
  branch?: string; sha?: string; jobId?: string; fast?: true;
  /** The batch's QA story (one per staging deploy, owner 4 Nov). */
  qaStoryId?: string;
  robotModel?: RobotModel;
  /** A split rerun (at most once): the original claimants of an ambiguous failure, and the one left out. */
  split?: { claimants: string[]; suspect: string; failures: string[] };
}
export interface BatchResult { state: 'success' | 'failure' | 'error'; failures: string[]; durationS: number; report: string; note?: string }
export type RobotModel = 'cheap' | 'default';
export interface EnqueueSpec { batchId: string; branch: string; sha: string; features: string[]; by: string; robotModel: RobotModel }
export interface Assembled { branch: string; sha: string; dropped: { itemId: string; why: string }[] }

export interface Deps {
  /** The story's current PR head, or null when it has no open PR. */
  headOf(itemId: string): string | null;
  isCto(by: string): boolean;
  assemble(requests: BatchRequest[], batchId: string): Promise<Assembled>;
  /** Queues the one evidence job for the combined commit; returns its job id. */
  enqueue(spec: EnqueueSpec): string;
  /** The per-PR verdict: workplace/evidence on the PR, a comment, then the usual auto-merge. */
  verdict(itemId: string, state: 'success' | 'failure', note: string): Promise<void>;
  alert(text: string): void;
  onHold(): boolean;
  /** Files the batch's QA story (what the deploy carries, what to check); returns its id. */
  qaStory(batch: Batch): string | null;
}

export const BATCH_SIZE = 10;
export const WAIT_MIN = 60;
export const WAIT_AT_CAP_MIN = 240;
export const BATCH_CAP_INR = 3000;
export const FAST_CAP_INR = 1000;
const FAST_EST_INR = 25;
/** Where batch QA stories go (the staging QA epic the 06/14 UTC batch uses); setting batch-test:qa-epic overrides. */
const QA_EPIC_DEFAULT = 'ft_mux2bymofcokx';

const K_QUEUE = 'batch-test:queue';
const K_CURRENT = 'batch-test:current';
const K_MODE = 'batch-test:mode';
const kSpend = (nowMs: number): string => `batch-test:spend:${new Date(nowMs).toISOString().slice(0, 7)}`;

const get = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const put = (wp: Workplace, key: string, value: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
const drop = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);
const readJson = <T>(wp: Workplace, key: string, fallback: T): T => { try { const v = get(wp, key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };

/* ---------- pure ---------- */

/** "android reminder.complete.nomac FAIL ..." -> "reminder"; null when the line names no case. */
export function featureOf(failure: string): string | null {
  const m = /^(?:android|ios|mac|windows)\s+([a-z][a-z0-9_-]*)[.\s]/i.exec(failure.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export interface Verdicts { pass: string[]; fail: Record<string, string[]>; ambiguous: { feature: string; claimants: string[]; failures: string[] }[]; orphan: string[] }

export function verdicts(requests: BatchRequest[], failures: string[], state: 'success' | 'failure'): Verdicts {
  const out: Verdicts = { pass: [], fail: {}, ambiguous: [], orphan: [] };
  const byFeature = new Map<string, string[]>();
  for (const f of state === 'success' ? [] : failures) {
    const feat = featureOf(f);
    if (!feat) continue;
    const claimants = requests.filter(r => r.features.includes(feat)).map(r => r.itemId);
    if (claimants.length === 0) { out.orphan.push(f); continue; }
    if (claimants.length === 1) { (out.fail[claimants[0]!] ??= []).push(f); continue; }
    byFeature.set(feat, [...(byFeature.get(feat) ?? []), f]);
  }
  for (const [feature, fs] of byFeature) out.ambiguous.push({ feature, claimants: requests.filter(r => r.features.includes(feature)).map(r => r.itemId), failures: fs });
  const blocked = new Set([...Object.keys(out.fail), ...out.ambiguous.flatMap(a => a.claimants)]);
  out.pass = requests.map(r => r.itemId).filter(id => !blocked.has(id));
  return out;
}

export function due(queue: BatchRequest[], nowMs: number, capReached: boolean): boolean {
  if (!queue.length) return false;
  if (queue.some(r => r.fast)) return true;
  if (queue.length >= BATCH_SIZE) return true;
  const oldest = Math.min(...queue.map(r => Date.parse(r.at)));
  return nowMs - oldest >= (capReached ? WAIT_AT_CAP_MIN : WAIT_MIN) * 60_000;
}

/** Features whose rows check what the model decides (owner, 4 Nov: these keep the real model). */
export const MODEL_CHOICE_FEATURES: ReadonlySet<string> = new Set(['phoneasks']);

/** Robot runs use the cheaper model unless some request tests the model's own choices. */
export function modelFor(requests: BatchRequest[]): RobotModel {
  return requests.some(r => r.modelChoice || r.features.some(f => MODEL_CHOICE_FEATURES.has(f))) ? 'default' : 'cheap';
}

/** Linux runner minutes ($0.006 ≈ ₹0.5) plus about ₹15 of staging model turns. */
export const estimateInr = (durationS: number): number => Math.ceil(durationS / 60 * 0.5 + 15);

/* ---------- state ---------- */

export const queue = (wp: Workplace): BatchRequest[] => readJson<BatchRequest[]>(wp, K_QUEUE, []);
const saveQueue = (wp: Workplace, q: BatchRequest[]): void => put(wp, K_QUEUE, JSON.stringify(q));
const current = (wp: Workplace): Batch | null => readJson<Batch | null>(wp, K_CURRENT, null);
const saveCurrent = (wp: Workplace, b: Batch | null): void => { if (b) put(wp, K_CURRENT, JSON.stringify(b)); else drop(wp, K_CURRENT); };

export const mode = (wp: Workplace): 'on' | 'off' => (get(wp, K_MODE) === 'off' ? 'off' : 'on');
export function setMode(wp: Workplace, m: 'on' | 'off'): void { put(wp, K_MODE, m); }

export const spend = (wp: Workplace, nowMs = Date.now()): { batchInr: number; fastInr: number } => readJson(wp, kSpend(nowMs), { batchInr: 0, fastInr: 0 });
export function addSpend(wp: Workplace, lane: 'batch' | 'fast', inr: number, nowMs = Date.now()): void {
  const s = spend(wp, nowMs);
  if (lane === 'fast') s.fastInr += inr; else s.batchInr += inr;
  put(wp, kSpend(nowMs), JSON.stringify(s));
}

export function state(wp: Workplace, nowMs = Date.now()): { mode: 'on' | 'off'; queue: BatchRequest[]; current: Batch | null; spend: { batchInr: number; fastInr: number }; caps: { batchInr: number; fastInr: number } } {
  return { mode: mode(wp), queue: queue(wp), current: current(wp), spend: spend(wp, nowMs), caps: { batchInr: BATCH_CAP_INR, fastInr: FAST_CAP_INR } };
}

/** run_evidence goes to the batch: mode on, Android only, not a release gate, not the fast lane's own path. */
export function routes(wp: Workplace, r: { platforms: string; releaseGate: boolean; fast: boolean }): boolean {
  if (mode(wp) !== 'on' || r.releaseGate) return false;
  const ps = r.platforms.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return ps.length > 0 && ps.every(p => p === 'android');
}

/* ---------- effects ---------- */

export function request(wp: Workplace, spec: { itemId: string; by: string; features: string[]; fast?: boolean; modelChoice?: boolean }, deps: Deps = realDeps(wp), nowMs = Date.now()): { ok: boolean; message: string; position?: number } {
  const features = spec.features.map(f => f.trim()).filter(Boolean);
  if (!features.length) return { ok: false, message: 'Name the features your change touches (for example reminder, calendar), then call run_evidence again.' };
  const head = deps.headOf(spec.itemId);
  if (!head) return { ok: false, message: `${spec.itemId} has no open pull request yet: submit with report_done first, then ask for the test.` };
  if (spec.fast) {
    if (!deps.isCto(spec.by)) return { ok: false, message: 'The fast lane is the CTO\'s call (owner, 4 Nov): ask Vikram, or drop fast and join the batch.' };
    const s = spend(wp, nowMs);
    if (s.fastInr + FAST_EST_INR > FAST_CAP_INR) return { ok: false, message: `The fast lane's ₹1,000 for this month is spent (₹${s.fastInr} used). The request can still join the batch.` };
  }
  const q = queue(wp);
  const i = q.findIndex(r => r.itemId === spec.itemId);
  const entry: BatchRequest = { itemId: spec.itemId, headSha: head, by: spec.by, features, at: i >= 0 ? q[i]!.at : new Date(nowMs).toISOString(), attempt: i >= 0 ? q[i]!.attempt : 1, ...(spec.fast ? { fast: true as const } : {}), ...(spec.modelChoice ? { modelChoice: true as const } : {}) };
  if (i >= 0) q[i] = entry; else q.push(entry);
  saveQueue(wp, q);
  const position = (i >= 0 ? i : q.length - 1) + 1;
  const when = spec.fast ? 'it runs now (fast lane)' : `the batch runs when ${BATCH_SIZE} are queued or the oldest has waited ${WAIT_MIN} min`;
  return { ok: true, position, message: `Queued for the next batch test (position ${position} of ${q.length}); ${when}. The verdict lands on your PR; it merges itself if it passes.` };
}

export async function tick(wp: Workplace, nowMs = Date.now(), deps: Deps = realDeps(wp)): Promise<Batch | null> {
  if (current(wp) || deps.onHold()) return null;
  const q = queue(wp);
  if (!due(q, nowMs, spend(wp, nowMs).batchInr >= BATCH_CAP_INR)) return null;
  const fast = q.find(r => r.fast);
  const take = fast ? [fast] : [...q].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (b.attempt - a.attempt)).slice(0, BATCH_SIZE);
  // Front-of-queue order is the queue's own order (a re-queued request sits first).
  const picked = q.filter(r => take.includes(r));
  saveQueue(wp, q.filter(r => !picked.includes(r)));
  return start(wp, picked, nowMs, deps, fast ? { fast: true } : {});
}

async function start(wp: Workplace, requests: BatchRequest[], nowMs: number, deps: Deps, extra: Partial<Batch>): Promise<Batch | null> {
  const id = randomBytes(5).toString('hex');
  let asm: Assembled;
  try { asm = await deps.assemble(requests, id); }
  catch (err) {
    deps.alert(`Batch test ${id} could not assemble its build: ${err instanceof Error ? err.message : String(err)}. Requests re-queued.`);
    saveQueue(wp, [...requests, ...queue(wp)]);
    return null;
  }
  const kept = requests.filter(r => !asm.dropped.some(d => d.itemId === r.itemId));
  for (const d of asm.dropped) deps.alert(`Batch test ${id}: ${d.itemId} dropped (${d.why}); its author resolves it against the trunk and asks again.`);
  if (!kept.length) return null;
  const features = [...new Set(kept.flatMap(r => r.features))];
  const robotModel = modelFor(kept);
  const batch: Batch = { id, at: new Date(nowMs).toISOString(), requests: kept, dropped: asm.dropped, branch: asm.branch, sha: asm.sha, robotModel, ...extra };
  batch.jobId = deps.enqueue({ batchId: id, branch: asm.branch, sha: asm.sha, features, by: 'workplace', robotModel });
  try { const qa = deps.qaStory(batch); if (qa) batch.qaStoryId = qa; } catch (err) { log.warn('batch-test', `${id}: QA story not filed: ${err instanceof Error ? err.message : String(err)}`); }
  saveCurrent(wp, batch);
  try { wp.emit({ type: 'batch.started', id, itemIds: kept.map(r => r.itemId), sha: asm.sha }); } catch { /* events are best effort */ }
  return batch;
}

export async function onResult(wp: Workplace, batchId: string, res: BatchResult, deps: Deps = realDeps(wp), nowMs = Date.now()): Promise<void> {
  const b = current(wp);
  if (!b || b.id !== batchId) { log.warn('batch-test', `result for ${batchId}, which is not the current batch`); return; }
  saveCurrent(wp, null);
  if (res.state !== 'error') addSpend(wp, b.fast ? 'fast' : 'batch', estimateInr(res.durationS), nowMs);

  if (res.state === 'error') {
    const again = b.requests.filter(r => r.attempt < 2).map(r => ({ ...r, attempt: r.attempt + 1 }));
    const twice = b.requests.filter(r => r.attempt >= 2);
    if (twice.length) deps.alert(`Batch test ${b.id} could not run twice (${res.note ?? 'unknown'}): ${twice.map(r => r.itemId).join(', ')} dropped from the queue; their authors ask again once it is fixed.`);
    saveQueue(wp, [...again, ...queue(wp)]);
    return;
  }

  const moved = (r: BatchRequest): boolean => deps.headOf(r.itemId) !== r.headSha;
  const give = async (id: string, state: 'success' | 'failure', fs: string[]): Promise<void> => {
    const r = b.requests.find(x => x.itemId === id) ?? { itemId: id, headSha: '', by: '', features: [], at: '', attempt: 1 };
    if (r.headSha && moved(r)) { saveQueue(wp, [...queue(wp), { ...r, headSha: deps.headOf(id) ?? r.headSha, at: new Date(nowMs).toISOString() }]); return; }
    const note = `Batch test ${b.id} on ${b.sha?.slice(0, 8) ?? '?'} (${b.requests.length + (b.split ? 1 : 0)} PRs): ${state === 'success' ? 'passed' : `failed: ${fs.slice(0, 5).join('; ')}`}. Report: ${res.report}`;
    await deps.verdict(id, state, note);
  };

  if (b.split) {
    // The split ran without the suspect: a pass blames the suspect; a repeat failure fails every claimant.
    const left = b.requests.map(r => r.itemId);
    if (res.state === 'success') {
      for (const id of left) await give(id, 'success', []);
      await give(b.split.suspect, 'failure', b.split.failures);
    } else {
      const fs = res.failures.length ? res.failures : b.split.failures;
      for (const id of b.split.claimants) await give(id, 'failure', fs);
    }
    finished(wp, b);
    return;
  }

  const v = verdicts(b.requests, res.failures, res.state);
  for (const id of v.pass) await give(id, 'success', []);
  for (const [id, fs] of Object.entries(v.fail)) await give(id, 'failure', fs);
  if (v.orphan.length) deps.alert(`Batch test ${b.id}: failures in features no queued PR declared (a trunk problem?): ${v.orphan.slice(0, 5).join('; ')}`);
  const amb = v.ambiguous[0];
  if (amb) {
    // Split once: rerun the claimants without the most recently queued one.
    const claimants = b.requests.filter(r => amb.claimants.includes(r.itemId));
    const suspect = [...claimants].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))[claimants.length - 1]!;
    const rest = claimants.filter(r => r !== suspect);
    // Further ambiguous groups (rare) fail back now, with their shared failures.
    for (const other of v.ambiguous.slice(1)) for (const id of other.claimants) await give(id, 'failure', other.failures);
    await start(wp, rest, nowMs, deps, { split: { claimants: amb.claimants, suspect: suspect.itemId, failures: amb.failures }, ...(b.fast ? { fast: true as const } : {}) });
  }
  finished(wp, b);
}

function finished(wp: Workplace, b: Batch): void {
  try { wp.emit({ type: 'batch.finished', id: b.id }); } catch { /* best effort */ }
}

/* ---------- real ports ---------- */

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** trunk + each PR head merged in order, in a scratch worktree; a conflicting PR is aborted and dropped. */
export function gitAssemble(repo: string, trunk: string, requests: BatchRequest[], batchId: string): Assembled {
  const branch = `batch/${batchId}`;
  const wt = join(dirname(repo), `.batch-wt-${batchId}`);
  if (!existsSync(dirname(wt))) mkdirSync(dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '-f', '-B', branch, wt, trunk]);
  const dropped: Assembled['dropped'] = [];
  try {
    for (const r of requests) {
      try { git(wt, ['-c', 'user.name=Iris Workplace', '-c', 'user.email=workplace@irisforu.com', 'merge', '--no-ff', '--no-edit', '-m', `batch ${batchId}: ${r.itemId}`, r.headSha]); }
      catch {
        let files = '';
        try { files = git(wt, ['diff', '--name-only', '--diff-filter=U']).trim().split('\n').filter(Boolean).slice(0, 5).join(', '); } catch { /* none */ }
        try { git(wt, ['merge', '--abort']); } catch { /* nothing to abort */ }
        dropped.push({ itemId: r.itemId, why: `merge conflict${files ? ` in ${files}` : ''}` });
      }
    }
    return { branch, sha: git(wt, ['rev-parse', 'HEAD']).trim(), dropped };
  } finally {
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { /* left for git worktree prune */ }
  }
}

export function realDeps(wp: Workplace): Deps {
  // The Iris repo the story branches live in: the assignee's workspace, as evidence.ts storyOf reads it.
  const trunkRepo = (itemId?: string): { repo: string; trunk: string } => {
    const w = itemId ? rawGet(wp, itemId) : undefined;
    const emp = wp.org.employees.find(e => e.id === w?.employeeId) ?? wp.org.employees.find(e => !!e.workspace?.repo);
    return { repo: emp?.workspace.repo ?? '', trunk: emp?.workspace.branch ?? wp.config.github.trunk };
  };
  let lastRepo: { repo: string; trunk: string } | null = null;
  return {
    headOf: id => { const pr = rawGet(wp, id)?.pr; return pr && !pr.merged ? pr.headSha : null; },
    isCto: by => isCto(wp.org.employees.find(e => e.id === by)),
    assemble: async (rs, id) => { lastRepo = trunkRepo(rs[0]?.itemId); if (!lastRepo.repo) throw new Error('no Iris repo found for the batch'); return gitAssemble(lastRepo.repo, lastRepo.trunk, rs, id); },
    enqueue: spec => { const { repo, trunk } = lastRepo ?? trunkRepo(); return evidence.enqueueBatch(wp, { ...spec, repo, trunk }); },
    verdict: async (id, st, note) => {
      try { await githubFlow.setEvidence(wp, id, st, note); } catch (err) { log.warn('batch-test', `${id}: setEvidence: ${err instanceof Error ? err.message : String(err)}`); }
      try { trail.comment(wp, id, { by: 'workplace', text: note }); } catch { /* the item may be gone */ }
      if (st === 'success') { try { await githubFlow.autoMerge(wp, id); } catch { /* auto-merge reports its own blockers */ } }
    },
    alert: text => { coo.notifyStall(wp, { itemId: 'batch-test', by: 'workplace', title: 'Batch test', body: text }); },
    onHold: () => !!evidence.evidenceHold(wp),
    qaStory: b => {
      const epic = get(wp, 'batch-test:qa-epic') ?? QA_EPIC_DEFAULT;
      const qa = wp.org.employees.find(e => isQa(e) && !e.virtual)?.id;
      const lines = b.requests.map(r => `- ${r.itemId}: ${rawGet(wp, r.itemId)?.title ?? ''} (features ${r.features.join(', ')})`).join('\n');
      const item = items.create(wp, {
        level: 'story', parentId: epic, status: 'ready', rank: 0, ...(qa ? { assigneeId: qa } : {}),
        title: `Batch test ${b.id}${b.split ? ' (split rerun)' : ''}: ${b.requests.length} PR${b.requests.length === 1 ? '' : 's'} on staging ${b.sha?.slice(0, 9) ?? ''}`,
        body: `The batch test's combined build (${b.branch} at ${b.sha}) is on staging, robot model: ${b.robotModel ?? 'default'}. It carries:\n${lines}\n\nThe robot run's verdict lands on each PR by itself. QA: check what the robot cannot (model-decided rows, device-only cases) against this deploy and file every failure as a bug on the story it belongs to. report_done with the counts.`,
        acceptance: ['Every carried story checked against this deploy or marked n/a with why', 'Each failure filed as a bug on its story'],
      }, 'workplace');
      return item.id;
    },
  };
}

export function startBatchTest(wp: Workplace): () => void {
  const timer = setInterval(() => { tick(wp).catch(err => log.warn('batch-test', `tick: ${err instanceof Error ? err.message : String(err)}`)); }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
