import type { Workplace } from './workplace.js';
import * as spend from './spend.js';
import * as inbox from './inbox.js';
import * as work from './work.js';
import * as employees from './employees.js';
import { digest as render, type Telegram } from './telegram.js';

/**
 * The daily digest (HLD D15): needs you, done yesterday, blocked, spend.
 * Sent at the configured IST hour, and on demand from the API.
 */

export function build(wp: Workplace): string {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const s = spend.summary(wp);
  const open = inbox.list(wp, 'open');
  return render({
    needsYou: open.length,
    doneYesterday: work.list(wp, { kind: 'assignment', state: 'done' }).filter(a => a.updatedAt >= yesterday).length,
    blocked: work.list(wp, { kind: 'assignment', state: 'blocked' }).length + wp.org.employees.filter(e => employees.stateOf(wp, e.id) === 'blocked').length,
    spendInr: s.companyInr, capInr: s.capInr,
    open: open.map(i => i.title),
  });
}

export async function send(wp: Workplace, telegram: Telegram): Promise<{ text: string; sent: boolean }> {
  const text = build(wp);
  const sent = await telegram.notify(text);
  return { text, sent };
}

let lastDay = '';
/** Once per IST day at the configured hour. */
export async function maybeSend(wp: Workplace, telegram: Telegram, hour: number): Promise<boolean> {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = spend.dayOf();
  if (ist.getHours() !== hour || lastDay === day) return false;
  lastDay = day;
  await send(wp, telegram);
  return true;
}
