import type { WorkItem } from '@jkj/shared';
import type { Workplace, WorkplaceEvent } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as floor from './floor.js';
import * as pace from './pace.js';
import { inQuietHours } from './push.js';
import { openStartsAfter } from './lifecycle.js';
import { chiefOfStaffId, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * The stall chain (HLD-rework-2026-10 §1.5, LLD W2 §6). One service in place of the five old
 * detectors (watch, stuck, hygiene notices, the dispatcher's idle alert, the manager's escalation of
 * those): every minute it looks at each Ready or In-progress story with an agent assignee, and a story
 * that has been stalled climbs one rung every ten minutes:
 *
 * - L1 at 10 min: the assignee's lead (their manager, when they are a lead themselves);
 * - L2 at 20 min: the Chief of Staff;
 * - L3 at 30 min: the COO, through a bridge line of kind `stall`;
 * - L4 at 40 min: the owner, by one ring per sweep listing every L4 story. Rings are held in quiet
 *   hours (`WORKPLACE_PUSH_QUIET`) unless super focus is on, and go on the first sweep after.
 *
 * Each rung's target hears once per stall; a target already told at a lower rung, or the assignee
 * themselves, is skipped. The clock stops (and the record is dropped) when the story moves on, when
 * the floor is paused or a weekly-pace hold is on, and when the assignee is busy: a running turn, or a
 * live session on another story they are working (In progress). A story is stalled when nobody is on it, or when the
 * session on it has been idle, with nothing done on the item, for ten minutes.
 *
 * Settings: `stall-chain:<itemId>` = { since, notified } (the level last told); `super-focus` =
 * { until } (written by the owner's super-focus switch).
 */

const MIN = 60_000;
export const STEP_MS = 10 * MIN;
export const SWEEP_MS = MIN;
const PREFIX = 'stall-chain:';
export const SUPER_FOCUS_KEY = 'super-focus';

export interface StallRecord { since: string; notified: number }

interface Stalled { w: WorkItem; since: number; why: string }

const getRow = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const put = (wp: Workplace, itemId: string, r: StallRecord): void =>
  void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(PREFIX + itemId, JSON.stringify(r));
const drop = (wp: Workplace, itemId: string): void => void wp.db.prepare('delete from settings where key = ?').run(PREFIX + itemId);

/** The chain's record for an item, while it is stalled. */
export function record(wp: Workplace, itemId: string): StallRecord | undefined {
  const v = getRow(wp, PREFIX + itemId);
  if (!v) return undefined;
  try { return JSON.parse(v) as StallRecord; } catch { return undefined; }
}

function records(wp: Workplace): string[] {
  return (wp.db.prepare('select key from settings where key like ?').all(`${PREFIX}%`) as { key: string }[]).map(r => r.key.slice(PREFIX.length));
}

/** Super focus is on (the owner wants every L4 ring, quiet hours or not). */
export function superFocus(wp: Workplace, nowMs = Date.now()): boolean {
  const v = getRow(wp, SUPER_FOCUS_KEY);
  if (!v) return false;
  try {
    const until = (JSON.parse(v) as { until?: string | null }).until;
    return !!until && Date.parse(until) > nowMs;
  } catch { return false; }
}

/* ---------- the org tree (read from org data; W1's org.ts helpers replace these on merge) ---------- */

const emp = (wp: Workplace, id: string | undefined) => (id ? wp.org.employees.find(e => e.id === id) : undefined);
const isLeadRole = (wp: Workplace, id: string | undefined): boolean => { const r = emp(wp, id)?.roleId; return r === 'lead' || r === 'qa'; };
const managerOf = (wp: Workplace, id: string): string | undefined => emp(wp, id)?.reportsTo ?? undefined;

/** The employee's lead: themselves when they are a lead (or the QA lead), else the first such ancestor. */
function teamOf(wp: Workplace, id: string): string | undefined {
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = managerOf(wp, cur)) {
    seen.add(cur);
    if (isLeadRole(wp, cur)) return cur;
  }
  return undefined;
}

/** Who each level tells, for this assignee: lead (or their manager), the Chief of Staff, the COO, the owner. */
export function targets(wp: Workplace, assignee: string): (string | undefined)[] {
  const team = teamOf(wp, assignee);
  const l1 = team && team !== assignee ? team : managerOf(wp, assignee);
  return [l1, chiefOfStaffId(wp), coo.COO_ID, 'owner'];
}

/* ---------- is it stalled? ---------- */

/** A story the person is still working (In progress, theirs): a session left on a submitted or finished one does not make them busy. */
const working = (w: WorkItem | undefined, who: string): boolean => !!w && w.status === 'in-progress' && w.employeeId === who && !w.mergedInto;

/** The newest thing a person did on the item: its activity and comments, the Workplace's own rows aside. */
function lastWorkOn(wp: Workplace, itemId: string): number {
  const a = wp.db.prepare("select at from activity where item_id = ? and kind != 'stall' and by != 'workplace' order by seq desc limit 1").get(itemId) as { at: string } | undefined;
  const c = wp.db.prepare("select at from comments where item_id = ? and by != 'workplace' order by at desc limit 1").get(itemId) as { at: string } | undefined;
  return Math.max(a ? Date.parse(a.at) : 0, c ? Date.parse(c.at) : 0);
}

/**
 * Is the story stalled now, and since when? `firstSeen` is the moment the sweep first saw nobody on it
 * (the record's `since`, or now). Null when it is moving, waiting by design, or its assignee is busy.
 */
export function evaluate(wp: Workplace, w: WorkItem, nowMs: number, firstSeen = nowMs): Stalled | null {
  const status = w.status as string | undefined;
  if (status !== 'ready' && status !== 'in-progress') return null;
  if (levelOf(w) === 'epic' || w.mergedInto) return null;
  const who = w.employeeId;
  if (!who || !isAgent(wp, who)) return null;
  if (openStartsAfter(wp, w)) return null;
  const live = employees.sessionsOf(who).filter(s => employees.isLive(s.agentId));
  // Busy: a running turn (or one parked on a tool approval), or a live session on another story they are working
  // story (or switching to one at its turn's end). That story is the one that can stall, not this.
  for (const s of live) {
    const a = runs.getRunAgent(s.agentId);
    if (!a || a.status === 'running' || a.approval) return null;
    if (s.assignmentId && s.assignmentId !== w.id && working(rawGet(wp, s.assignmentId), who)) return null;
    if (employees.hasPendingSwitch(s.agentId)) return null;
  }
  const bound = live.find(s => s.assignmentId === w.id);
  if (!bound) {
    const why = status === 'ready' ? 'Ready and not started' : 'In progress with nobody on it';
    return { w, since: firstSeen, why };
  }
  const idle = runs.idleMs(bound.agentId, nowMs);
  const quietFor = Math.min(idle ?? Number.POSITIVE_INFINITY, nowMs - lastWorkOn(wp, w.id));
  if (quietFor < STEP_MS) return null;
  return { w, since: nowMs - quietFor, why: 'its session has done nothing on it' };
}

/* ---------- the sweep ---------- */

const minutes = (ms: number): number => Math.floor(ms / MIN);

export interface SweepResult { told: { itemId: string; level: number; to: string }[]; rung: string[] }

function tellEmployee(wp: Workplace, target: string, w: WorkItem, text: string): void {
  try {
    // Autonomous, like a mention: under the caps, into the target's open session or a short one.
    employees.talk(wp, target, text, [], { autonomous: true, probe: true, from: 'workplace' });
  } catch (err) {
    log.warn('stall-chain', `${w.id}: could not reach ${target}: ${err instanceof Error ? err.message : err}`);
  }
}

/** One sweep. Returns who was told and which items rang. */
export function sweep(wp: Workplace, nowMs = Date.now()): SweepResult {
  const result: SweepResult = { told: [], rung: [] };
  // Stopping the clock: a paused floor or a pace hold is a deliberate stop, and the clock starts again after it.
  if (floor.paused(wp) || pace.holdUntil(wp, nowMs)) {
    for (const id of records(wp)) drop(wp, id);
    return result;
  }
  const rows = rowsJson<WorkItem>(wp.db.prepare("select json from work where status in ('ready', 'in-progress')").all());
  const live = new Set<string>();
  const ring: { w: WorkItem; rec: StallRecord; mins: number }[] = [];
  for (const w of rows) {
    const prev = record(wp, w.id);
    const s = evaluate(wp, w, nowMs, prev ? Date.parse(prev.since) : nowMs);
    if (!s) continue;
    live.add(w.id);
    const rec: StallRecord = prev ?? { since: new Date(s.since).toISOString(), notified: 0 };
    const elapsed = nowMs - Date.parse(rec.since);
    const level = Math.min(4, Math.floor(elapsed / STEP_MS));
    const chain = targets(wp, w.employeeId!);
    const mins = minutes(elapsed);
    const text = `Stalled ${mins} min: "${w.title}" (${nameOf(wp, w.employeeId)}) — ${s.why}. Get it moving or say why.`;
    for (let l = rec.notified + 1; l <= Math.min(level, 3); l++) {
      const to = chain[l - 1];
      rec.notified = l;
      // A rung whose target is the assignee, or someone a lower rung already told, is passed over.
      if (!to || to === w.employeeId || chain.slice(0, l - 1).includes(to)) continue;
      if (to === coo.COO_ID) coo.notifyStall(wp, { itemId: w.id, title: `Stalled ${mins} min: ${w.title}`, body: text, by: 'workplace' });
      else tellEmployee(wp, to, w, text);
      trail.comment(wp, w.id, { by: 'workplace', text: `${text} (told ${nameOf(wp, to)})` });
      result.told.push({ itemId: w.id, level: l, to });
      log.info('stall-chain', `${w.id}: level ${l}, told ${to}`);
    }
    if (level >= 4 && rec.notified < 4) ring.push({ w, rec, mins });
    put(wp, w.id, rec);
  }
  for (const id of records(wp)) if (!live.has(id)) drop(wp, id);

  if (ring.length) {
    if (inQuietHours(wp.config.pushQuiet, nowMs) && !superFocus(wp, nowMs)) {
      log.info('stall-chain', `ring held (quiet hours): ${ring.map(r => r.w.id).join(', ')}`);
    } else {
      const list = ring.map(r => `"${r.w.title}" (${nameOf(wp, r.w.employeeId)}, ${r.mins} min)`).join('; ');
      const title = ring.length === 1 ? `Stalled 40+ min: ${ring[0]!.w.title}` : `${ring.length} stories stalled 40+ min`;
      const text = `Stalled 40+ min, the lead, Asha and the COO have been told: ${list}.`;
      const itemIds = ring.map(r => r.w.id);
      // The ring level and itemIds are the rework's push contract (W4 sends it); cast until the shared type has them.
      wp.emit({ type: 'alert', level: 'ring', title, body: text, text, itemIds } as unknown as WorkplaceEvent);
      for (const r of ring) {
        put(wp, r.w.id, { ...r.rec, notified: 4 });
        trail.comment(wp, r.w.id, { by: 'workplace', text: `Stalled ${r.mins} min: the owner was rung.` });
        result.told.push({ itemId: r.w.id, level: 4, to: 'owner' });
      }
      result.rung = itemIds;
      log.warn('stall-chain', `rang the owner: ${itemIds.join(', ')}`);
    }
  }
  return result;
}

/** Every minute. Returns stop(). */
export function startStallChain(wp: Workplace): () => void {
  const timer = setInterval(() => {
    try { sweep(wp); } catch (err) { log.warn('stall-chain', err instanceof Error ? err.message : String(err)); }
  }, SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
