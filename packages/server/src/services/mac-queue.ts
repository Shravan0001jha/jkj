import type { Workplace } from './workplace.js';
import type { Db } from './store.js';
import * as coo from './coo.js';
import * as employees from './employees.js';
import * as runs from './runs.js';
import * as trail from './trail.js';
import { newId, now } from './store.js';
import { rawGet } from './v2-map.js';
import { BadRequest, NotFound } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * The Mac queue (HLD §2 Services, LLD §W6.1): the owner's Mac goes to one employee at a time for a
 * live check, in the order asked, time-boxed. It replaces the COO's `window_queue.sh` loop and keeps
 * its rules: a request is granted only while the requester's session is on that story (7 Oct: a window
 * opened while Dev was on another story went unused), a request passed over six times expires, and
 * the grant is the existing guard window (`coo.openLiveWindow`), so the guard needs no change.
 *
 * Deterministic, no model. The sweep runs every 30 s from index.ts.
 */

export type MacRequestState = 'queued' | 'granted' | 'done' | 'expired';

export interface MacRequest {
  id: string;
  emp: string;
  itemId: string;
  minutes: number;
  why: string;
  /** When it was asked for. */
  at: string;
  state: MacRequestState;
  /** Times the Mac was free and this request was passed over (its requester was not on the story). */
  skips: number;
  grantedAt?: string;
  grantedBy?: string;
  /** The grant's end (ISO), as the guard window has it. */
  until?: string;
  endedAt?: string;
  endedReason?: string;
}

export const MAX_MINUTES = 45;
export const MAX_SKIPS = 6;

const ready = new WeakSet<Db>();

function db(wp: Workplace): Db {
  if (!ready.has(wp.db)) {
    wp.db.exec(`create table if not exists mac_queue (
      id text primary key,
      emp text not null,
      item_id text not null,
      minutes integer not null,
      why text not null,
      at text not null,
      state text not null,
      skips integer not null default 0,
      granted_at text,
      granted_by text,
      until text,
      ended_at text,
      ended_reason text
    )`);
    wp.db.exec('create index if not exists mac_queue_state on mac_queue(state)');
    ready.add(wp.db);
  }
  return wp.db;
}

interface Row { id: string; emp: string; item_id: string; minutes: number; why: string; at: string; state: MacRequestState; skips: number; granted_at: string | null; granted_by: string | null; until: string | null; ended_at: string | null; ended_reason: string | null }

const fromRow = (r: Row): MacRequest => ({
  id: r.id, emp: r.emp, itemId: r.item_id, minutes: r.minutes, why: r.why, at: r.at, state: r.state, skips: r.skips,
  ...(r.granted_at ? { grantedAt: r.granted_at } : {}),
  ...(r.granted_by ? { grantedBy: r.granted_by } : {}),
  ...(r.until ? { until: r.until } : {}),
  ...(r.ended_at ? { endedAt: r.ended_at } : {}),
  ...(r.ended_reason ? { endedReason: r.ended_reason } : {}),
});

const rows = (wp: Workplace, where: string, ...args: (string | number)[]): MacRequest[] =>
  (db(wp).prepare(`select * from mac_queue ${where}`).all(...args) as unknown as Row[]).map(fromRow);

export function get(wp: Workplace, id: string): MacRequest | undefined {
  const r = db(wp).prepare('select * from mac_queue where id = ?').get(id) as unknown as Row | undefined;
  return r ? fromRow(r) : undefined;
}

const queued = (wp: Workplace): MacRequest[] => rows(wp, "where state = 'queued' order by at, rowid");
const grantedRow = (wp: Workplace): MacRequest | undefined => rows(wp, "where state = 'granted' order by granted_at desc limit 1")[0];

/** GET /api/mac-queue: who holds the Mac and who waits, in order. */
export function list(wp: Workplace): { active: MacRequest | null; queue: MacRequest[] } {
  return { active: grantedRow(wp) ?? null, queue: queued(wp) };
}

/** Every request, newest first (the last 100). */
export function history(wp: Workplace): MacRequest[] {
  return rows(wp, 'order by at desc, rowid desc limit 100');
}

const positionOf = (wp: Workplace, id: string): number => queued(wp).findIndex(r => r.id === id) + 1;

/**
 * request_mac: queue a request for the Mac. One open request per person and story: asking again
 * returns the one already queued (or granted) instead of a second.
 */
export function request(wp: Workplace, spec: { emp: string; itemId: string; minutes: number; why: string }): { request: MacRequest; position: number; existing: boolean } {
  const minutes = Math.round(Number(spec.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) throw new BadRequest(`minutes must be between 1 and ${MAX_MINUTES}.`);
  const why = (spec.why ?? '').trim();
  if (!why) throw new BadRequest('Say why you need the Mac (what you will check on it).');
  if (!rawGet(wp, spec.itemId)) throw new NotFound(`No item ${spec.itemId}`);
  const open = rows(wp, "where emp = ? and item_id = ? and state in ('queued', 'granted')", spec.emp, spec.itemId)[0];
  if (open) return { request: open, position: open.state === 'granted' ? 0 : positionOf(wp, open.id), existing: true };
  const r: MacRequest = { id: newId('mq'), emp: spec.emp, itemId: spec.itemId, minutes, why, at: now(), state: 'queued', skips: 0 };
  db(wp).prepare('insert into mac_queue (id, emp, item_id, minutes, why, at, state, skips) values (?, ?, ?, ?, ?, ?, ?, 0)').run(r.id, r.emp, r.itemId, r.minutes, r.why, r.at, r.state);
  trail.record(wp, { itemId: r.itemId, by: r.emp, kind: 'note', text: `asked for the Mac: ${minutes} min (${why.slice(0, 80)})` });
  return { request: r, position: positionOf(wp, r.id), existing: false };
}

function end(wp: Workplace, r: MacRequest, state: 'done' | 'expired', reason: string): void {
  db(wp).prepare('update mac_queue set state = ?, ended_at = ?, ended_reason = ? where id = ?').run(state, now(), reason, r.id);
  if (r.state === 'granted') {
    coo.closeLiveWindow(wp, r.emp);
    employees.refreshLiveWindow(wp, r.emp, null);
  }
}

/**
 * release_mac: the caller's grant ends now. With no grant, their queued requests are withdrawn.
 * Returns what ended, or null when there was nothing.
 */
export function release(wp: Workplace, emp: string): { ended: MacRequest; was: 'granted' | 'queued' }[] {
  const mine = rows(wp, "where emp = ? and state in ('granted', 'queued') order by at", emp);
  const granted = mine.filter(r => r.state === 'granted');
  const ending = granted.length ? granted : mine;
  for (const r of ending) end(wp, r, 'done', r.state === 'granted' ? 'released' : 'withdrawn');
  return ending.map(r => ({ ended: r, was: r.state as 'granted' | 'queued' }));
}

/** The session the message goes to: the one on the story, else the person's open session. */
function tell(wp: Workplace, emp: string, itemId: string, text: string): void {
  try { trail.comment(wp, itemId, { by: 'workplace', text }); } catch (err) { log.warn('mac-queue', `comment on ${itemId}: ${err instanceof Error ? err.message : err}`); }
  const s = employees.sessionsOf(emp).find(x => employees.isLive(x.agentId) && x.assignmentId === itemId) ?? employees.openSession(emp);
  if (!s) return;
  try { runs.sendMessage(s.agentId, text, [], { from: 'workplace' }); } catch (err) { log.warn('mac-queue', `message to ${emp}: ${err instanceof Error ? err.message : err}`); }
}

const PROFILE_RULE = 'Use a throwaway --user-data-dir build (lease_test_account gives you one); never the owner\'s profile or /Applications/Iris.app.';

function grant(wp: Workplace, r: MacRequest, by: string): MacRequest {
  const window = coo.openLiveWindow(wp, r.emp, r.minutes);
  employees.refreshLiveWindow(wp, r.emp, Date.parse(window.until));
  const grantedAt = now();
  db(wp).prepare("update mac_queue set state = 'granted', granted_at = ?, granted_by = ?, until = ? where id = ?").run(grantedAt, by, window.until, r.id);
  const ends = new Date(window.until).toISOString().slice(11, 16);
  tell(wp, r.emp, r.itemId, `@${r.emp} The Mac is open for you now: ${r.minutes} min (until ${ends} UTC) for ${r.itemId}. ${PROFILE_RULE} Call release_mac as soon as you are done so the next person gets it.`);
  log.info('mac-queue', `granted ${r.emp} ${r.minutes} min for ${r.itemId} (${by})`);
  return get(wp, r.id)!;
}

/**
 * An approved story held at the merge gate for its live check (11 Oct, gap #20): it is Done, so nobody is
 * ever "on" it and its author's request would never be granted. The author with any open session qualifies.
 */
function awaitingLiveCheck(wp: Workplace, emp: string, itemId: string): boolean {
  const w = rawGet(wp, itemId);
  // Any open, unmerged story of theirs (11 Oct: Arjun's in-review story expired 6x: his session was a mention
  // session on a general branch, and the story was waiting on exactly this live check).
  return !!w && w.employeeId === emp && (w.status !== 'done' || (!!w.pr && !w.pr.merged)) && !w.mergedInto;
}

/**
 * The 30-second sweep. Ends grants whose window ran out; then, if nothing holds the Mac (no grant and
 * no window the COO opened by hand), grants the first queued request whose requester has a live
 * session on that story. Requests passed over while the Mac was free count a skip; the sixth expires.
 */
export function sweep(wp: Workplace, nowMs = Date.now(), hasLiveSession: (emp: string, itemId: string) => boolean = employees.sessionOn, hasAnySession: (emp: string) => boolean = emp => !!employees.openSession(emp)): { granted?: string; expired: string[]; done: string[] } {
  const out: { granted?: string; expired: string[]; done: string[] } = { expired: [], done: [] };
  for (const r of rows(wp, "where state = 'granted'")) {
    const until = r.until ? Date.parse(r.until) : NaN;
    if (Number.isFinite(until) && until > nowMs) continue;
    end(wp, r, 'done', 'time up');
    out.done.push(r.id);
    tell(wp, r.emp, r.itemId, `@${r.emp} Your Mac time for ${r.itemId} is up; the Mac goes to the next person. Ask again with request_mac if you need more.`);
  }
  if (grantedRow(wp) || coo.openLiveWindows(wp, nowMs).length) return out;
  for (const r of queued(wp)) {
    if (hasLiveSession(r.emp, r.itemId) || (awaitingLiveCheck(wp, r.emp, r.itemId) && hasAnySession(r.emp))) {
      out.granted = grant(wp, r, 'queue').id;
      break;
    }
    const skips = r.skips + 1;
    if (skips >= MAX_SKIPS) {
      db(wp).prepare('update mac_queue set skips = ? where id = ?').run(skips, r.id);
      end(wp, { ...r, skips }, 'expired', `passed over ${skips} times: no session on the story`);
      out.expired.push(r.id);
      tell(wp, r.emp, r.itemId, `@${r.emp} Your request for the Mac (${r.itemId}) expired: it came up ${skips} times while you were not working on that story. Call request_mac again when you are on it.`);
    } else {
      db(wp).prepare('update mac_queue set skips = ? where id = ?').run(skips, r.id);
    }
  }
  return out;
}

/**
 * POST /api/mac-queue/:id/grant: the owner or the COO hands the Mac over now, session or not. A grant
 * already running is ended first (one person on the Mac at a time) and its holder is told why.
 */
export function grantNow(wp: Workplace, id: string, by: 'owner' | 'coo'): MacRequest {
  const r = get(wp, id);
  if (!r) throw new NotFound(`No Mac request ${id}`);
  if (r.state === 'granted') return r;
  if (r.state !== 'queued') throw new BadRequest(`${id} is ${r.state}; ask again with request_mac.`);
  const current = grantedRow(wp);
  if (current) {
    end(wp, current, 'done', `taken over by ${by}`);
    tell(wp, current.emp, current.itemId, `@${current.emp} The ${by === 'owner' ? 'owner' : 'COO'} gave the Mac to ${r.emp} now, so your Mac time for ${current.itemId} ended early. Ask again with request_mac.`);
  }
  return grant(wp, r, by);
}
