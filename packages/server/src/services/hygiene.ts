import type { HygieneReport, HygieneRule, HygieneViolation, WorkItem } from '@jkj/shared';
import { HYGIENE_RULES } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as runs from './runs.js';
import * as items from './items.js';
import * as stuck from './stuck.js';
import * as manager from './manager.js';
import * as coo from './coo.js';
import * as floor from './floor.js';
import * as lifecycleWatch from './lifecycle-watch.js';
import { closed, finished, label, openStartsAfter, trueStatus } from './lifecycle.js';
import { githubMode } from './review-policy.js';
import { chiefOfStaffId, epicOf, humanDuration, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * The hygiene monitor (docs/HLD-jira-lifecycle.md §4): is the board true? A sweep every 2 minutes
 * finds the violations below, and reports them: to Asha every 10 minutes (only what is new or changed
 * since her last report; nothing, and no session, when nothing is), and to the COO every 60 minutes
 * (one summary bridge item; nothing when clean). Silent while the floor is paused, and the clocks
 * start again after the resume.
 *
 * Settings: `hygiene:seen` (first-seen per violation key), `hygiene:asha` ({ at, sent: key → fingerprint }),
 * `hygiene:coo` ({ at }).
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

/** A person's queue: their Ready and In-progress work, highest-ranked first. */
export function personQueue(wp: Workplace, employeeId: string, rows = openRows(wp)): WorkItem[] {
  return queueSort(wp, rows.filter(w => w.employeeId === employeeId && startable(wp, w)));
}

/** The global Ready queue, highest-ranked first. */
export function globalQueue(wp: Workplace, rows = openRows(wp)): WorkItem[] {
  return queueSort(wp, rows.filter(w => w.status === 'ready' && !openStartsAfter(wp, w)));
}

const liveSessions = (employeeId: string) => employees.sessionsOf(employeeId).filter(s => employees.isLive(s.agentId));

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

  // (a) The top of a person's queue nobody is on. Asha's queue is a routing queue: its top is to be routed.
  for (const e of wp.org.employees) {
    if (e.virtual || !isAgent(wp, e.id)) continue;
    const q = personQueue(wp, e.id, rows);
    const top = q[0];
    if (!top) continue;
    const name = e.name;
    if (e.id === cos) {
      out.push({ key: `top-idle:${top.id}`, rule: 'top-idle', w: top, what: `top of ${name}'s routing queue, not routed to a developer`, fix: `${name} routes it: item_update ${top.id} assigneeId <the owning developer>` });
      continue;
    }
    if (employees.sessionOn(e.id, top.id)) continue;
    const live = liveSessions(e.id);
    const lower = live.map(s => q.find(w => w.id !== top.id && w.id === s.assignmentId)).find(Boolean);
    if (lower) {
      out.push({ key: `top-idle:${top.id}`, rule: 'top-idle', w: top, what: `top of ${name}'s queue (${label(trueStatus(wp, top))}), but ${name} is on lower-ranked ${quote(lower.title)}`, fix: `switch ${name} to it, or re-rank it below ${quote(lower.title)}` });
      continue;
    }
    if (noSession.has(top.id)) continue; // (b) says it already
    const busy = live.some(s => { const a = runs.getRunAgent(s.agentId); return !!a && (a.status === 'running' || !!a.approval); });
    if (busy) continue; // a review, or the owner talking: real work
    out.push({ key: `top-idle:${top.id}`, rule: 'top-idle', w: top, what: `top of ${name}'s queue (${label(trueStatus(wp, top))}), and ${name} is idle`, fix: `start ${name} on it (POST /api/items/${top.id} with start: true), or move it to Backlog if it is not for now` });
  }

  for (const w of rows) {
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
      if (dep && closed(dep) && !finished(dep)) {
        out.push({ key: `bad-block:${w.id}`, rule: 'bad-block', w, what: `Starts after ${quote(dep.title)}, which closed as ${dep.resolution ?? 'done'} and will never finish`, fix: `clear startsAfter (item_update ${w.id} startsAfter "") or point it at the real dependency`, since: dep.statusSince ?? dep.updatedAt });
      }
    }
    // (d) In review needs a reviewer, and in mode `on` a story needs its PR.
    if (w.status === 'in-review') {
      if (!w.reviewerId) out.push({ key: `bad-review:${w.id}`, rule: 'bad-review', w, what: 'In review with no reviewer', fix: `name a reviewer (item_update ${w.id} reviewerId <reviewer>)`, since: w.statusSince ?? w.updatedAt });
      else if (!w.pr && levelOf(w) === 'story' && githubMode(wp) === 'on') out.push({ key: `bad-review:${w.id}`, rule: 'bad-review', w, what: 'In review with no pull request', fix: `${nameOf(wp, w.employeeId)} submits with report_done so the Workplace opens the PR, or it goes back to In progress`, since: w.statusSince ?? w.updatedAt });
    }
    // (e) Done with an open PR that is not approved: the board says Done, GitHub says otherwise.
    if (w.status === 'done' && (w.resolution ?? 'done') === 'done' && w.pr && !w.pr.merged && trueStatus(wp, w) === 'done') {
      out.push({ key: `done-unmerged:${w.id}`, rule: 'done-unmerged', w, what: `Done, but PR #${w.pr.number} is not merged and its approvals do not hold`, fix: `reopen it to In review for the two approvals, or merge PR #${w.pr.number}`, since: w.statusSince ?? w.updatedAt });
    }
  }

  // (f) An unassigned Ready item at the top of the global queue.
  const top = globalQueue(wp, rows)[0];
  if (top && !top.employeeId) {
    out.push({ key: `unrouted-top:${top.id}`, rule: 'unrouted-top', w: top, what: 'unassigned at the top of the Ready queue', fix: `${nameOf(wp, cos)} routes it (item_update ${top.id} assigneeId <the owning developer>)` });
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

const fingerprint = (v: HygieneViolation): string => `${v.rule}|${v.itemId}|${v.what}`;

export function line(wp: Workplace, v: HygieneViolation): string {
  return `- (${LETTER[v.rule]}) ${quote(v.title)} [${v.itemId}]${v.assigneeId ? ` (${nameOf(wp, v.assigneeId)})` : ''}: ${v.what}, for ${humanDuration(v.minutes * MIN)}. Fix: ${v.fix}.`;
}

/** Asha, every 10 min: only what is new or changed since her last report. Returns the text sent, or null. */
function toAsha(wp: Workplace, vs: HygieneViolation[], nowMs: number): string | null {
  const st = read<{ at: string; sent: Record<string, string> }>(wp, ASHA);
  if (st && nowMs - Date.parse(st.at) < ASHA_MS) return null;
  const sent = st?.sent ?? {};
  const fresh = vs.filter(v => sent[v.key] !== fingerprint(v));
  const at = new Date(nowMs).toISOString();
  write(wp, ASHA, { at, sent: Object.fromEntries(vs.map(v => [v.key, fingerprint(v)])) });
  if (!fresh.length) return null;
  const text = [
    `Board hygiene: ${fresh.length} new or changed (${vs.length} open in all). The board must show the true state: fix each one and say what you did with item_comment on the item.`,
    ...fresh.map(v => line(wp, v)),
  ].join('\n');
  manager.alert(wp, { key: `hygiene:${at}`, itemId: '', title: 'Board hygiene', body: text, text, notice: true, by: 'workplace' }, nowMs);
  return text;
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
  const body = [`${title}. Asha has them every 10 min.`, `By rule: ${counts}.`, 'Oldest:', ...vs.slice(0, 3).map(v => line(wp, v))].join('\n');
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
  const conds = conditions(wp);
  const prev = read<Record<string, string>>(wp, SEEN) ?? {};
  const iso = new Date(nowMs).toISOString();
  const seen = Object.fromEntries(conds.map(c => [c.key, prev[c.key] ?? iso]));
  write(wp, SEEN, seen);
  const violations = judge(conds, seen, nowMs);
  return { violations, asha: toAsha(wp, violations, nowMs), coo: toCoo(wp, violations, nowMs) };
}

/** Every two minutes. Returns stop(). */
export function startHygieneWatch(wp: Workplace): () => void {
  const timer = setInterval(() => {
    try { sweep(wp); } catch (err) { log.warn('hygiene', err instanceof Error ? err.message : String(err)); }
  }, SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
