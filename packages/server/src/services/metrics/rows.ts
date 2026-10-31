/** LLD-dashboard §1: read the Workplace's own records into plain rows (read-only). No agent-typed number is used. */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Rows, EpicRow, StoryRow } from './snapshot.js';
import type { Span } from './causes.js';

const DAY = 86_400_000;
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** "parked until Sat, 09:30 pm IST" → the next Saturday 16:00 UTC at or after `from`. */
export function paceHoldEnd(title: string, from: number): number {
  const m = /until (Sun|Mon|Tue|Wed|Thu|Fri|Sat)/.exec(title);
  if (!m) return from + DAY;
  const target = WEEKDAY[m[1]!]!;
  for (let d = 0; d < 8; d++) {
    const t = new Date(from + d * DAY);
    const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 16, 0, 0);
    if (t.getUTCDay() === target && end > from) return end;
  }
  return from + DAY;
}

/** Runs of "staging not running" / "deferred" lines in staging-follow-trunk.log become spans. */
export function stagingDownSpans(log: string): Span[] {
  const spans: Span[] = [];
  let open: number | null = null, last = 0;
  for (const line of log.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    const down = /staging not running|deferred|FAILED/.test(m[2]!);
    if (down) {
      if (open === null || at - last > 30 * 60_000) { if (open !== null) spans.push({ from: open, to: last + 11 * 60_000 }); open = at; }
      last = at;
    } else if (open !== null) { spans.push({ from: open, to: at }); open = null; }
  }
  if (open !== null) spans.push({ from: open, to: last + 11 * 60_000 });
  return spans;
}

export interface ReleaseInput { repo: string; prodSha: string | null; stagingSha: string | null; orgYaml?: string }

/** Every commit reachable from `sha` in `repo` (empty when the commit is unknown). */
function ancestors(repo: string, sha: string | null): Set<string> {
  if (!sha) return new Set();
  try {
    return new Set(execFileSync('git', ['-C', repo, 'rev-list', sha], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean));
  } catch { return new Set(); }
}

/** The last trunk commit the batch deployed to staging, from its own log. */
export function lastStagingSha(log: string): string | null {
  const m = [...log.matchAll(/batch deployed trunk ([0-9a-f]{7,40}) to staging/g)].at(-1);
  return m ? m[1]! : null;
}

export function loadRows(dbPath: string, stagingLogPath: string | null, now = Date.now(), rel?: ReleaseInput): Rows {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const all = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as T[];

    const epics: EpicRow[] = all<{ id: string; json: string }>("select id, json from work where level = 'epic'").map(r => {
      const j = JSON.parse(r.json);
      const hist = all<{ json: string }>("select json from activity where item_id = ? and kind = 'field' order by seq", r.id)
        .map(a => JSON.parse(a.json)).filter(a => a.text === 'targetDate changed')
        .map(a => ({ at: ms(a.at), from: a.from || null, to: a.to || null }));
      return { id: r.id, title: j.title, status: j.status, statusSince: ms(j.statusSince ?? j.updatedAt), targetDate: j.targetDate ?? null, createdAt: ms(j.createdAt), targetHistory: hist };
    });
    const epicIds = new Set(epics.map(e => e.id));

    const stories: StoryRow[] = [];
    const devApprovals: Record<string, number> = {};
    const startsAfter: Record<string, string> = {};
    const prTimes: Rows['prTimes'] = {};
    for (const r of all<{ id: string; json: string; parent_id: string | null }>("select id, json, parent_id from work where level in ('story','task')")) {
      const j = JSON.parse(r.json);
      const epicId = r.parent_id && epicIds.has(r.parent_id) ? r.parent_id : j.featureId && epicIds.has(j.featureId) ? j.featureId : null;
      if (!epicId) continue;
      stories.push({ id: r.id, epicId, title: j.title, status: j.status, employeeId: j.employeeId ?? null, charterId: j.charterId ?? null, createdAt: ms(j.createdAt), type: j.type ?? null, createdBy: j.history?.[0]?.by ?? null, mergedSha: j.pr?.merged?.sha ?? null });
      if (j.pr?.devApproval?.at) devApprovals[r.id] = ms(j.pr.devApproval.at);
      if (j.pr?.pushedAt) prTimes[r.id] = { pushedAt: ms(j.pr.pushedAt), devAt: j.pr.devApproval?.at ? ms(j.pr.devApproval.at) : null, qaAt: j.pr.qaApproval?.at ? ms(j.pr.qaApproval.at) : null };
      if (j.startsAfter) startsAfter[r.id] = String(j.startsAfter);
    }
    const storyIds = new Set(stories.map(s => s.id));

    const transitions: Rows['transitions'] = [];
    const notes: Rows['notes'] = [];
    for (const a of all<{ item_id: string; kind: string; json: string }>("select item_id, kind, json from activity where kind in ('status','note','stall','comment') order by seq")) {
      if (!storyIds.has(a.item_id)) continue;
      const j = JSON.parse(a.json);
      if (a.kind === 'status') transitions.push({ itemId: a.item_id, at: ms(j.at), from: j.from ?? null, to: j.to });
      else notes.push({ itemId: a.item_id, at: ms(j.at), text: String(j.text ?? '').slice(0, 400) });
    }

    // Holds and caps from the Workplace's own COO events.
    const holds: Span[] = [], caps: Span[] = [];
    let pausedAt: number | null = null;
    for (const r of all<{ json: string }>("select json from coo_items where kind = 'stall' order by created_at")) {
      const j = JSON.parse(r.json);
      const at = ms(j.at);
      if (j.itemId === 'floor') {
        if (/paused/i.test(j.title)) pausedAt ??= at;
        else if (/resumed/i.test(j.title) && pausedAt !== null) { holds.push({ from: pausedAt, to: at }); pausedAt = null; }
      } else if (j.itemId === 'weekly-pace') holds.push({ from: at, to: paceHoldEnd(j.title, at) });
      else if (j.itemId === 'daily-spend-cap') caps.push({ from: at, to: at + DAY });
    }
    if (pausedAt !== null) holds.push({ from: pausedAt, to: now });

    const inbox: Rows['inbox'] = all<{ created_at: string; json: string }>('select created_at, json from inbox').map(r => {
      const j = JSON.parse(r.json);
      const answered = j.answer?.at ?? null;
      const ctx = j.context ?? {};
      const refs = [ctx.itemId, ctx.assignmentId, ctx.featureId, ...(Array.isArray(ctx.itemIds) ? ctx.itemIds : [])].filter(Boolean).map(String);
      return { createdAt: ms(r.created_at), answeredAt: answered ? ms(answered) : (j.state === 'open' ? null : ms(j.updatedAt ?? r.created_at)), refs };
    });

    const costByStory: Record<string, number> = {};
    for (const r of all<{ assignment_id: string; inr: number }>(
      'select s.assignment_id as assignment_id, sum(u.equivalent_inr) as inr from usage u join sessions s on s.id = u.session_id where s.assignment_id is not null group by s.assignment_id')) {
      if (storyIds.has(r.assignment_id)) costByStory[r.assignment_id] = r.inr ?? 0;
    }

    const stagingLog = stagingLogPath && existsSync(stagingLogPath) ? readFileSync(stagingLogPath, 'utf8') : '';
    const stagingDown = stagingLog ? stagingDownSpans(stagingLog) : [];

    // Release stage of each merged story: is its merge commit inside what prod / staging run?
    const stage: Record<string, 'prod' | 'staging' | 'merged'> = {};
    let release: Rows['release'] = { prodSha: null, stagingSha: null };
    if (rel) {
      const resolve = (sha: string | null) => { if (!sha) return null; try { return execFileSync('git', ['-C', rel.repo, 'rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim(); } catch { return null; } };
      const prodSha = resolve(rel.prodSha), stagingSha = resolve(rel.stagingSha ?? lastStagingSha(stagingLog));
      const onProd = ancestors(rel.repo, prodSha), onStaging = ancestors(rel.repo, stagingSha);
      for (const s of stories) {
        if (s.status !== 'done' || !s.mergedSha) continue;
        stage[s.id] = onProd.has(s.mergedSha) ? 'prod' : onStaging.has(s.mergedSha) ? 'staging' : 'merged';
      }
      release = { prodSha, stagingSha };
    }
    const dailyInr = all<{ day: string; inr: number }>("select day, sum(equivalent_inr) as inr from usage group by day order by day desc limit 42").reverse();
    const paceRow = all<{ value: string }>("select value from settings where key = 'pace:last'")[0];
    const pace = paceRow ? (() => { const j = JSON.parse(paceRow.value); return { utilization: j.utilization, allowance: j.allowance, resetsAtMs: j.resetsAtMs, dayIndex: j.dayIndex }; })() : null;
    const qaIds = rel?.orgYaml && existsSync(rel.orgYaml)
      ? [...readFileSync(rel.orgYaml, 'utf8').matchAll(/- id: ([\w-]+)\n(?:[^\n]*\n){0,3}?\s*roleId: qa\b/g)].map(m => m[1]!)
      : [];
    return { now, epics, stories, transitions, holds, caps, stagingDown, notes, inbox, costByStory, devApprovals, startsAfter, prTimes, stage, release, dailyInr, pace, qaIds };
  } finally {
    db.close();
  }
}
