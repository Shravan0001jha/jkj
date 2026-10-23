import type { AwaitingMac, Item, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import { BadRequest } from '../util/errors.js';
import { rawGet } from './v2-map.js';
import { rowsJson } from './store.js';

/**
 * "Done on staging, awaiting Mac check" (owner rule, 23 Oct): the one Mac verification queue, and the COO's
 * closing and adopting moves. The state itself lives in items.update (status awaiting-mac).
 */
export type QueueEntry = items.AwaitingEntry;

const open = items.awaitingOpen;

/** Oldest first. */
export const list = (wp: Workplace): QueueEntry[] => items.awaitingQueue(wp);

export interface CloseRequest { result: 'pass' | 'fail'; note: string }

/** Close one from the queue: pass -> done with the evidence; fail -> back to in-progress with the failure note (and a bug). */
export function close(wp: Workplace, id: string, req: CloseRequest, by: string): Item {
  if (req.result !== 'pass' && req.result !== 'fail') throw new BadRequest('result must be pass or fail');
  if (typeof req.note !== 'string' || req.note.trim().length < 10) {
    throw new BadRequest(req.result === 'pass' ? 'Closing from the Mac queue needs evidence: say what you ran on the Mac and saw (log lines, a slot id).' : 'A failed Mac check needs a note saying what failed.');
  }
  const w = rawGet(wp, id);
  if (!w || !open(w)) throw new BadRequest(`${id} is not awaiting a Mac check.`);
  return items.update(wp, id, { status: req.result === 'pass' ? 'done' : 'in-progress', note: req.note.trim() }, by);
}

export interface AdoptResult { moved: string[]; failed: { id: string; error: string }[] }

/** One-shot (COO): move existing parked/merged Mac-check stories to awaiting-mac, each with the same note. */
export function adopt(wp: Workplace, ids: string[], note: string, by = 'coo'): AdoptResult {
  const out: AdoptResult = { moved: [], failed: [] };
  for (const id of ids) {
    try {
      const w = rawGet(wp, id);
      if (!w) throw new BadRequest(`No item ${id}`);
      if (open(w)) { out.moved.push(id); continue; }
      items.adoptAwaitingMac(wp, id, note, by);
      out.moved.push(id);
    } catch (err) { out.failed.push({ id, error: err instanceof Error ? err.message : String(err) }); }
  }
  return out;
}

export type { AwaitingMac };
