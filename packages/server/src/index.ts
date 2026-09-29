import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Config } from './config.js';
import { createHttpServer, listen } from './http/server.js';
import { Auth } from './http/auth.js';
import { attachSocket } from './ws/hub.js';
import { findClaudeHome } from './runtime/claude-home.js';
import { createWorkplace, type Workplace } from './services/workplace.js';
import { Telegram } from './services/telegram.js';
import { Push } from './services/push.js';
import * as digestService from './services/digest.js';
import * as features from './services/features.js';
import * as cos from './services/cos.js';
import * as lock from './services/lock.js';
import * as boots from './services/boots.js';
import { Watchdog } from './services/watchdog.js';
import { SuspendDetector } from './services/suspend.js';
import { PowerMonitor } from './services/power.js';
import * as room from './services/room.js';
import * as coo from './services/coo.js';
import { wireMentionReplies } from './services/mentions.js';
import * as awsCost from './services/aws-cost.js';
import { Tunnel, readRelayUrl, readTunnelSecret } from './services/tunnel.js';
import * as employees from './services/employees.js';
import * as spend from './services/spend.js';
import * as health from './services/health.js';
import * as inbox from './services/inbox.js';
import { OPEN_DECISIONS } from './seed-data/checklist.js';
import { log } from './util/logger.js';

/**
 * Boot sequence. Everything the Workplace starts, starts here, in this order.
 */

export interface Running {
  server: Server;
  wp: Workplace;
  telegram: Telegram;
  stop(): Promise<void>;
}

export async function start(config: Config): Promise<Running> {
  // One Workplace per organisation: a live pid in the lock refuses the start (lock.ts).
  const held = lock.acquire(config.workplaceDir);
  try {
    return await boot(config, held);
  } catch (err) {
    held.release();
    throw err;
  }
}

async function boot(config: Config, held: lock.Lock): Promise<Running> {
  const home = findClaudeHome();
  if (!home.present) log.warn('boot', `no Claude Code state found at ${home.configDir}; sessions will still run`);

  const wp = createWorkplace(config);
  log.info('boot', `${wp.org.employees.length} employees, ${wp.org.charters.size} charters, ${wp.requirements().length} requirements in ${config.workplaceDir}`);
  // Every start is counted: the phone's health check shows restarts; the watchdog reports a crash loop.
  const startedAt = Date.now();
  const history = boots.recordBoot(wp.db, new Date(startedAt));
  log.info('boot', `boot #${history.total} (${boots.bootsWithin(history, startedAt, 24 * 60 * 60_000)} in the last 24 h)`);

  // The decisions the definition leaves open go to the owner, once.
  seedDecisions(wp);
  // Sessions that were open when the last process died are reported, never forgotten.
  employees.recoverAfterRestart(wp);
  // Budget is real money only (28 Sep): relabel the old ledger, lift pauses that were on free usage.
  spend.migrateToRealMoney(wp);
  try { const c = spend.resolveStalePreMigrationCapItems(wp); if (c.resolved.length) log.info('boot', `resolved ${c.resolved.length} stale pre-migration cap item(s)`); } catch (err) { log.warn('boot', `stale cap items: ${err instanceof Error ? err.message : err}`); }

  // Caps pause sessions; the owner's answer unpauses.
  spend.onPause((w, scope) => employees.pauseScope(w, scope));
  inbox.onAnswer((w, item) => { if (item.kind === 'cap' && item.answer?.optionId === 'raise-today') employees.unpauseAll(w); });

  const telegram = new Telegram(wp, {
    talk: async (id, text) => { const agent = employees.talk(wp, id, text); return `${agent.name}: message delivered (session ${agent.id}). Reply arrives in the Office.`; },
    status: () => statusLine(wp),
    off: () => { tunnel?.off(); return tunnel ? 'Published access is OFF: the tunnel to the relay is dropped and every remote session is gone. Restart the Workplace to publish again.' : 'Nothing is published; no tunnel is configured.'; },
    enrolOn: () => (tunnel?.enrolOn() ? 'Passkey enrolment re-enabled on the relay.' : 'The relay is not connected; try again when the tunnel is up.'),
    on: () => (tunnel ? (tunnel.on() ? 'Publishing again: the tunnel is reconnecting.' : `Nothing to do: published access is ${tunnel.status}.`) : 'Nothing is published; no tunnel is configured.'),
  });

  // The first real feature, with Iris's real statuses, once; then the Team Room's real threads.
  try { features.seedFeature(wp); } catch (err) { log.warn('boot', `feature seed failed: ${err instanceof Error ? err.message : err}`); }
  try { room.ensureGeneral(wp); } catch (err) { log.warn('boot', `General channel: ${err instanceof Error ? err.message : err}`); }
  try { const made = room.seedThreads(wp); if (made.length) log.info('boot', `seeded ${made.length} Team Room threads from the 27 Sep plans`); } catch (err) { log.warn('boot', `room seed failed: ${err instanceof Error ? err.message : err}`); }
  // @mentions wake a short, rate-limited reply turn (RCA, 29 Sep: nothing did this before); @coo goes to the COO bridge.
  wireMentionReplies(wp);

  const auth = new Auth(join(config.opsDir, 'workplace', 'api-token'));
  // Pushes ride the tunnel; without a relay there is nowhere to send them and `send` says so.
  const push = new Push(wp, { send: intent => tunnel?.push(intent) ?? false });
  const tunnel = createTunnel(config, telegram, push);
  // The watchdog: the tunnel down for more than five minutes, or a crash loop, is one Telegram ping
  // and one "back" ping, through the Workplace's own alert path (docs/RESILIENCE-workplace.md §4).
  const watchdog = new Watchdog({
    link: () => (tunnel ? tunnel.status : 'not-configured'),
    notify: text => telegram.notify(text),
    boots: boots.marks(wp.db),
    bootedAt: startedAt,
  });
  // The Mac sleeping is the one cause of tunnel flaps seen so far (B2): notice a resume, reconnect at
  // once, and show sleeps and the power source on the health check.
  const suspend = new SuspendDetector();
  suspend.onResume(gap => { log.warn('power', `the process was frozen for ${Math.round(gap / 1000)} s (the Mac slept)`); tunnel?.wake(gap); });
  const power = new PowerMonitor();
  const resilience = () => ({
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    boots: { total: history.total, last24h: boots.bootsWithin(history, Date.now(), 24 * 60 * 60_000), recent: history.recent.slice(-5) },
    tunnel: tunnel ? tunnel.stats : null,
    watchdog: watchdog.state,
    sleeps: suspend.state,
    power: power.state,
  });
  const server = createHttpServer({ config, wp, auth, telegram, tunnel, push, resilience });
  const hub = attachSocket(server, wp, auth);
  await listen(server, config);
  // The tunnel forwards to the port actually bound (config.port may be 0 in tests).
  tunnel?.setLocal(`http://127.0.0.1:${(server.address() as { port: number }).port}`);

  telegram.attach();
  if (config.push && tunnel) push.attach(); else log.info('push', config.push ? 'not published: no relay, so no push' : 'off (--no-push)');
  if (config.telegram) telegram.start();
  tunnel?.start();
  watchdog.start();
  suspend.start();
  power.start();

  // Duplicate stall notes an earlier build left (QA B3) are withdrawn once; the owner's decisions are untouched.
  try { const d = cos.dedupeNotes(wp); if (d.expired.length) log.info('boot', `withdrew ${d.expired.length} duplicate stall notes`); } catch (err) { log.warn('boot', `dedupe notes: ${err instanceof Error ? err.message : err}`); }
  // The pre-fix flood of owner-facing stall/"did nothing"/[TEST] items (29 Sep): withdrawn once; a
  // real open review request moves onto the reviewer's/Asha's page instead.
  try { cos.cleanupLegacyInbox(wp); } catch (err) { log.warn('boot', `legacy inbox cleanup: ${err instanceof Error ? err.message : err}`); }

  const stallTimer = setInterval(() => {
    for (const id of employees.closeStale(wp)) log.info('sessions', `closed stale session ${id}`);
    health.handleParkedApprovals(wp);
    void health.handleStalls(wp).catch(err => log.warn('health', String(err)));
    // The lead's heartbeat is a file, not an event: polled here, a coo.presence event goes out
    // only when online ↔ offline actually flips (coo.pollPresence).
    try { coo.pollPresence(wp); } catch (err) { log.warn('coo', `presence poll: ${err instanceof Error ? err.message : err}`); }
  }, 30_000);
  // The Chief of Staff's routine: stalled work is resumed within budget or explained in the Inbox.
  const cosTimer = setInterval(() => { try { cos.tick(wp); } catch (err) { log.warn('cos', String(err)); } }, 5 * 60_000);
  // AWS actuals once a day, after the digest hour.
  const awsTimer = setInterval(() => { if (config.awsCost) void awsCost.reconcileYesterday(wp).catch(err => log.warn('aws-cost', String(err))); }, 60 * 60_000);
  const digestTimer = setInterval(() => void digestService.maybeSend(wp, telegram, config.digestHour), 60_000);

  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    log.warn('boot', `bound to ${config.host}: off-loopback requests need the bearer token in ${auth.path}`);
  }

  return {
    server, wp, telegram,
    stop: async () => {
      push.stop();
      suspend.stop();
      power.stop();
      watchdog.stop();
      tunnel?.stop();
      clearInterval(stallTimer);
      clearInterval(cosTimer);
      clearInterval(awsTimer);
      clearInterval(digestTimer);
      telegram.stop();
      employees.closeAll(wp);
      hub.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      wp.db.close();
      held.release();
    },
  };
}

function seedDecisions(wp: Workplace): void {
  const done = wp.db.prepare('select value from settings where key = ?').get('decisions-seeded') as { value: string } | undefined;
  if (done) return;
  for (const d of OPEN_DECISIONS) {
    inbox.raise(wp, { kind: 'decision', title: d.title, body: d.body, options: d.options, raisedBy: 'asha', context: { decision: d.key }, dedupeKey: `decision:${d.key}` });
  }
  wp.db.prepare('insert into settings (key, value) values (?, ?)').run('decisions-seeded', new Date().toISOString());
  log.info('boot', `filed ${OPEN_DECISIONS.length} open product decisions to the Inbox`);
}

function statusLine(wp: Workplace): string {
  const s = spend.summary(wp);
  const states = wp.org.employees.map(e => `${e.name}: ${employees.stateOf(wp, e.id)}`).join(', ');
  return `Needs you: ${inbox.openCount(wp)} · Spend ₹${s.companyInr.toFixed(0)} of ₹${s.capInr}\n${states}`;
}

/**
 * The outbound tunnel to the relay, when ~/iris-ops/workplace/relay.env
 * names one (RELAY_URL and TUNNEL_SECRET). Without it nothing is published.
 */
function createTunnel(config: Config, telegram: Telegram, push: Push): Tunnel | null {
  const url = readRelayUrl(config.opsDir);
  const secret = readTunnelSecret(config.opsDir);
  if (!url || !secret) { log.info('tunnel', 'not published: no relay.env'); return null; }
  return new Tunnel({
    url, secret,
    local: `http://127.0.0.1:${config.port}`,
    notify: text => telegram.notify(text),
    onStatus: status => log.info('tunnel', `published: ${status}`),
    onPushResult: result => push.result(result),
  });
}

