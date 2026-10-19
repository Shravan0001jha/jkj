import type { HygieneReport, HygieneRule, HygieneViolation, WorkItem } from '@jkj/shared';
import { HYGIENE_RULES } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as runs from './runs.js';
import * as items from './items.js';
import * as stuck from './stuck.js';
import * as coo from './coo.js';
import * as dispatch from './dispatch.js';
import * as floor from './floor.js';
import * as waitReply from './wait-reply.js';
import * as lifecycleWatch from './lifecycle-watch.js';
import { closed, finished, label, openStartsAfter, trueStatus } from './lifecycle.js';
import { githubMode } from './review-policy.js';
import { chiefOfStaffId, epicOf, humanDuration, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { rowsJson } from './store.js';
import { log } from '../util/logger.js';
import * as postMerge from './post-merge.js';
import { branchFor, git } from './worktrees.js';

/** Approved but not merged yet (its merge checks are pending): it WILL finish, so starting after it is fine (11 Oct, gap #18). */
const awaitingMerge = (w: WorkItem): boolean => !!w.pr && !w.pr.merged && (w.resolution ?? 'done') === 'done';

/** Commits on the story's branch ahead of its trunk; true when it can't tell (keep the rule strict). */
function hasCommits(wp: Workplace, w: WorkItem): boolean {
  const emp = w.employeeId ? wp.org.employees.find(e => e.id === w.employeeId) : undefined;
  if (!emp) return true;
  const branch = branchFor(emp, w.id);
  try { git(emp.workspace.repo, ['rev-parse', '--git-dir']); } catch { return true; }   // not a repo here: can't tell
  try {
    git(emp.workspace.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch { return false; }   // no branch at all: nothing to submit
  try {
    return Number(git(emp.workspace.repo, ['rev-list', '--count', `${emp.workspace.branch ?? 'main'}..${branch}`]).trim()) > 0;
  } catch { return true; }
}

/**
 * The hygiene monitor (docs/HLD-jira-lifecycle.md §4): is the board true? A sweep every 2 minutes
 * finds the violations below for GET /api/hygiene, and reports them to the COO every 60 minutes (one
 * summary bridge item; nothing when clean). Asha is no longer sent hygiene notices (LLD-rework-2026-10
 * W2 §6). Silent while the floor is paused, and the clocks start again after the resume.
 *
 * Settings: `hygiene:seen` (first-seen per violation key), `hygiene:coo` ({ at }).
 */

const MIN = 60_000;
export const SWEEP_MS = 2 * MIN;
export const ASHA_MS = 10 * MIN;
export const COO_MS = 60 * MIN;

/** How long a condition must last before it is a violation (the immediate ones are facts on the row). */
export const AFTER: Record<HygieneRule, number> = {
  'top-idle': 10 * MIN, 'no-session': 10 * MIN, 'bad-block': 0, 'bad-review': 0, 'done-unmerged': 0, 'unrouted-top': 15 * MIN, 'wrong-assignee': 10 * MIN,
};
export const LETTER: Record<HygieneRule, string> = {
  'top-idle': 'a', 'no-session': 'b', 'bad-block': 'c', 'bad-review': 'd', 'done-unmerged': 'e', 'unrouted-top': 'f', 'wrong-assignee': 'g',
};

const SEEN = 'hygiene:seen';
const ASHA = 'hygiene:asha';
const COO = 'hygiene:coo';

interface Condition { key: string; rule: HygieneRule; w: WorkItem; what: string; fix: string; /** For the immediate rules: when the fact began. */ since?: string }

function read<T>(wp: Workplace, key: string): T | undefined {
  const row = wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value) as T; } catch { return undefined; }
}
const write = (wp: Workplace, key: string, v: unknown): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, JSON.stringify(v));
const drop = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);

const quote = (t: string): string => `"${t}"`;

/** Not an epic, not merged into another. */
function openRows(wp: Workplace): WorkItem[] {
  return rowsJson<WorkItem>(wp.db.prepare("select json from work where status != 'done' or json_extract(json, '$.pr') is not null").all())
    .filter(w => levelOf(w) !== 'epic' && !w.mergedInto);
}

/** Queue order: the epic's place in the focus (outside it last), then rank, then age. */
function queueSort(wp: Workplace, rows: WorkItem[]): WorkItem[] {
  const focus = items.getFocus(wp).epicIds;
  const at = (w: WorkItem): number => { const e = epicOf(wp, w); const i = e ? focus.indexOf(e.id) : -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return rows.map(w => ({ w, f: at(w) }))
    .sort((a, b) => a.f - b.f || (a.w.rank ?? 0) - (b.w.rank ?? 0) || a.w.createdAt.localeCompare(b.w.createdAt) || a.w.id.localeCompare(b.w.id))
    .map(x => x.w);
}

const startable = (wp: Workplace, w: WorkItem): boolean =>
  (w.status === 'ready' || w.status === 'in-progress') && !openStartsAfter(wp, w);

/**
 * A person's queue, in the order they work it (LLD-rework W2 §1-2): their In-progress work first (one
 * story per person: Ready work waits behind it), then their Ready work in the dispatcher's own order
 * (routed-to-lead, then focus, then rank and age), so hygiene's "top" is what the dispatcher starts next.
 */
export function personQueue(wp: Workplace, employeeId: string, rows = openRows(wp)): WorkItem[] {
  const mine = rows.filter(w => w.employeeId === employeeId && startable(wp, w));
  const wip = queueSort(wp, mine.filter(w => w.status === 'in-progress'));
  const ready = new Set(mine.filter(w => w.status === 'ready').map(w => w.id));
  return [...wip, ...dispatch.queue(wp, employeeId).filter(w => ready.has(w.id))];
}

/** The global Ready queue, highest-ranked first. */
export function globalQueue(wp: Workplace, rows = openRows(wp)): WorkItem[] {
  return queueSort(wp, rows.filter(w => w.status === 'ready' && !openStartsAfter(wp, w)));
}

const liveSessions = (employeeId: string) => employees.sessionsOf(employeeId).filter(s => employees.isLive(s.agentId));

const COS_CHARTER = 'chief-of-staff';

/**
 * (a) for one person: the top of their queue (their In-progress story if they have one) with nobody on
 * it. One story per person (LLD-rework W2 §2; dry run 10 Oct, #13): the fix is never to switch them off
 * the story they are on; it is to let them finish it, or re-rank.
 */
function topIdle(wp: Workplace, id: string, name: string, q: WorkItem[], noSession: Set<string>, out: Condition[]): void {
  const top = q[0];
  if (!top) return;
  if (employees.sessionOn(id, top.id)) return;
  const live = liveSessions(id);
  const lower = live.map(s => q.find(w => w.id !== top.id && w.id === s.assignmentId)).find(Boolean);
  if (lower) {
    out.push({ key: `top-idle:${top.id}`, rule: 'top-idle', w: top, what: `top of ${name}'s queue (${label(trueStatus(wp, top))}), but ${name} is on lower-ranked ${quote(lower.title)}`, fix: `let ${name} finish ${quote(lower.title)} first (one story per person), or re-rank ${quote(top.title)} below it` });
    return;
  }
  if (noSession.has(top.id)) return; // (b) says it already
  const busy = live.some(s => { const a = runs.getRunAgent(s.agentId); return !!a && (a.status === 'running' || !!a.approval); });
  if (busy) return; // a review, or the owner talking: real work
  out.push({ key: `top-idle:${top.id}`, rule: 'top-idle', w: top, what: `top of ${name}'s queue (${label(trueStatus(wp, top))}), and ${name} is idle`, fix: `start ${name} on it (POST /api/items/${top.id} with start: true), or move it to Backlog if it is not for now` });
}

/** Every condition that holds now, before the "for how long" thresholds. */
export function conditions(wp: Workplace): Condition[] {
  const rows = openRows(wp);
  const out: Condition[] = [];
  const cos = chiefOfStaffId(wp);
  const noSession = new Set<string>();

  // (b) In progress with no live session: the stuck watchdog's rule.
  for (const w of rows) {
    if (w.status !== 'in-progress') continue;
    const c = stuck.condition(wp, w);
    if (!c || !c.state.startsWith('in-progress:')) continue;
    noSession.add(w.id);
    out.push({ key: `no-session:${w.id}`, rule: 'no-session', w, what: `In progress, but ${nameOf(wp, w.employeeId)} has no live session on it`, fix: c.action });
  }

  // (a) The top of a person's queue nobody is on. Asha's queue is mostly a routing queue: its top is to
  // be routed. Work she holds in a charter of her own (product-and-business), not the routing charter,
  // is routed already: it is her own queue, judged like anyone's (dry run 10 Oct, #10).
  for (const e of wp.org.employees) {
    if (e.virtual || !isAgent(wp, e.id)) continue;
    const q = personQueue(wp, e.id, rows);
    if (e.id === cos) {
      const own = new Set(e.charterIds.filter(c => c !== COS_CHARTER));
      const isOwn = (w: WorkItem): boolean => !!w.charterId && own.has(w.charterId);
      const route = q.find(w => !isOwn(w));
      if (route) out.push({ key: `top-idle:${route.id}`, rule: 'top-idle', w: route, what: `top of ${e.name}'s routing queue, not routed to a developer`, fix: `${e.name} routes it: item_update ${route.id} assigneeId <the owning developer>` });
      topIdle(wp, e.id, e.name, q.filter(isOwn), noSession, out);
      continue;
    }
    topIdle(wp, e.id, e.name, q, noSession, out);
  }

  for (const w of rows) {
    // (c0) A wait the awaited person has already answered (18 Oct: stories sat Waiting a day after the reply).
    if (w.status === 'waiting') {
      const a = waitReply.answerTo(wp, w);
      if (a) out.push({ key: `wait-answered:${w.id}`, rule: 'bad-block', w, what: `Waiting on ${nameOf(wp, w.waiting!.on)}, who already replied`, fix: `move it back to In progress (item_update ${w.id} status in-progress reason "<who> replied: …") and act on the reply`, since: a.at });
    }
    // (c) Blocked must name a concrete blocker that is still open.
    if (w.status === 'blocked') {
      if ((!w.waitingOn || !w.blockedReason) && !w.startsAfter) {
        const missing = [!w.waitingOn ? 'waitingOn' : '', !w.blockedReason ? 'blockedReason' : ''].filter(Boolean).join(' and ');
        out.push({ key: `bad-block:${w.id}`, rule: 'bad-block', w, what: `Blocked without a concrete blocker (no ${missing})`, fix: `say what it waits on and why (item_update ${w.id} waitingOn <person|item|owner|coo|release> blockedReason <why>, or startsAfter <item>), or unblock it`, since: w.blockedSince ?? w.statusSince ?? w.updatedAt });
      } else {
        const onId = w.waitingOn && rawGet(wp, w.waitingOn) ? w.waitingOn : w.startsAfter;
        const on = onId ? rawGet(wp, onId) : undefined;
        if (on && closed(on)) {
          out.push({ key: `bad-block:${w.id}`, rule: 'bad-block', w, what: `Blocked on ${quote(on.title)}, which is ${label(trueStatus(wp, on))}${on.resolution && on.resolution !== 'done' ? ` (${on.resolution})` : ''}`, fix: `unblock it (item_update ${w.id} status in-progress), or point it at what it really waits on`, since: on.statusSince ?? on.updatedAt });
        }
      }
    } else if (w.status === 'ready' && w.startsAfter) {
      const dep = rawGet(wp, w.startsAfter);
      if (dep && closed(dep) && !finished(dep) && !awaitingMerge(dep)) {
        out.push({ key: `bad-block:${w.id}`, rule: 'bad-block', w, what: `Starts after ${quote(dep.title)}, which closed as ${dep.resolution ?? 'done'} and will never finish`, fix: `clear startsAfter (item_update ${w.id} startsAfter "") or point it at the real dependency`, since: dep.statusSince ?? dep.updatedAt });
      }
    }
    // (d) In review needs a reviewer, and in mode `on` a story needs its PR.
    if (w.status === 'in-review') {
      if (!w.reviewerId) out.push({ key: `bad-review:${w.id}`, rule: 'bad-review', w, what: 'In review with no reviewer', fix: `name a reviewer (item_update ${w.id} reviewerId <reviewer>)`, since: w.statusSince ?? w.updatedAt });
      // Only a story with code to submit needs its PR: a sign-off wait on a no-code story (a live check
      // with a teammate, flag_stall kind review) is In review without one (Asha, 5 Oct).
      else if (!w.pr && levelOf(w) === 'story' && githubMode(wp) === 'on' && hasCommits(wp, w)) out.push({ key: `bad-review:${w.id}`, rule: 'bad-review', w, what: 'In review with no pull request', fix: `${nameOf(wp, w.employeeId)} submits with report_done so the Workplace opens the PR, or it goes back to In progress`, since: w.statusSince ?? w.updatedAt });
    }
    // (e) Done with an open PR that is not approved: the board says Done, GitHub says otherwise.
    if (w.status === 'done' && (w.resolution ?? 'done') === 'done' && w.pr && !w.pr.merged && trueStatus(wp, w) === 'done') {
      out.push({ key: `done-unmerged:${w.id}`, rule: 'done-unmerged', w, what: `Done, but PR #${w.pr.number} is not merged and its approvals do not hold`, fix: `reopen it to In review for the two approvals, or merge PR #${w.pr.number}`, since: w.statusSince ?? w.updatedAt });
    }
  }

  // (f) An unassigned Ready item. Board bug 5 (19 Oct): only the top of the global queue was named, so the
  // four below it were invisible for 7 hours; every one is a violation of its own.
  const queueNow = globalQueue(wp, rows);
  for (const w of queueNow) {
    if (w.employeeId) continue;
    const top = w === queueNow[0];
    out.push({ key: `unrouted-top:${w.id}`, rule: 'unrouted-top', w, what: top ? 'unassigned at the top of the Ready queue' : 'unassigned in the Ready queue', fix: `${nameOf(wp, cos)} routes it (item_update ${w.id} assigneeId <the owning lead>)` });
  }

  // (g) The assignee is whoever actually works on it.
  for (const s of employees.allSessions()) {
    if (!s.assignmentId || s.probe || !employees.isLive(s.agentId) || s.employeeId === cos) continue;
    const w = rawGet(wp, s.assignmentId);
    if (!w || levelOf(w) === 'epic' || w.status === 'done' || w.employeeId === s.employeeId) continue;
    if (w.status === 'in-review' && w.reviewerId === s.employeeId) continue; // the reviewer, reviewing
    const who = nameOf(wp, s.employeeId);
    out.push({ key: `wrong-assignee:${w.id}:${s.employeeId}`, rule: 'wrong-assignee', w, what: `${who} is working on it, but it is assigned to ${nameOf(wp, w.employeeId)}`, fix: `reassign it to ${who} (item_update ${w.id} assigneeId ${s.employeeId}), or stop ${who}'s session on it` });
  }
  return out;
}

function toViolation(c: Condition, since: string, nowMs: number): HygieneViolation {
  return {
    key: c.key, rule: c.rule, itemId: c.w.id, title: c.w.title, ...(c.w.employeeId ? { assigneeId: c.w.employeeId } : {}),
    what: c.what, since, minutes: Math.max(0, Math.floor((nowMs - Date.parse(since)) / MIN)), fix: c.fix,
  };
}

/** The violations now, given when each condition was first seen. Oldest first. */
function judge(conds: Condition[], seen: Record<string, string>, nowMs: number): HygieneViolation[] {
  const iso = new Date(nowMs).toISOString();
  const out: HygieneViolation[] = [];
  for (const c of conds) {
    const first = seen[c.key] ?? iso;
    if (nowMs - Date.parse(first) < AFTER[c.rule]) continue;
    out.push(toViolation(c, c.since ?? first, nowMs));
  }
  return out.sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
}

/** What the apps show: the current violations and how clean the board is (GET /api/hygiene). */
export function report(wp: Workplace, nowMs = Date.now()): HygieneReport {
  const paused = floor.paused(wp);
  const violations = judge(conditions(wp), read<Record<string, string>>(wp, SEEN) ?? {}, nowMs);
  const population = openRows(wp).filter(w => w.status !== 'done' || (w.pr && !w.pr.merged));
  const bad = new Set(violations.map(v => v.itemId));
  const clean = population.filter(w => !bad.has(w.id)).length;
  const counts = Object.fromEntries(HYGIENE_RULES.map(r => [r, 0])) as Record<HygieneRule, number>;
  for (const v of violations) counts[v.rule] += 1;
  return {
    at: new Date(nowMs).toISOString(), paused,
    cleanPct: population.length ? Math.round((clean / population.length) * 100) : 100,
    open: population.length, clean, counts, violations,
  };
}


export function line(wp: Workplace, v: HygieneViolation): string {
  return `- (${LETTER[v.rule]}) ${quote(v.title)} [${v.itemId}]${v.assigneeId ? ` (${nameOf(wp, v.assigneeId)})` : ''}: ${v.what}, for ${humanDuration(v.minutes * MIN)}. Fix: ${v.fix}.`;
}

/**
 * Asha no longer gets board-hygiene notices (LLD-rework-2026-10 W2 §6: 19% of her comments said "not
 * a real stall"; the stall chain tells her what is really stalled). The report is still computed for
 * GET /api/hygiene and the COO's summary. Drops the old per-Asha record; returns null.
 */
function toAsha(wp: Workplace): null {
  drop(wp, ASHA);
  return null;
}

/** The COO, every 60 min: one summary bridge item; nothing when clean. Returns its body, or null. */
function toCoo(wp: Workplace, vs: HygieneViolation[], nowMs: number): string | null {
  const st = read<{ at: string }>(wp, COO);
  if (st && nowMs - Date.parse(st.at) < COO_MS) return null;
  write(wp, COO, { at: new Date(nowMs).toISOString() });
  if (!vs.length) return null;
  const r = report(wp, nowMs);
  const counts = HYGIENE_RULES.filter(rule => r.counts[rule] > 0).map(rule => `(${LETTER[rule]}) ${rule} ${r.counts[rule]}`).join(', ');
  const title = `Board hygiene: ${vs.length} violation${vs.length === 1 ? '' : 's'}, ${r.cleanPct}% clean`;
  const body = [`${title}.`, `By rule: ${counts}.`, 'Oldest:', ...vs.slice(0, 3).map(v => line(wp, v))].join('\n');
  coo.notifyHygiene(wp, { title, body });
  return body;
}

export interface SweepResult { violations: HygieneViolation[]; asha: string | null; coo: string | null }

/** One sweep: repair merges made elsewhere, track first-seen times, report when due. */
export function sweep(wp: Workplace, nowMs = Date.now()): SweepResult {
  if (floor.paused(wp)) { drop(wp, SEEN); return { violations: [], asha: null, coo: null }; }
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where status != 'done' and json_extract(json, '$.pr.merged') is not null").all())) {
    try { lifecycleWatch.onMerged(wp, w.id); } catch (err) { log.warn('hygiene', `${w.id}: ${err instanceof Error ? err.message : err}`); }
  }
  try { postMerge.sweep(wp); } catch (err) { log.warn('hygiene', `post-merge: ${err instanceof Error ? err.message : err}`); }
  const conds = conditions(wp);
  const prev = read<Record<string, string>>(wp, SEEN) ?? {};
  const iso = new Date(nowMs).toISOString();
  const seen = Object.fromEntries(conds.map(c => [c.key, prev[c.key] ?? iso]));
  write(wp, SEEN, seen);
  const violations = judge(conds, seen, nowMs);
  return { violations, asha: toAsha(wp), coo: toCoo(wp, violations, nowMs) };
}

/** Every two minutes. Returns stop(). */
export function startHygieneWatch(wp: Workplace): () => void {
  const timer = setInterval(() => {
    try { sweep(wp); } catch (err) { log.warn('hygiene', err instanceof Error ? err.message : String(err)); }
  }, SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
