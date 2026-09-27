import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Config } from './config.js';
import { createHttpServer, listen } from './http/server.js';
import { Auth } from './http/auth.js';
import { attachSocket } from './ws/hub.js';
import { findClaudeHome } from './runtime/claude-home.js';
import { createWorkplace, type Workplace } from './services/workplace.js';
import { Telegram, digest } from './services/telegram.js';
import * as employees from './services/employees.js';
import * as spend from './services/spend.js';
import * as health from './services/health.js';
import * as inbox from './services/inbox.js';
import * as work from './services/work.js';
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
  const home = findClaudeHome();
  if (!home.present) log.warn('boot', `no Claude Code state found at ${home.configDir}; sessions will still run`);

  const wp = createWorkplace(config);
  log.info('boot', `${wp.org.employees.length} employees, ${wp.org.charters.size} charters, ${wp.requirements().length} requirements in ${config.workplaceDir}`);

  // The decisions the definition leaves open go to the owner, once.
  seedDecisions(wp);

  // Caps pause sessions; the owner's answer unpauses.
  spend.onPause((w, scope) => employees.pauseScope(w, scope));
  inbox.onAnswer((w, item) => { if (item.kind === 'cap' && item.answer?.optionId === 'raise-today') employees.unpauseAll(w); });

  const auth = new Auth(join(config.opsDir, 'workplace', 'api-token'));
  const server = createHttpServer({ config, wp, auth });
  attachSocket(server, wp, auth);
  await listen(server, config);

  const telegram = new Telegram(wp, {
    talk: async (id, text) => { const agent = employees.talk(wp, id, text); return `${agent.name}: message delivered (session ${agent.id}). Reply arrives in the Office.`; },
    status: () => statusLine(wp),
  });
  telegram.attach();
  if (config.telegram) telegram.start();

  const stallTimer = setInterval(() => void health.handleStalls(wp).catch(err => log.warn('health', String(err))), 30_000);
  const digestTimer = setInterval(() => void maybeDigest(wp, telegram, config), 60_000);

  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    log.warn('boot', `bound to ${config.host}: off-loopback requests need the bearer token in ${auth.path}`);
  }

  return {
    server, wp, telegram,
    stop: async () => {
      clearInterval(stallTimer);
      clearInterval(digestTimer);
      telegram.stop();
      for (const s of employees.allSessions()) employees.close(wp, s.agentId, 'shutdown');
      await new Promise<void>(resolve => server.close(() => resolve()));
      wp.db.close();
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

let lastDigestDay = '';
async function maybeDigest(wp: Workplace, telegram: Telegram, config: Config): Promise<void> {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = spend.dayOf();
  if (ist.getHours() !== config.digestHour || lastDigestDay === day) return;
  lastDigestDay = day;
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const s = spend.summary(wp);
  const open = inbox.list(wp, 'open');
  await telegram.notify(digest({
    needsYou: open.length,
    doneYesterday: work.list(wp, { kind: 'assignment', state: 'done' }).filter(a => a.updatedAt >= yesterday).length,
    blocked: work.list(wp, { kind: 'assignment', state: 'blocked' }).length,
    spendInr: s.companyInr, capInr: s.capInr,
    open: open.map(i => i.title),
  }));
}
