import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as items from './items.js';
import * as trail from './trail.js';
import * as waits from './waits.js';
import { isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * Handoffs (owner, 2 Oct; LLD §19.6c). A wait on a teammate's work is not a block: `items.update`
 * hands the item to them (In progress, `handoff` on the item). This wakes them, once per handoff:
 * a message into their open session, else a session started on that item. `item_handback` returns
 * the item to whoever handed it; that wakes them the same way, once per handback.
 *
 * Records in settings: `handoff-wake:<itemId>` = `handoff.at`, `handback-wake:<itemId>` = `handedBack.at`.
 * The boot migration (`migrateBlockedWaits`) turns Blocked-on-a-teammate items left from before this
 * rule into reviews or handoffs.
 */

const HANDOFF = (id: string): string => `handoff-wake:${id}`;
const BACK = (id: string): string => `handback-wake:${id}`;

const get = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const put = (wp: Workplace, key: string, value: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
const del = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);

const noun = (w: WorkItem): string => (levelOf(w) === 'task' ? 'Task' : levelOf(w) === 'epic' ? 'Epic' : 'Story');

export function handoffPrompt(wp: Workplace, w: WorkItem): string {
  const from = nameOf(wp, w.handoff!.fromId);
  return `${from} handed you ${noun(w)} ${w.id} "${w.title}" and is waiting on you: ${w.handoff!.reason}\n` +
    `Do what is needed (status_of ${w.id} for the item; progress as item_comment on it). When it is done, call item_handback ` +
    `on ${w.id} with a short note of what you did: it goes back to ${from === 'you' ? 'the owner' : from}. ` +
    'If you in turn need a teammate, hand it on the same way (item_update status blocked, waitingOn them); never leave it Blocked on a teammate.';
}

export function handbackPrompt(wp: Workplace, w: WorkItem): string {
  const b = w.handedBack!;
  return `${nameOf(wp, b.byId)} handed ${noun(w)} ${w.id} "${w.title}" back to you: ${b.note}\n` +
    `It is yours again and In progress: carry on with it (status_of ${w.id}).`;
}

/** Message the open session, else start a session on the item. Returns how, or null when neither could be done now. */
function wake(wp: Workplace, employeeId: string, w: WorkItem, text: string): 'message' | 'session' | null {
  if (!isAgent(wp, employeeId)) return null;
  const open = employees.openSession(employeeId);
  try {
    if (open) { runs.sendMessage(open.agentId, text, [], { from: 'workplace' }); return 'message'; }
    employees.spawn(wp, employeeId, { assignment: w, prompt: text });
    return 'session';
  } catch (err) {
    log.warn('handoff', `${w.id}: cannot reach ${employeeId} yet: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

const how = (wp: Workplace, who: string, h: 'message' | 'session' | null): string =>
  h === 'message' ? `told ${nameOf(wp, who)} in the open session` : h === 'session' ? `a session started for ${nameOf(wp, who)} on it` : `could not reach ${nameOf(wp, who)} yet (busy or at a cap); the stall watch follows it up`;

/** An item changed: wake the one it was handed to, or handed back to; once each. */
export function onItem(wp: Workplace, id: string): void {
  const w = rawGet(wp, id);
  if (!w) return;
  if (w.handedBack && get(wp, BACK(id)) !== w.handedBack.at) {
    put(wp, BACK(id), w.handedBack.at);
    // The handoff now open again (a nested one unwinding) is not news to its holder: they just got it back.
    if (w.handoff) put(wp, HANDOFF(id), w.handoff.at);
    const to = w.handedBack.toId;
    if (to === w.employeeId && w.status !== 'done' && isAgent(wp, to)) {
      trail.record(wp, { itemId: id, by: 'workplace', kind: 'note', text: `Handed back: ${how(wp, to, wake(wp, to, w, handbackPrompt(wp, w)))}` });
    }
  }
  if (!w.handoff || w.status === 'done') { if (get(wp, HANDOFF(id))) del(wp, HANDOFF(id)); return; }
  if (get(wp, HANDOFF(id)) === w.handoff.at || !w.employeeId) return;
  put(wp, HANDOFF(id), w.handoff.at);
  if (!isAgent(wp, w.employeeId)) return;
  trail.record(wp, { itemId: id, by: 'workplace', kind: 'note', text: `Handoff: ${how(wp, w.employeeId, wake(wp, w.employeeId, w, handoffPrompt(wp, w)))}` });
}

/**
 * Blocked items waiting on a teammate, left from before the rule (or written by an old path), are
 * re-applied through the classification: reviews → In review, the rest → handoffs. Idempotent.
 * Returns the ids it converted.
 */
export function migrateBlockedWaits(wp: Workplace): string[] {
  const out: string[] = [];
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'blocked'").all())) {
    if (levelOf(w) === 'epic' || !w.waitingOn) continue;
    if (waits.classify(wp, { assigneeId: w.employeeId, waitingOn: w.waitingOn, reason: w.blockedReason }) === 'block') continue;
    try {
      const it = items.update(wp, w.id, { status: 'blocked', blockedReason: w.blockedReason ?? 'No reason given', waitingOn: w.waitingOn }, 'workplace', { rewait: true });
      if (it.status !== 'blocked') out.push(w.id);
    } catch (err) {
      log.warn('handoff', `migrate ${w.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (out.length) log.info('handoff', `converted ${out.length} blocked-on-a-teammate item(s): ${out.join(', ')}`);
  return out;
}

/** Wire it: item changes; and, at start, any handoff or handback nobody was woken for (a restart, the migration). */
export function startHandoffWatch(wp: Workplace): () => void {
  let stopped = false;
  const later = (fn: () => void): void => {
    setImmediate(() => {
      if (stopped) return;
      try { fn(); } catch (err) { log.warn('handoff', err instanceof Error ? err.message : String(err)); }
    });
  };
  const off = wp.on(event => {
    if (event.type === 'work.updated') { const id = event.item.id; later(() => onItem(wp, id)); }
  });
  later(() => {
    const rows = rowsJson<WorkItem>(wp.db.prepare("select json from work where json_extract(json, '$.handoff') is not null or json_extract(json, '$.handedBack') is not null").all());
    for (const w of rows) onItem(wp, w.id);
  });
  return () => {
    stopped = true;
    off();
  };
}
