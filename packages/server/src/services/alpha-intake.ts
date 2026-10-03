import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as manager from './manager.js';
import { log } from '../util/logger.js';

/**
 * Alpha intake (owner, 3 Oct): bugs that the alpha triager confirms come into the Workplace queue
 * on their own. The alpha backend lives in AWS and the Workplace on the owner's Mac, which nothing
 * outside can reach, so the Workplace PULLS: every 2 minutes it asks for newly triaged bugs, files
 * each one as a story under the Bug bash epic, and tells the backend the story id. When the story
 * is done, it reports the fix back, which turns the testers' points final and emails them.
 *
 * Config: <workplace dir>/alpha.json {apiBase, token}. No file means intake is off.
 */

export interface AlphaBug {
  id: string; title: string; summary?: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; severity?: string;
  platforms?: string[]; affected_testers?: string[]; evidence?: { report_id: string; urls?: string[] }[];
}
interface Config { apiBase: string; token: string }
type Fetch = typeof fetch;

const EPIC_TITLE = 'Bug bash: zero known bugs';
const RANK: Record<AlphaBug['priority'], number> = { P0: -1000, P1: -500, P2: 0, P3: 500 };

export function readConfig(dir: string): Config | null {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'alpha.json'), 'utf8')) as Partial<Config>;
    return c.apiBase && c.token ? { apiBase: c.apiBase.replace(/\/$/, ''), token: c.token } : null;
  } catch { return null; }
}

function setting(wp: Workplace, key: string): string | undefined {
  return (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
}
function setSetting(wp: Workplace, key: string, value: string): void {
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
}

function bugBashEpicId(wp: Workplace): string | undefined {
  const row = wp.db.prepare("select id from work where coalesce(level, case kind when 'feature' then 'epic' else 'story' end) = 'epic' and json_extract(json, '$.title') = ?").get(EPIC_TITLE) as { id: string } | undefined;
  return row?.id;
}

export function storyBody(b: AlphaBug): string {
  const lines = [
    `Found by alpha testers (alpha bug ${b.id}, ${b.priority}${b.severity ? `, ${b.severity}` : ''}).`,
    '',
    b.summary ?? '',
    '',
    `Platforms: ${(b.platforms ?? []).join(', ') || 'unknown'}. Testers affected: ${(b.affected_testers ?? []).length || 1}.`,
  ];
  const ev = (b.evidence ?? []).flatMap(e => [`Report ${e.report_id}`, ...(e.urls ?? []).map(u => `  ${u}`)]);
  if (ev.length) lines.push('', 'Evidence (links valid 7 days):', ...ev);
  lines.push('', 'Reproduce on the latest build first. When this story is done, the testers are told it is fixed in the next build.');
  return lines.join('\n');
}

/** One pass: file new bugs, report fixes. Returns what it did, for the log and the tests. */
export async function tick(wp: Workplace, cfg: Config, fetchFn: Fetch = fetch): Promise<{ filed: string[]; fixed: string[] }> {
  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  const out = { filed: [] as string[], fixed: [] as string[] };
  const epicId = bugBashEpicId(wp);
  if (!epicId) { log.warn('alpha', `no "${EPIC_TITLE}" epic; intake waits`); return out; }

  const res = await fetchFn(`${cfg.apiBase}/workplace/bugs?status=unfiled`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`bugs: HTTP ${res.status}`);
  const body = await res.json() as { bugs?: AlphaBug[] } | AlphaBug[];
  const bugs = Array.isArray(body) ? body : body.bugs ?? [];
  for (const b of bugs) {
    // A story already filed for this bug (a crash between create and the backend's ack) is not
    // filed twice: the backend is told the story we already have.
    let storyId = setting(wp, `alpha:bug:${b.id}`);
    if (!storyId) {
      const it = items.create(wp, {
        level: 'story', parentId: epicId, title: `[Alpha ${b.priority}] ${b.title}`.slice(0, 160),
        body: storyBody(b), status: 'ready', rank: RANK[b.priority] ?? 0,
        acceptance: ['Reproduced on the latest build, or shown not reproducible with evidence', 'Fixed with a test that fails before the fix'],
      } as never, 'workplace');
      storyId = it.id;
      setSetting(wp, `alpha:bug:${b.id}`, storyId);
      setSetting(wp, `alpha:story:${storyId}`, b.id);
      manager.alert(wp, {
        key: `alpha:${b.id}`, itemId: storyId,
        title: `Alpha ${b.priority}: ${b.title}`,
        body: `${(b.affected_testers ?? []).length || 1} tester(s) on ${(b.platforms ?? []).join(', ') || 'unknown'}. Assign it to the owning charter${b.priority === 'P0' ? ' now: P0 blocks testers' : ''}.`,
        ...(b.priority === 'P0' ? { decision: 'scope' as const } : {}),
      });
    }
    const ack = await fetchFn(`${cfg.apiBase}/workplace/bugs/${encodeURIComponent(b.id)}/filed`, { method: 'POST', headers, body: JSON.stringify({ story_id: storyId }), signal: AbortSignal.timeout(20_000) });
    if (ack.ok) out.filed.push(b.id);
  }

  // Fixes: every filed alpha story that reached done and has not been reported yet.
  const rows = wp.db.prepare("select key, value from settings where key like 'alpha:story:%'").all() as { key: string; value: string }[];
  for (const r of rows) {
    const storyId = r.key.slice('alpha:story:'.length);
    if (setting(wp, `alpha:fixed:${storyId}`)) continue;
    const s = items.get(wp, storyId);
    if (!s || s.status !== 'done') continue;
    const version = (s as { resolution?: string }).resolution && (s as { resolution?: string }).resolution !== 'done' ? null : 'the next build';
    if (!version) continue;   // closed as won't-do or duplicate: not a fix
    const ack = await fetchFn(`${cfg.apiBase}/workplace/bugs/${encodeURIComponent(r.value)}/fixed`, { method: 'POST', headers, body: JSON.stringify({ version }), signal: AbortSignal.timeout(20_000) });
    if (ack.ok) { setSetting(wp, `alpha:fixed:${storyId}`, new Date().toISOString()); out.fixed.push(r.value); }
  }
  return out;
}

/** Pull every `minutes`; returns the stop function. Off when there is no config. */
export function start(wp: Workplace, dir: string, minutes = 2): () => void {
  let busy = false;
  const run = async () => {
    const cfg = readConfig(dir);
    if (!cfg || busy) return;
    busy = true;
    try {
      const r = await tick(wp, cfg);
      if (r.filed.length || r.fixed.length) log.info('alpha', `filed ${r.filed.length}, fixed ${r.fixed.length}`);
    } catch (err) { log.warn('alpha', `intake: ${err instanceof Error ? err.message : err}`); }
    finally { busy = false; }
  };
  void run();
  const timer = setInterval(() => void run(), minutes * 60_000);
  return () => clearInterval(timer);
}
