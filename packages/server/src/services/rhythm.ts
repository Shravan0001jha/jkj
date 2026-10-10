import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as trail from './trail.js';
import * as room from './room.js';
import * as inbox from './inbox.js';
import * as proposals from './proposals.js';
import * as costWatch from './cost-watch.js';
import { rowsJson } from './store.js';
import { chiefOfStaffId, levelOf, nameOf, rawGet } from './v2-map.js';
import { log } from '../util/logger.js';

/**
 * Asha's rhythm (HLD D24, LLD §19.7): the 09:30 brief, the 10:00 stand-up in General and the
 * Sunday review, compiled from the plan (no model, so nothing is invented). `maybeRun` is called
 * every minute and does each thing once per IST day.
 */

const DAY = 24 * 60 * 60_000;
const IST_OFFSET = 5.5 * 60 * 60_000;

export function istParts(ms: number): { day: string; minutes: number; dow: number } {
  const d = new Date(ms + IST_OFFSET);
  return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

const rows = (wp: Workplace): WorkItem[] => rowsJson<WorkItem>(wp.db.prepare('select json from work order by coalesce(rank, 0), created_at').all());
const within = (iso: string | undefined, from: number, to: number): boolean => { const t = iso ? Date.parse(iso) : NaN; return t > from && t <= to; };
const shipped = (w: WorkItem): boolean => w.status === 'done' && (w.resolution ?? 'done') === 'done';
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const who = (wp: Workplace, id: string | undefined): string => { const n = nameOf(wp, id); return n === 'you' ? 'You' : n; };

export function buildBrief(wp: Workplace, nowMs = Date.now()): { line: string; details: string } {
  const all = rows(wp);
  const done = all.filter(w => levelOf(w) === 'story' && shipped(w) && within(w.statusSince, nowMs - DAY, nowMs));
  const blocked = all.filter(w => levelOf(w) !== 'epic' && w.status === 'blocked');
  const decisions = inbox.ownerList(wp, 'open');
  const focus = items.getFocus(wp).epicIds.map(id => rawGet(wp, id)).filter((x): x is WorkItem => !!x);
  const focusWork = all.filter(w => w.status === 'in-progress' && levelOf(w) !== 'epic' && items.inFocus(wp, w));
  const line = `Brief: ${done.length} done since yesterday · focus: ${focus.map(f => f.title).join(', ') || 'none set'} · ${blocked.length} blocked · ${plural(decisions.length, 'decision')} wait${decisions.length === 1 ? 's' : ''} on you`;
  const section = (title: string, list: string[]): string => `${title}\n${list.length ? list.map(l => `- ${l}`).join('\n') : '- nothing'}`;
  const details = [
    section('Done since yesterday', done.map(w => `${w.title} — ${who(wp, w.employeeId)}`)),
    section('In progress on the focus', focusWork.map(w => `${w.title} — ${who(wp, w.employeeId)}`)),
    section('Blocked', blocked.map(w => `${w.title} — waiting on ${who(wp, w.waitingOn)}: ${w.blockedReason ?? 'no reason given'}`)),
    section('Decisions waiting on you', decisions.map(i => i.title)),
  ].join('\n\n');
  return { line, details };
}

/** One lead's stand-up, three lines; null when there is nothing to say. */
export function buildStandup(wp: Workplace, employeeId: string, nowMs = Date.now()): string | null {
  const mine = rows(wp).filter(w => w.employeeId === employeeId && levelOf(w) !== 'epic');
  const done = mine.filter(w => shipped(w) && within(w.statusSince, nowMs - DAY, nowMs));
  const doing = mine.filter(w => w.status === 'in-progress');
  const ready = mine.filter(w => w.status === 'ready');
  const blocked = mine.filter(w => w.status === 'blocked');
  if (!done.length && !doing.length && !blocked.length) return null;
  const next = doing.length ? doing.map(w => w.title).join(', ') : ready.length ? `${ready[0]!.title} (ready)` : 'nothing in progress';
  return [
    `Done: ${done.map(w => w.title).join(', ') || 'nothing'}`,
    `Next: ${next}`,
    `Blocked: ${blocked.map(w => `${w.title} (waiting on ${who(wp, w.waitingOn)})`).join(', ') || 'nothing'}`,
  ].join('\n');
}

export interface WeeklyNumbers { pointsShipped: number; reopened: number; stalls: number; spendInr: number; hiresProposed: number }

export function buildWeeklyReview(wp: Workplace, nowMs = Date.now()): { line: string; details: string; numbers: WeeklyNumbers } {
  const since = nowMs - 7 * DAY;
  const sinceIso = new Date(since).toISOString();
  const shippedStories = rows(wp).filter(w => levelOf(w) === 'story' && shipped(w) && within(w.statusSince, since, nowMs));
  const pointsShipped = shippedStories.reduce((n, w) => n + (w.points ?? 0), 0);
  const acts = trail.activitySince(wp, sinceIso).filter(a => Date.parse(a.at) <= nowMs);
  // A false "done": reopened after done, or sent back from review.
  const reopenedRows = acts.filter(a => a.kind === 'reopen' || (a.kind === 'status' && a.from === 'in-review' && a.to === 'in-progress'));
  const reopened = new Set(reopenedRows.map(a => a.itemId)).size;
  const stalls = acts.filter(a => a.kind === 'stall').length;
  const spendInr = Math.round(((wp.db.prepare("select coalesce(sum(inr), 0) as s from spend where at >= ? and coalesce(source, '') != 'subscription'").get(sinceIso) as { s: number }).s) * 100) / 100;
  const hires = proposals.list(wp).filter(p => p.kind === 'hire' && p.state === 'pending');
  const numbers: WeeklyNumbers = { pointsShipped, reopened, stalls, spendInr, hiresProposed: hires.length };
  const line = `Week: ${plural(pointsShipped, 'point')} shipped · ${reopened} reopened after a false done · ${plural(stalls, 'stall')} · ₹${Math.round(spendInr)} real spend · ${plural(hires.length, 'hire')} proposed`;
  const details = [
    `Shipped:\n${shippedStories.map(w => `- ${w.title} — ${who(wp, w.employeeId)}${w.points ? `, ${w.points} pts` : ''}`).join('\n') || '- nothing'}`,
    `Reopened:\n${[...new Set(reopenedRows.map(a => a.itemId))].map(id => `- ${rawGet(wp, id ?? '')?.title ?? id}`).join('\n') || '- nothing'}`,
    `Hires proposed:\n${hires.map(p => `- ${p.reason}`).join('\n') || '- none'}`,
  ].join('\n\n');
  return { line, details, numbers };
}

const doneKey = (kind: string, day: string): string => `rhythm:${kind}:${day}`;
const ranToday = (wp: Workplace, kind: string, day: string): boolean => !!wp.db.prepare('select 1 from settings where key = ?').get(doneKey(kind, day));
const markRan = (wp: Workplace, kind: string, day: string): void => { wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(doneKey(kind, day), new Date().toISOString()); };

export const BRIEF_AT = 9 * 60 + 30;
export const STANDUP_AT = 10 * 60;
export const REVIEW_AT = 18 * 60;

/** Called every minute: whatever is due today and not yet done. Returns what ran. */
export function maybeRun(wp: Workplace, nowMs = Date.now()): string[] {
  const { day, minutes, dow } = istParts(nowMs);
  const ran: string[] = [];
  const asha = chiefOfStaffId(wp) ?? 'workplace';
  if (minutes >= BRIEF_AT && !ranToday(wp, 'brief', day)) {
    markRan(wp, 'brief', day);
    const b = buildBrief(wp, nowMs);
    trail.postUpdate(wp, { kind: 'brief', line: b.line, details: b.details, by: asha, href: 'plan' });
    ran.push('brief');
  }
  if (minutes >= STANDUP_AT && !ranToday(wp, 'standup', day)) {
    markRan(wp, 'standup', day);
    const general = room.ensureGeneral(wp);
    for (const e of wp.org.employees.filter(x => !x.virtual)) {
      const text = buildStandup(wp, e.id, nowMs);
      if (text) room.postLine(wp, general.id, { text, kind: 'standup', about: e.id });
    }
    ran.push('standup');
  }
  if (dow === 0 && minutes >= REVIEW_AT && !ranToday(wp, 'review', day)) {
    markRan(wp, 'review', day);
    const r = buildWeeklyReview(wp, nowMs);
    trail.postUpdate(wp, { kind: 'review', line: r.line, details: r.details, by: asha, href: 'plan' });
    ran.push('review');
  }
  // The GitHub cost watcher (LLD-rework §W6.3): from 09:00 IST, once a day; it keeps its own once-a-day mark.
  void costWatch.maybeRun(wp, nowMs).catch(err => log.warn('cost-watch', String(err)));
  if (ran.length) log.info('rhythm', `${day}: ${ran.join(', ')}`);
  return ran;
}
