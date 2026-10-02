import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as rhythm from '../src/services/rhythm.js';
import * as status from '../src/services/status.js';
import * as room from '../src/services/room.js';
import * as inbox from '../src/services/inbox.js';
import * as areas from '../src/services/areas.js';
import { testWorkplace } from './fakes/workplace.js';

/** Asha's rhythm and on-demand status (HLD D24, LLD §19.7), generated from the plan. */

/** An instant at a given IST wall-clock time on a given IST date. */
const ist = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+05:30`);

function seed(wp: ReturnType<typeof testWorkplace>['wp']) {
  const area = areas.create(wp, { title: 'Voice & audio' }, 'owner');
  const epic = items.create(wp, { level: 'epic', title: 'Iris works while music plays', areaId: area.id }, 'owner');
  const done = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live at volume 0', assigneeId: 'dev', points: 3 }, 'asha');
  items.update(wp, done.id, { status: 'in-progress' }, 'dev');
  items.update(wp, done.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
  items.update(wp, done.id, { status: 'done' }, 'nikhil');
  const doing = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music under speech', assigneeId: 'mira', points: 5 }, 'asha');
  items.update(wp, doing.id, { status: 'in-progress' }, 'mira');
  const stuck = items.create(wp, { level: 'story', parentId: epic.id, title: 'Speaker one-sentence API', assigneeId: 'rohan', points: 2 }, 'asha');
  items.update(wp, stuck.id, { status: 'in-progress' }, 'rohan');
  items.update(wp, stuck.id, { status: 'blocked', blockedReason: 'needs a decision on the API', waitingOn: 'dev' }, 'rohan');
  items.setFocus(wp, [epic.id], 'owner');
  inbox.raise(wp, { kind: 'decision', title: 'Which TTS voice ships?', body: 'x', raisedBy: 'mira' });
  return { epic, done, doing, stuck };
}

test('the 09:30 brief names what was done, the focus, the blockers and the decisions waiting', () => {
  const { wp, tmp } = testWorkplace();
  try {
    seed(wp);
    const brief = rhythm.buildBrief(wp, Date.now() + 60_000);
    assert.equal(brief.line, 'Brief: 1 done since yesterday · focus: Iris works while music plays · 1 blocked · 1 decision waits on you');
    assert.match(brief.details, /Mic stays live at volume 0 — Dev/);
    assert.match(brief.details, /Speaker one-sentence API — waiting on Dev: needs a decision on the API/);
    assert.match(brief.details, /Which TTS voice ships\?/);
  } finally {
    tmp.cleanup();
  }
});

test('the stand-up is one message per lead in General, done / next / blocked, authored by the Workplace about the lead', () => {
  const { wp, tmp } = testWorkplace();
  try {
    room.ensureGeneral(wp);
    seed(wp);
    assert.equal(rhythm.buildStandup(wp, 'dev', Date.now() + 60_000), 'Done: Mic stays live at volume 0\nNext: nothing in progress\nBlocked: nothing');
    assert.equal(rhythm.buildStandup(wp, 'rohan', Date.now() + 60_000), 'Done: nothing\nNext: nothing in progress\nBlocked: Speaker one-sentence API (waiting on Dev)');
    assert.equal(rhythm.buildStandup(wp, 'tara', Date.now() + 60_000), null, 'nothing to report, nothing posted');
  } finally {
    tmp.cleanup();
  }
});

test('the rhythm runs each thing once a day at its IST time; Sunday adds the weekly review', () => {
  const { wp, tmp } = testWorkplace();
  try {
    room.ensureGeneral(wp);
    seed(wp);
    // 4 Oct 2026 is a Sunday.
    assert.deepEqual(rhythm.maybeRun(wp, ist('2026-10-04', '09:00')), []);
    assert.deepEqual(rhythm.maybeRun(wp, ist('2026-10-04', '09:31')), ['brief']);
    assert.deepEqual(rhythm.maybeRun(wp, ist('2026-10-04', '09:45')), [], 'once a day');
    const brief = trail.updates(wp).find(u => u.kind === 'brief')!;
    assert.equal(brief.by, 'asha');
    assert.equal(brief.push, true);
    assert.equal(brief.href, 'plan');
    assert.deepEqual(rhythm.maybeRun(wp, ist('2026-10-04', '10:01')), ['standup']);
    const standups = room.messages(wp, room.GENERAL_THREAD_ID).filter(m => m.kind === 'standup');
    const abouts = standups.map(m => m.about);
    assert.ok(abouts.includes('mira') && abouts.includes('rohan'), 'every lead with work in hand reports');
    assert.ok(!abouts.includes('tara'), 'nothing to report, nothing posted');
    assert.ok(standups.every(m => m.by === 'workplace'), 'nobody is quoted saying what they did not write');
    assert.deepEqual(rhythm.maybeRun(wp, ist('2026-10-04', '18:05')), ['review']);
    const review = trail.updates(wp).find(u => u.kind === 'review')!;
    assert.match(review.line, /^Week: \d+ points? shipped · 0 reopened after a false done · 0 stalls · ₹\d+ real spend · 0 hires proposed$/);
    assert.equal(review.push, true);
    assert.deepEqual(rhythm.maybeRun(wp, ist('2026-10-05', '18:05')), ['brief', 'standup'], 'Monday: no review');
  } finally {
    tmp.cleanup();
  }
});

test('the weekly review counts reopens after a false done', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { done } = seed(wp);
    items.update(wp, done.id, { status: 'in-progress', note: 'echo is back' }, 'owner');
    const r = rhythm.buildWeeklyReview(wp, Date.now() + 60_000);
    assert.equal(r.numbers.reopened, 1);
    assert.equal(r.numbers.pointsShipped, 0, 'a reopened story no longer counts as shipped');
  } finally {
    tmp.cleanup();
  }
});

test('on-demand status answers from the plan, by item, by person or by area, with links', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { stuck, doing } = seed(wp);
    const byTitle = status.answer(wp, 'speaker api');
    assert.equal(byTitle.matches[0]!.item.id, stuck.id);
    assert.equal(byTitle.matches[0]!.line, "Story 'Speaker one-sentence API' — Blocked · Rohan · 2 pts · waiting on Dev: needs a decision on the API");
    assert.equal(byTitle.matches[0]!.href, `item/${stuck.id}`);
    assert.equal(byTitle.line, byTitle.matches[0]!.line);
    const byPerson = status.answer(wp, 'what is Mira doing?');
    assert.deepEqual(byPerson.matches.map(m => m.item.id), [doing.id]);
    const byArea = status.answer(wp, 'voice & audio');
    assert.match(byArea.line, /Iris works while music plays/);
    assert.match(byArea.line, /33%|38%|30%/);
    const none = status.answer(wp, 'quantum teleporter');
    assert.equal(none.matches.length, 0);
    assert.equal(none.line, 'Nothing in the plan matches "quantum teleporter".');
  } finally {
    tmp.cleanup();
  }
});
