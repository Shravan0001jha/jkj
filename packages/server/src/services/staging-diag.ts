import { execFile } from 'node:child_process';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';
import { childEnvFor } from './evidence-ports.js';

/**
 * staging_diag (COO-approved 21 Oct 2026): a read-only way for agents (and the COO) to diagnose
 * staging without SSH of their own. Three whitelisted queries, nothing else:
 *   logs     journalctl for iris-api + iris-agent in an explicit window of at most 30 minutes
 *   chat     chat_messages + chat_jobs of ONE @e2e.irisforu.com account (pool/test accounts only)
 *   version  /opt/iris-api/VERSION
 * The server's own credentials do the SSH (`scripts/staging.sh ssh-open | ssh | ssh-close`); no
 * caller input ever reaches a shell raw: dates are re-rendered from a parsed Date, the grep filter
 * and the email travel as base64, and the remote programs are fixed constants.
 */

export const E2E_DOMAIN = '@e2e.irisforu.com';
export const MAX_WINDOW_MS = 30 * 60_000;
export const MAX_LOG_LINES = 300;
export const MAX_CHAT_ROWS = 50;
export const MAX_OUTPUT_CHARS = 120_000;
const MAX_FILTER = 200;

export type DiagKind = 'logs' | 'chat' | 'version';
export interface DiagRequest { kind: DiagKind; since?: string; until?: string; filter?: string; account?: string; start?: boolean; by: string }

/** One `scripts/staging.sh <args>` run. argv only, never a shell string. */
export interface DiagRunner { run(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> }

export function realRunner(script: string): DiagRunner {
  return {
    run: (args, timeoutMs) => new Promise(resolve => {
      execFile('bash', [script, ...args], { env: childEnvFor({}), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: '/' }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr ? `\n${stderr}` : ''}` });
      });
    }),
  };
}

const TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})$/;
const EMAIL = /^[a-z0-9._+-]{1,64}@e2e\.irisforu\.com$/;
const pad = (n: number): string => String(n).padStart(2, '0');

/** An explicit, zone-carrying timestamp as the digits-only UTC form journalctl takes. */
export function parseWhen(label: string, v: string | undefined): { ms: number; utc: string } {
  const s = (v ?? '').trim();
  if (!TS.test(s)) throw new BadRequest(`${label} must be an explicit time with a zone, like 2026-10-21T10:00:00Z.`);
  const ms = Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(ms)) throw new BadRequest(`${label} is not a real time.`);
  const d = new Date(ms);
  return { ms, utc: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` };
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** The fixed Python that reads one e2e account's chat rows. It re-checks the domain on the box. */
const CHAT_PY = [
  'import sys,json,sqlite3,base64',
  'email=base64.b64decode(sys.argv[1]).decode().lower()',
  'if not email.endswith("@e2e.irisforu.com"): sys.exit(3)',
  'con=sqlite3.connect("file:/opt/iris-api/iris.db?mode=ro",uri=True)',
  'con.row_factory=sqlite3.Row',
  'u=con.execute("select id,email from users where lower(email)=?",(email,)).fetchone()',
  'if not u: print(json.dumps({"error":"no such account"})); sys.exit(0)',
  'def clip(r):',
  ' d=dict(r)',
  ' for k,v in d.items():',
  '  if isinstance(v,str) and len(v)>2000: d[k]=v[:2000]+"...[cut]"',
  ' return d',
  'print(json.dumps({"account":u["email"]}))',
  `for r in con.execute("select id,role,text,status,progress,source,reply_to,meta,created_at,updated_at,deleted from chat_messages where user_id=? order by created_at desc limit ${MAX_CHAT_ROWS}",(u["id"],)): print(json.dumps({"table":"chat_messages",**clip(r)}))`,
  `for r in con.execute("select id,message_id,reply_id,status,attempts,cancel,error,created_at,started_at,heartbeat_at,finished_at,usage from chat_jobs where user_id=? order by created_at desc limit ${MAX_CHAT_ROWS}",(u["id"],)): print(json.dumps({"table":"chat_jobs",**clip(r)}))`,
].join('\n');

/** The remote command for each kind: constants plus base64 and digits-only values. */
export function remoteCommand(q: { kind: DiagKind; sinceUtc?: string; untilUtc?: string; filter?: string; email?: string }): string {
  if (q.kind === 'version') return 'cat /opt/iris-api/VERSION';
  if (q.kind === 'chat') return `sudo -n python3 -c "$(echo ${b64(CHAT_PY)} | base64 -d)" ${b64(q.email!)}`;
  const grep = q.filter ? ` | grep -F -e "$(echo ${b64(q.filter)} | base64 -d)"` : '';
  return `sudo -n journalctl -u iris-api -u iris-agent --since '${q.sinceUtc} UTC' --until '${q.untilUtc} UTC' --no-pager -o short-iso${grep} | tail -n ${MAX_LOG_LINES}`;
}

export interface DiagResult { ok: boolean; text: string }

export async function stagingDiag(req: DiagRequest, runner: DiagRunner): Promise<DiagResult> {
  // Validate everything before any network or process work.
  let q: Parameters<typeof remoteCommand>[0];
  let argsForLog: string;
  if (req.kind === 'version') { q = { kind: 'version' }; argsForLog = ''; }
  else if (req.kind === 'chat') {
    const email = (req.account ?? '').trim().toLowerCase();
    if (!email.endsWith(E2E_DOMAIN) || !EMAIL.test(email)) {
      log.warn('diag', `refused chat for ${JSON.stringify((req.account ?? '').slice(0, 80))} by ${req.by}`);
      throw new BadRequest(`staging_diag chat reads only test accounts (an address ending ${E2E_DOMAIN}). Real users' chats are never readable by agents.`);
    }
    q = { kind: 'chat', email }; argsForLog = email;
  } else if (req.kind === 'logs') {
    const since = parseWhen('since', req.since), until = parseWhen('until', req.until);
    if (until.ms <= since.ms) throw new BadRequest('until must be after since.');
    if (until.ms - since.ms > MAX_WINDOW_MS) throw new BadRequest('The window is at most 30 minutes.');
    const filter = req.filter?.trim() ?? '';
    // eslint-disable-next-line no-control-regex
    if (filter.length > MAX_FILTER || /[\u0000-\u001f\u007f]/.test(filter)) throw new BadRequest(`filter is one line of at most ${MAX_FILTER} characters.`);
    q = { kind: 'logs', sinceUtc: since.utc, untilUtc: until.utc, ...(filter ? { filter } : {}) };
    argsForLog = `${since.utc}..${until.utc}${filter ? ` filter=${JSON.stringify(filter)}` : ''}`;
  } else throw new BadRequest('kind is logs, chat or version.');
  log.info('diag', `staging_diag ${req.kind} by ${req.by} ${argsForLog}`.trim());

  const st = await runner.run(['status'], 60_000);
  const state = /^instance\s+\S+\s+(\S+)/m.exec(st.out)?.[1] ?? 'unknown';
  if (state !== 'running') {
    if (!req.start) return { ok: false, text: `Staging is ${state}, not running. Call staging_diag again with start: true to start it (it idles off by itself), or lease a test account, which starts it.` };
    const s = await runner.run(['start'], 12 * 60_000);
    if (s.code !== 0) return { ok: false, text: `Staging did not start (staging.sh start exit ${s.code}): ${s.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` };
  }

  // One ssh-open paired with exactly one ssh-close: staging.sh refcounts them (as_mvfmyacwntj6a), so an
  // overlapping deploy keeps its window. If the open itself fails, nothing was counted: no close.
  const opened = await runner.run(['ssh-open'], 60_000);
  if (opened.code !== 0) return { ok: false, text: `Could not open the staging SSH window: ${opened.out.trim().slice(-300)}` };
  let ran: { code: number | null; out: string };
  try { ran = await runner.run(['ssh', remoteCommand(q)], 90_000); }
  finally { await runner.run(['ssh-close'], 60_000).catch(() => undefined); }

  let out = ran.out;
  if (ran.code === 3 && req.kind === 'chat') return { ok: false, text: 'Refused on the box: not an e2e test account.' };
  if (ran.code !== 0 && !out.trim()) return { ok: false, text: `The query failed (exit ${ran.code}) with no output.` };
  // ssh's own noise (host-key notice) is not data.
  out = out.split('\n').filter(l => !/^Warning: Permanently added/.test(l)).join('\n').trim();
  if (out.length > MAX_OUTPUT_CHARS) out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n…[cut at ${MAX_OUTPUT_CHARS} characters]`;
  return { ok: ran.code === 0, text: out || '(no output for that window)' };
}
