import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as spend from './spend.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as manager from './manager.js';
import { baseTitle } from './status.js';
import { chiefOfStaffId, epicOf, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { log } from '../util/logger.js';

/**
 * Blocks and the dependencies behind them (owner, 2 Oct; LLD §19.6b). Nikhil's QA story for the P0
 * sat Blocked on Dev's story for ~40 minutes and nobody was told; when Dev's story reached In review
 * nothing woke Nikhil either. So:
 *
 * (a) An item entering Blocked on anyone but the owner (the owner has the Inbox question already):
 *     Asha is alerted at once (`manager.alert`, LLD §19.6e; the COO only if she does not act within 15
 *     minutes), or the COO directly when the COO is the one waited on; the one waited on (an agent) is
 *     told (a message into its session, or a short session).
 * (b) Still blocked on the same block `stallBlockedMinutes` (15) later: told again, once, the same way.
 * (c) An item reaching In review or Done: each item blocked on it — its id or title in the reason,
 *     or waiting on its assignee within the same epic — has its assignee told, so it can unblock.
 *
 * Records in settings: `block-notify:<itemId>` = `{ since: blockedSince, renotified }` (one per
 * block episode), `dep-wake:<itemId>` = `<status>:<statusSince>` (one per arrival).
 */

const MIN = 60_000;
const NOTIFY = (id: string): string => `block-notify:${id}`;
const DEP = (id: string): string => `dep-wake:${id}`;

interface BlockRecord { since: string; renotified: boolean }

const get = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const put = (wp: Workplace, key: string, value: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
const del = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);

function readBlock(wp: Workplace, id: string): BlockRecord | undefined {
  const v = get(wp, NOTIFY(id));
  if (!v) return undefined;
  try { return JSON.parse(v) as BlockRecord; } catch { return undefined; }
}

const noun = (w: WorkItem): string => (levelOf(w) === 'epic' ? 'Epic' : levelOf(w) === 'task' ? 'Task' : 'Story');
const sinceOf = (w: WorkItem): string => w.blockedSince ?? w.statusSince ?? w.updatedAt;
const notOwnerBlock = (w: WorkItem): boolean => w.status === 'blocked' && !!w.waitingOn && w.waitingOn !== 'owner';

/**
 * Tell an employee something now: a message into its open session, else a short autonomous session
 * (within budget and its concurrency cap). Returns how it was delivered, or null when it could not be.
 */
export function tell(wp: Workplace, employeeId: string, text: string): 'message' | 'session' | null {
  if (!isAgent(wp, employeeId)) return null;
  const open = employees.openSession(employeeId);
  if (open) {
    try { runs.sendMessage(open.agentId, text, [], { from: 'workplace' }); return 'message'; } catch (err) { log.warn('blocks', `tell ${employeeId}: ${err instanceof Error ? err.message : err}`); return null; }
  }
  if (!spend.canSpend(wp, employeeId).ok) return null;
  try { employees.talk(wp, employeeId, text, [], { autonomous: true }); return 'session'; } catch (err) {
    log.warn('blocks', `tell ${employeeId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Who hears of a block (LLD §19.6e): waiting on the COO → the COO (a bridge item: it is the COO who
 * must act); anything else → Asha first, and the COO only if she does not act within 15 minutes (or it
 * is above her, or she is stuck). Returns who heard.
 */
function report(wp: Workplace, w: WorkItem, key: string, title: string, body: string, ashaText: string, sinceIso?: string): string[] {
  // flag_stall with waitingOn has just raised this very block ("Flagged: …"): not twice.
  const recent = (iso: string) => coo.listItems(wp, 'open').some(i => i.itemId === w.id && Date.parse(i.at) >= Date.parse(iso) - 5_000) || manager.raisedSince(wp, w.id, iso);
  if (w.waitingOn === 'coo') {
    if (!sinceIso || !recent(sinceIso)) coo.notifyStall(wp, { itemId: w.id, title, body, by: w.employeeId ?? 'workplace' });
    return ['the COO'];
  }
  if (sinceIso && recent(sinceIso)) return [nameOf(wp, chiefOfStaffId(wp))];
  const r = manager.alert(wp, { key, itemId: w.id, title, body, text: ashaText, by: w.employeeId ?? 'workplace', ...(w.employeeId ? { subjectId: w.employeeId } : {}) });
  return [r === 'coo' ? 'the COO' : nameOf(wp, chiefOfStaffId(wp))];
}

/** (a) Entering a block on anyone but the owner. Once per block episode. */
function onBlocked(wp: Workplace, w: WorkItem): void {
  const since = sinceOf(w);
  if (readBlock(wp, w.id)?.since === since) return;
  put(wp, NOTIFY(w.id), JSON.stringify({ since, renotified: false } satisfies BlockRecord));
  const who = nameOf(wp, w.employeeId);
  const waiting = nameOf(wp, w.waitingOn);
  const reason = w.blockedReason ?? 'no reason given';
  const told = new Set<string>();
  if (w.waitingOn && w.waitingOn !== w.employeeId && tell(wp, w.waitingOn,
    `${who} is blocked on ${noun(w)} ${w.id} "${w.title}", waiting on you: ${reason}\n` +
    `If you can unblock it, do (or say when) with item_comment on ${w.id}; if you cannot, say why there.`)) told.add(w.waitingOn);
  const heard = report(wp, w, `blocked:${w.id}:${since}`, `Blocked: ${w.title}`, `${who} is blocked on ${w.id}, waiting on ${waiting}: ${reason}`,
    `${who} is blocked on ${noun(w)} ${w.id} "${w.title}", waiting on ${waiting}: ${reason}. Get it moving or tell the owner.`, since).filter(h => ![...told].some(t => nameOf(wp, t) === h));
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `Blocked on ${waiting}: told ${[...heard, ...[...told].map(t => nameOf(wp, t))].join(', ')}` });
}

/** (b) The deadline: still the same block, past `stallBlockedMinutes`, not yet re-told → tell Asha (or the COO, for a COO wait) again, once. */
export function check(wp: Workplace, id: string, nowMs = Date.now()): 'renotified' | null {
  const w = rawGet(wp, id);
  const rec = readBlock(wp, id);
  if (!w || !rec || !notOwnerBlock(w) || sinceOf(w) !== rec.since || rec.renotified) return null;
  const mins = wp.config.stallBlockedMinutes;
  if (nowMs < Date.parse(rec.since) + mins * MIN) return null;
  put(wp, NOTIFY(id), JSON.stringify({ ...rec, renotified: true } satisfies BlockRecord));
  const who = nameOf(wp, w.employeeId);
  const waiting = nameOf(wp, w.waitingOn);
  const reason = w.blockedReason ?? 'no reason given';
  const heard = report(wp, w, `still-blocked:${w.id}:${rec.since}`, `Still blocked: ${w.title}`, `${who} has been blocked on ${w.id} for ${mins} min, waiting on ${waiting}: ${reason}`,
    `${who} has been blocked on ${noun(w)} ${w.id} "${w.title}" for ${mins} min, waiting on ${waiting}: ${reason}. Get it moving or tell the owner.`);
  trail.record(wp, { itemId: id, by: 'workplace', kind: 'stall', text: `Still blocked after ${mins} min: told ${heard.join(', ')} again` });
  return 'renotified';
}

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Is `b` (blocked) waiting on `w`? Its id or title in the reason, or waiting on w's assignee in the same epic. */
export function blockedOn(wp: Workplace, b: WorkItem, w: WorkItem): boolean {
  if (b.id === w.id || b.status !== 'blocked') return false;
  const reason = b.blockedReason ?? '';
  if (reason.includes(w.id)) return true;
  const title = norm(baseTitle(wp, w.title));
  if (title.length >= 12 && ` ${norm(reason)} `.includes(` ${title} `)) return true;
  if (b.waitingOn && b.waitingOn === w.employeeId) {
    const eb = epicOf(wp, b)?.id;
    return !!eb && eb === epicOf(wp, w)?.id;
  }
  return false;
}

/** (c) An item arrived at In review or Done: wake whoever is blocked on it. Once per arrival. */
function onArrived(wp: Workplace, w: WorkItem): void {
  const arrival = `${w.status}:${w.statusSince ?? w.updatedAt}`;
  if (get(wp, DEP(w.id)) === arrival) return;
  put(wp, DEP(w.id), arrival);
  const blocked = (wp.db.prepare("select json from work where status = 'blocked'").all() as { json: string }[]).map(r => JSON.parse(r.json) as WorkItem);
  const state = w.status === 'done' ? 'Done' : 'In review';
  for (const b of blocked) {
    if (!b.employeeId || !isAgent(wp, b.employeeId) || !blockedOn(wp, b, w)) continue;
    // An explicit dependency (waitingOn the item, or startsAfter) is lifecycle-watch's: it flips and tells on the finish.
    if (b.waitingOn === w.id || b.startsAfter === w.id) continue;
    const how = tell(wp, b.employeeId,
      `${noun(w)} ${w.id} "${w.title}"${w.employeeId ? ` (${nameOf(wp, w.employeeId)})` : ''} is now ${state}. ` +
      `Your ${noun(b).toLowerCase()} ${b.id} "${b.title}" is blocked waiting on ${nameOf(wp, b.waitingOn)}: ${b.blockedReason ?? ''}\n` +
      `If this is what you were waiting for, unblock it (item_update ${b.id} status in-progress) and carry on; if not, leave it.`);
    trail.record(wp, { itemId: b.id, by: 'workplace', kind: 'note', text: `${w.title} is ${state}: ${how ? `told ${nameOf(wp, b.employeeId)}` : `could not reach ${nameOf(wp, b.employeeId)}`}` });
  }
}

export function onItem(wp: Workplace, id: string): void {
  const w = rawGet(wp, id);
  if (!w) return;
  if (notOwnerBlock(w)) onBlocked(wp, w);
  else if (w.status !== 'blocked' && readBlock(wp, id)) del(wp, NOTIFY(id));
  if (w.status === 'in-review' || (w.status === 'done' && (w.resolution ?? 'done') === 'done')) onArrived(wp, w);
}

/** Wire it: item changes, and a re-notify deadline per open block (re-armed at boot). Returns stop(). */
export function startBlockWatch(wp: Workplace): () => void {
  let stopped = false;
  const timers = new Map<string, NodeJS.Timeout>();
  const arm = (id: string): void => {
    const prev = timers.get(id);
    if (prev) { clearTimeout(prev); timers.delete(id); }
    const rec = readBlock(wp, id);
    if (stopped || !rec || rec.renotified) return;
    const delay = Math.max(0, Date.parse(rec.since) + wp.config.stallBlockedMinutes * MIN - Date.now()) + 25;
    const t = setTimeout(() => {
      timers.delete(id);
      if (stopped) return;
      try { check(wp, id); } catch (err) { log.warn('blocks', `${id}: ${err instanceof Error ? err.message : err}`); }
    }, Math.min(delay, 2 ** 31 - 1));
    t.unref?.();
    timers.set(id, t);
  };
  const off = wp.on(event => {
    if (event.type !== 'work.updated') return;
    const id = event.item.id;
    setImmediate(() => {
      if (stopped) return;
      try { onItem(wp, id); arm(id); } catch (err) { log.warn('blocks', `${id}: ${err instanceof Error ? err.message : err}`); }
    });
  });
  // Blocks older than this process (or this code) are not news to announce as new: they are recorded
  // as told, so a later save of the item does not set off (a); (b) still re-tells the COO once.
  for (const r of wp.db.prepare("select json from work where status = 'blocked'").all() as { json: string }[]) {
    const w = JSON.parse(r.json) as WorkItem;
    if (notOwnerBlock(w) && readBlock(wp, w.id)?.since !== sinceOf(w)) put(wp, NOTIFY(w.id), JSON.stringify({ since: sinceOf(w), renotified: false } satisfies BlockRecord));
  }
  for (const r of wp.db.prepare("select key from settings where key like 'block-notify:%'").all() as { key: string }[]) arm(r.key.slice('block-notify:'.length));
  return () => {
    stopped = true;
    off();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
