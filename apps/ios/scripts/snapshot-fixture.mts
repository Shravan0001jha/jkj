// Writes IrisWorkplaceTests/Fixtures/snapshot-v1.json with the REAL metrics engine (buildSnapshot in
// packages/server/src/services/metrics, branch coo/dashboard) run over deterministic synthetic Workplace
// rows (9 products from products.default.json, ~150 stories over six weeks). No DB, no network.
// Stand-in until /api/metrics/snapshot is live: then replace the fixture with a real copy curl'd through the relay.
//
//   git -C ~/jkj archive origin/coo/dashboard packages/server/src/services/metrics | tar -x -C /tmp/snap
//   METRICS_DIR=/tmp/snap/packages/server/src/services/metrics npx tsx scripts/snapshot-fixture.mts
// (METRICS_DIR defaults to this repo's packages/server/src/services/metrics once coo/dashboard is merged.)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rows, EpicRow, StoryRow } from '../../../packages/server/src/services/metrics/snapshot.ts';
import type { Transition } from '../../../packages/server/src/services/metrics/timeline.ts';

const here = dirname(fileURLToPath(import.meta.url));
const metrics = process.env['METRICS_DIR'] ?? resolve(here, '../../../packages/server/src/services/metrics');
const { buildSnapshot } = await import(resolve(metrics, 'snapshot.ts'));

const H = 3_600_000, D = 24 * H;
const now = Date.parse('2026-11-01T06:00:00Z');
let seed = 20261101;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
const base = JSON.parse(readFileSync(resolve(metrics, 'products.default.json'), 'utf8'));

// Per product: stories per epic, how far along, open mix. Plans is behind; launch and image are finished.
const plan: Record<string, { per: number; doneShare: number; bugShare: number; finished?: boolean; stalled?: boolean }> = {
  phone: { per: 6, doneShare: 0.55, bugShare: 0.25 },
  smarthome: { per: 5, doneShare: 0.7, bugShare: 0.2 },
  plans: { per: 5, doneShare: 0.5, bugShare: 0.3 },
  image: { per: 6, doneShare: 1, bugShare: 0.15, finished: true },
  voice: { per: 7, doneShare: 0.45, bugShare: 0.35, stalled: true },
  character: { per: 4, doneShare: 0.6, bugShare: 0.2 },
  answers: { per: 4, doneShare: 0.75, bugShare: 0.15 },
  trust: { per: 3, doneShare: 0.6, bugShare: 0.1 },
  launch: { per: 4, doneShare: 1, bugShare: 0.2, finished: true },
};
const titles = ['Pairing flow', 'Settings screen', 'Retry on drop', 'Spoken confirm', 'Empty state', 'Error copy', 'Sync on wake', 'Onboarding step', 'Server route', 'Cache layer', 'Unit tests', 'Store listing'];
const people = ['nikhil', 'kabir', 'meera', 'arjun', 'zoya', 'dev'];

const epics: EpicRow[] = [], stories: StoryRow[] = [], transitions: Transition[] = [];
const notes: Rows['notes'] = [], inbox: Rows['inbox'] = [], costByStory: Record<string, number> = {}, devApprovals: Record<string, number> = {}, startsAfter: Record<string, string> = {};
let n = 0;
for (const p of base.products) {
  const cfg = plan[p.id]!;
  for (const [ei, epicId] of (p.epics as string[]).entries()) {
    const created = now - (40 + Math.floor(rnd() * 8)) * D;
    const epicStories: StoryRow[] = [];
    for (let k = 0; k < cfg.per; k++) {
      const id = `as_${p.id}${ei}${k}`;
      const isBug = rnd() < cfg.bugShare;
      // Stories arrive across the six weeks; bugs a little later than features.
      const recent = !cfg.finished && !cfg.stalled && k < 2;
      const sc = recent ? now - Math.floor((3 + 7 * rnd()) * D) : cfg.finished ? now - Math.floor((12 + 26 * rnd()) * D) : now - Math.floor((isBug ? 30 : 38) * rnd() * D) - 6 * H;
      const willFinish = recent || cfg.finished || rnd() < cfg.doneShare;
      const emp = pick(people);
      let t = sc + Math.floor(rnd() * 2 * D) + H;
      const tr: Transition[] = [{ itemId: id, at: sc, from: null, to: 'ready' }];
      let status = 'ready';
      if (willFinish || rnd() < 0.55) {
        tr.push({ itemId: id, at: t, from: 'ready', to: 'in-progress' }); status = 'in-progress';
        t += Math.floor((4 + rnd() * 30) * H);
        if (t < now) {
          tr.push({ itemId: id, at: t, from: 'in-progress', to: 'in-review' }); status = 'in-review';
          const reviewStart = t;
          if (rnd() < 0.25) { // a send-back
            t += Math.floor((1 + rnd() * 6) * H);
            tr.push({ itemId: id, at: t, from: 'in-review', to: 'in-progress' });
            t += Math.floor((2 + rnd() * 10) * H);
            tr.push({ itemId: id, at: t, from: 'in-progress', to: 'in-review' });
          }
          const a1 = t + Math.floor((15 + rnd() * 240) * 60_000);
          if (a1 < now) { notes.push({ itemId: id, at: a1, text: `Developer approval by ${pick(people)}` }); devApprovals[id] = a1; }
          if (willFinish) {
            const fin = Math.min(now - H, Math.max(a1, reviewStart) + Math.floor((20 + rnd() * 600) * 60_000));
            if (cfg.stalled && fin > now - 14 * D) {
              // Voice: nothing finished in the last two weeks → no forecast (stalled), so at risk.
            } else { tr.push({ itemId: id, at: fin, from: 'in-review', to: 'done' }); status = 'done'; }
          } else if (rnd() < 0.65) {
            const b = t + Math.floor((3 + rnd() * 20) * H);
            if (b < now) {
              tr.push({ itemId: id, at: b, from: 'in-review', to: 'blocked' }); status = 'blocked';
              const why = rnd();
              if (why < 0.4) notes.push({ itemId: id, at: b + H, text: 'needs a real iPhone check on the owner device' });
              else if (why < 0.7) inbox.push({ createdAt: b + 2 * H, answeredAt: rnd() < 0.5 ? b + 30 * H : null, refs: [id] });
              else startsAfter[id] = `as_${p.id}${ei}0`;
            }
          }
        }
      }
      if (!willFinish && status === 'ready' && rnd() < 0.3) { const pk = sc + 2 * D; if (pk < now) { tr.push({ itemId: id, at: pk, from: 'ready', to: 'parked' }); status = 'parked'; } }
      transitions.push(...tr.filter(x => x.at <= now));
      costByStory[id] = Math.round(80 + rnd() * 600);
      const st: StoryRow = { id, epicId, title: `${pick(titles)} ${++n}`, status, employeeId: emp, charterId: p.id, createdAt: sc, type: isBug ? 'bug' : 'feature' };
      stories.push(st); epicStories.push(st);
    }
    const allClosed = epicStories.every(s => s.status === 'done');
    const target = cfg.finished ? '2026-10-24' : rnd() < 0.7 ? new Date(now + Math.floor(3 + rnd() * 20) * D).toISOString().slice(0, 10) : null;
    epics.push({
      id: epicId, title: `${p.name} part ${ei + 1}`, status: allClosed ? 'done' : 'in-progress',
      statusSince: allClosed ? Math.max(...transitions.filter(t => epicStories.some(s => s.id === t.itemId)).map(t => t.at)) : created,
      targetDate: target, createdAt: created,
      targetHistory: target ? [{ at: created + D, from: null, to: target }] : [],
    });
  }
}
// Plus an internal epic (not in any product): QA and Workplace work still counts in the overall trends.
for (let k = 0; k < 6; k++) {
  const id = `as_internal${k}`, sc = now - (5 + k * 5) * D;
  stories.push({ id, epicId: 'ft_internal_qa', title: `QA sweep ${k}`, status: k < 4 ? 'done' : 'ready', employeeId: 'meera', charterId: 'qa', createdAt: sc, type: k % 2 ? 'bug' : 'chore' });
  transitions.push({ itemId: id, at: sc, from: null, to: 'ready' });
  if (k < 4) transitions.push({ itemId: id, at: sc + 3 * H, from: 'ready', to: 'in-progress' }, { itemId: id, at: sc + 9 * H, from: 'in-progress', to: 'done' });
}
epics.push({ id: 'ft_internal_qa', title: 'QA sweeps', status: 'in-progress', statusSince: now - 30 * D, targetDate: null, createdAt: now - 30 * D, targetHistory: [] });

const rows: Rows = {
  now, epics, stories, transitions,
  holds: [{ from: Date.parse('2026-10-10T16:00:00Z'), to: Date.parse('2026-10-11T16:00:00Z') }, { from: Date.parse('2026-10-24T16:00:00Z'), to: Date.parse('2026-10-25T10:00:00Z') }],
  caps: [{ from: Date.parse('2026-10-17T08:00:00Z'), to: Date.parse('2026-10-17T20:00:00Z') }],
  stagingDown: [{ from: Date.parse('2026-10-21T06:00:00Z'), to: Date.parse('2026-10-21T14:00:00Z') }],
  notes, inbox, costByStory, devApprovals, startsAfter,
};
// The shipped products.default.json commits no dates; the owner's products.json override does. These
// dates exercise every health (on-track, at-risk, late, delivered, no-date).
const committed = { smarthome: '2026-11-20', plans: '2026-10-30', voice: '2026-11-10', character: '2026-11-25', answers: '2026-11-14', trust: '2026-12-05' };
const snap = buildSnapshot(rows, { products: base.products, committed: { ...base.committed, ...committed } });
writeFileSync(resolve(here, '../IrisWorkplaceTests/Fixtures/snapshot-v1.json'), JSON.stringify(snap, null, 2) + '\n');
for (const p of snap.products) console.log(p.id.padEnd(10), p.health.padEnd(9), `${p.done}/${p.total}`, p.committedDate, p.forecast.p50, p.forecast.p90);
console.log('weeks', snap.trends.weeks.join(' '));
console.log('bugsOpen', snap.trends.bugsOpenTotal.join(' '));
console.log('delivered/wk', snap.trends.weeks.map((_, i) => Object.values(snap.trends.deliveredByProduct).reduce((a, v) => a + v[i]!, 0)).join(' '));
console.log('waitByCause', JSON.stringify(snap.trends.waitByCause));
console.log('reviewWait', JSON.stringify(snap.gaps.reviewWait));
