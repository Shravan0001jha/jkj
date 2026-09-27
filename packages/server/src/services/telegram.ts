import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import { log } from '../util/logger.js';

/**
 * Telegram is the channel today and the alert channel always (HLD D15).
 *
 * Out: `~/iris-ops/notify.sh "text"`, 3–5 lines. In: the existing bridge
 * appends the owner's replies to `~/iris-ops/state/inbox.jsonl`; this module
 * tails it from its own cursor (never `read_inbox.sh`'s) and applies
 * `approve <id>`, `reject <id>`, `talk <employee> <text>`, `status`.
 */

export interface TelegramDeps {
  /** Replaces notify.sh in tests. */
  send?: (text: string) => Promise<boolean>;
  /** Replaces the inbox file in tests. */
  inboxPath?: string;
  cursorPath?: string;
  /** How `talk` reaches an employee; wired by employees.ts. */
  talk?: (employeeId: string, text: string) => Promise<string>;
  status?: () => string;
  /** The emergency off switch for published access. */
  off?: () => string;
  /** Re-enable passkey enrolment on the relay. */
  enrolOn?: () => string;
  /** Publish again after 'off' (the Mac reconnects and tells the relay 'on'). */
  on?: () => string;
}

export interface Command {
  kind: 'approve' | 'reject' | 'talk' | 'status' | 'answer' | 'off' | 'on' | 'enrol-on' | 'unknown';
  id?: string;
  employeeId?: string;
  text?: string;
  optionId?: string;
}

export function parseCommand(text: string): Command {
  const t = text.trim();
  let m = /^(approve|reject)\s+(\S+)\s*(.*)$/i.exec(t);
  if (m) return { kind: m[1]!.toLowerCase() as 'approve' | 'reject', id: m[2]!, ...(m[3] ? { text: m[3] } : {}) };
  m = /^answer\s+(\S+)\s+(\S+)\s*(.*)$/i.exec(t);
  if (m) return { kind: 'answer', id: m[1]!, optionId: m[2]!, ...(m[3] ? { text: m[3] } : {}) };
  m = /^talk\s+(\S+)\s+([\s\S]+)$/i.exec(t);
  if (m) return { kind: 'talk', employeeId: m[1]!.toLowerCase(), text: m[2]! };
  if (/^status$/i.test(t)) return { kind: 'status' };
  if (/^(off|workplace off|emergency off)$/i.test(t)) return { kind: 'off' };
  if (/^enrol\s*on$/i.test(t)) return { kind: 'enrol-on' };
  if (/^(on|workplace on|publish)$/i.test(t)) return { kind: 'on' };
  return { kind: 'unknown', text: t };
}

export class Telegram {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inboxPath: string;
  private readonly cursorPath: string;

  constructor(private readonly wp: Workplace, private readonly deps: TelegramDeps = {}) {
    const state = join(wp.config.opsDir, 'state');
    this.inboxPath = deps.inboxPath ?? join(state, 'inbox.jsonl');
    this.cursorPath = deps.cursorPath ?? join(state, 'workplace-cursor');
  }

  /** 3–5 lines. Longer messages are cut, not sent as a wall. */
  async notify(text: string): Promise<boolean> {
    const lines = text.split('\n').filter(l => l.trim()).slice(0, 5);
    const body = lines.join('\n');
    if (!this.wp.config.telegram) { log.info('telegram', `(off) ${lines[0] ?? ''}`); return false; }
    if (this.deps.send) return this.deps.send(body);
    return new Promise(resolve => {
      execFile(join(this.wp.config.opsDir, 'notify.sh'), [body], { timeout: 15_000 }, (err, stdout) => {
        if (err) { log.warn('telegram', `notify failed: ${err.message}`); resolve(false); return; }
        resolve(String(stdout).includes('sent'));
      });
    });
  }

  /** Pings for what needs the owner. Called from the event bus. */
  attach(): void {
    this.wp.on(event => {
      if (event.type === 'alert' && (event.level === 'needs-you' || event.level === 'cap' || event.level === 'blocked')) {
        const id = event.inboxId ? `\nReply: approve ${event.inboxId} / reject ${event.inboxId}` : '';
        void this.notify(`Iris Workplace · ${event.title}\n${event.body}${id}`);
      }
    });
  }

  /** Read new replies since the cursor and apply them. Returns what was handled. */
  async poll(): Promise<Command[]> {
    if (!existsSync(this.inboxPath)) return [];
    const size = statSync(this.inboxPath).size;
    const cursor = this.readCursor();
    if (size <= cursor) { if (size < cursor) this.writeCursor(0); return []; }
    const chunk = readFileSync(this.inboxPath, 'utf8').slice(cursor);
    const lines = chunk.split('\n');
    // A partially written last line is left for the next poll.
    const complete = chunk.endsWith('\n') ? lines.filter(Boolean) : lines.slice(0, -1).filter(Boolean);
    const consumed = chunk.endsWith('\n') ? chunk.length : chunk.lastIndexOf('\n') + 1;
    this.writeCursor(cursor + Buffer.byteLength(chunk.slice(0, consumed)));

    const handled: Command[] = [];
    for (const line of complete) {
      let text: string;
      try { text = String((JSON.parse(line) as { text?: string }).text ?? ''); } catch { continue; }
      const command = parseCommand(text);
      handled.push(command);
      await this.apply(command);
    }
    return handled;
  }

  async apply(command: Command): Promise<void> {
    try {
      switch (command.kind) {
        case 'approve':
        case 'reject': {
          const item = inbox.answer(this.wp, command.id!, command.kind, command.text, 'telegram');
          await this.notify(`${command.kind === 'approve' ? 'Approved' : 'Rejected'}: ${item.title}`);
          break;
        }
        case 'answer': {
          const item = inbox.answer(this.wp, command.id!, command.optionId!, command.text, 'telegram');
          await this.notify(`Answered: ${item.title} → ${command.optionId}`);
          break;
        }
        case 'talk': {
          if (!this.deps.talk) break;
          const reply = await this.deps.talk(command.employeeId!, command.text!);
          await this.notify(reply);
          break;
        }
        case 'status':
          await this.notify(this.deps.status?.() ?? 'Workplace is up.');
          break;
        case 'off':
          await this.notify(this.deps.off?.() ?? 'Nothing is published.');
          break;
        case 'enrol-on':
          await this.notify(this.deps.enrolOn?.() ?? 'Nothing is published.');
          break;
        case 'on':
          await this.notify(this.deps.on?.() ?? 'Nothing is published.');
          break;
        default:
          break;   // ordinary conversation with the older ops loop; not ours
      }
    } catch (err) {
      await this.notify(`Could not apply "${command.kind}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    // Start from the end: replies from before the Workplace ran are not commands for it.
    if (!existsSync(this.cursorPath) && existsSync(this.inboxPath)) this.writeCursor(statSync(this.inboxPath).size);
    this.timer = setInterval(() => void this.poll().catch(err => log.warn('telegram', String(err))), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readCursor(): number {
    try { return Number(readFileSync(this.cursorPath, 'utf8').trim()) || 0; } catch { return 0; }
  }

  private writeCursor(n: number): void {
    mkdirSync(join(this.cursorPath, '..'), { recursive: true });
    writeFileSync(this.cursorPath, String(n), 'utf8');
  }
}

/** The daily digest: needs you, done yesterday, blocked, spend. */
export function digest(parts: { needsYou: number; doneYesterday: number; blocked: number; spendInr: number; capInr: number; open: string[] }): string {
  const top = parts.open.slice(0, 2).map(t => ` · ${t}`).join('\n');
  return [
    `Iris Workplace digest`,
    `Needs you: ${parts.needsYou} · Done yesterday: ${parts.doneYesterday} · Blocked: ${parts.blocked}`,
    `Spend today: ₹${parts.spendInr.toFixed(0)} of ₹${parts.capInr}`,
    ...(top ? [top] : []),
  ].join('\n');
}
