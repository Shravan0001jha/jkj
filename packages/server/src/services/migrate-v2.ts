import type { RoomThread, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as work from './work.js';
import * as room from './room.js';
import { newId, rowsJson } from './store.js';
import { chiefOfStaffId, qaLead, statusFromState } from './v2-map.js';
import { log } from '../util/logger.js';

/**
 * The one-time v2 migration (HLD D25, LLD §19.11). Non-destructive and idempotent: only rows with
 * no `level` are touched, only fields are added, every item's history is copied into activity
 * rows once, and nothing is deleted. Grouping into areas, merging duplicates and ruling on
 * never-started items are data operations done afterwards through the API.
 */

export interface MigrationReport {
  items: number;
  epics: number;
  stories: number;
  /** Blocked items the COO had parked, now Backlog. */
  parked: number;
  /** Review items with no reviewer, given one. */
  reviewersSet: number;
  /** Old states before. */
  byStatusBefore: Record<string, number>;
  /** v2 statuses after. */
  byStatusAfter: Record<string, number>;
}

/** Phase 1 held items in `blocked` only to stop the old routine auto-starting them: "parked by COO …", "held by COO until …". */
const PARKED = /\bpark|\bheld\b|\bhold/i;

export function migrateV2(wp: Workplace): MigrationReport {
  const report: MigrationReport = { items: 0, epics: 0, stories: 0, parked: 0, reviewersSet: 0, byStatusBefore: {}, byStatusAfter: {} };
  const legacy = rowsJson<WorkItem>(wp.db.prepare('select json from work where level is null order by created_at, rowid').all())
    .filter(w => !w.level);
  const qa = qaLead(wp);
  const cos = chiefOfStaffId(wp);
  const rank = new Map<string, number>();
  const nextRank = (key: string): number => { const r = (rank.get(key) ?? 0) + 1; rank.set(key, r); return r; };

  wp.db.exec('begin');
  try {
    for (const w of legacy) {
      report.items += 1;
      report.byStatusBefore[w.state] = (report.byStatusBefore[w.state] ?? 0) + 1;
      const level = w.kind === 'feature' ? 'epic' : 'story';
      if (level === 'epic') report.epics += 1; else report.stories += 1;
      const last = w.history.at(-1);
      const parked = w.state === 'blocked' && last?.by === 'coo' && PARKED.test(last.note ?? '');
      const next: WorkItem = { ...w, level, statusSince: w.updatedAt };
      if (level === 'story' && w.featureId) next.parentId = w.featureId;
      next.rank = nextRank(level === 'epic' ? `epic:${w.areaId ?? ''}` : `parent:${next.parentId ?? ''}`);
      if (parked) {
        next.status = 'backlog';
        next.state = 'proposed';
        next.history = [...w.history, { at: new Date().toISOString(), from: 'blocked', to: 'proposed', by: 'workplace', note: 'v2 migration: parked by the COO → Backlog' }];
        report.parked += 1;
      } else {
        const v2 = statusFromState(w, w.state);
        next.status = v2.status;
        if (v2.status === 'done') next.resolution = v2.resolution ?? 'done';
        if (v2.status === 'blocked') {
          next.blockedReason = last?.to === 'blocked' && last.note?.trim() ? last.note.trim() : 'No reason recorded before v2';
          next.waitingOn = 'coo';
          next.blockedSince = last?.to === 'blocked' ? last.at : w.updatedAt;
        }
        if (v2.status === 'in-review' && !w.reviewerId) {
          const reviewer = [qa, cos].find(r => r && r !== w.employeeId);
          if (reviewer) { next.reviewerId = reviewer; report.reviewersSet += 1; }
        }
      }
      report.byStatusAfter[next.status!] = (report.byStatusAfter[next.status!] ?? 0) + 1;
      work.saveQuiet(wp, next);
      // The item's history, once, as activity rows with their original time and author.
      for (const h of w.history) {
        const a = { id: newId('act'), at: h.at, itemId: w.id, by: h.by, kind: 'status' as const, ...(h.from ? { from: h.from } : {}), to: h.to, text: h.note ?? `${h.from ?? 'created'} → ${h.to}` };
        wp.db.prepare('insert into activity (id, at, item_id, by, kind, json) values (?, ?, ?, ?, ?, ?)').run(a.id, a.at, a.itemId, a.by, a.kind, JSON.stringify(a));
      }
    }
    // Threads made before rooms existed are in General.
    for (const t of rowsJson<RoomThread>(wp.db.prepare('select json from threads where room_id is null').all())) {
      if (t.roomId) continue;
      const moved: RoomThread = { ...t, roomId: 'general' };
      wp.db.prepare('update threads set room_id = ?, json = ? where id = ?').run('general', JSON.stringify(moved), t.id);
    }
    wp.db.exec('commit');
  } catch (err) {
    wp.db.exec('rollback');
    throw err;
  }
  room.ensureReleases(wp);
  if (report.items) {
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run('v2-migration', JSON.stringify({ at: new Date().toISOString(), ...report }));
    log.info('migrate', `v2: ${report.items} items (${report.epics} epics, ${report.stories} stories), ${report.parked} parked → Backlog, ${report.reviewersSet} reviewers set; before ${JSON.stringify(report.byStatusBefore)} after ${JSON.stringify(report.byStatusAfter)}`);
  }
  return report;
}
