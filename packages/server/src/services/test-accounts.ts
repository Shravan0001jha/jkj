import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from './workplace.js';
import type { Db } from './store.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import { newId } from './store.js';
import { underTest } from './test-guard.js';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * The test-account pool (HLD §2 Services, LLD §W6.2; owner, 10 Oct: "it checks out a staging test
 * account and signs in on the agent's behalf; agents never see a secret").
 *
 * Accounts are staging accounts on the e2e domain, created on demand the same way the robot suite's
 * `create_account` does (e2e/scripts/local-run.sh → e2e/lib/iris.mjs `prepare`): an emailed sign-in
 * code read from the e2e code inbox, `/auth/verify` with the terms accepted, then `/admin/e2e/plan`
 * with the e2e-only admin key to put the account on the robot plan. The keys are read from SSM by
 * the server at sign-in time and never leave this process; the account's session token is kept under
 * the ops dir (which the guard keeps every session out of).
 *
 * A desktop lease is signed in for the agent exactly as the app signs itself in: the app's own
 * `credentials.json` ({email, token}, mode 0600, desktop/auth.js saveCreds) is written into a fresh
 * profile dir, `<workDir>/<emp>/test-profiles/<accountId>`, which the agent passes to the app as
 * `--user-data-dir`. The tool's answer carries the account id, email and that path, never the token.
 */

export type TestPlatform = 'desktop' | 'ios' | 'android';
export type AccountState = 'free' | 'leased' | 'broken';

export interface TestAccount {
  id: string;
  email: string;
  platform: TestPlatform;
  state: AccountState;
  leasedBy?: string;
  itemId?: string;
  leasedAt?: string;
  createdAt: string;
}

/** What a lease hands back: the account and where its signed-in profile is. Never a token. */
export interface Lease {
  accountId: string;
  email: string;
  platform: TestPlatform;
  expiresAt: string;
  /** Desktop only: the profile dir to pass as --user-data-dir, already signed in. */
  profilePath?: string;
}

export interface TestAccountPort {
  /** Signs the address in (creating the account the first time) and puts it on the robot plan. */
  signIn(email: string): Promise<{ token: string }>;
  /** False when the account API refuses the token (revoked, account gone). */
  tokenValid(token: string): Promise<boolean>;
}

export const LEASE_MS = 4 * 60 * 60_000;
/** A runaway loop must not mint accounts without end: the pool stops growing here. */
export const POOL_MAX = 30;
export const EMAIL_DOMAIN = 'e2e.irisforu.com';

/* ---------- the store ---------- */

const ready = new WeakSet<Db>();

function db(wp: Workplace): Db {
  if (!ready.has(wp.db)) {
    wp.db.exec(`create table if not exists test_accounts (
      id text primary key,
      email text not null unique,
      platform text not null,
      state text not null,
      leased_by text,
      item_id text,
      leased_at text,
      created_at text not null
    )`);
    ready.add(wp.db);
  }
  return wp.db;
}

interface Row { id: string; email: string; platform: TestPlatform; state: AccountState; leased_by: string | null; item_id: string | null; leased_at: string | null; created_at: string }

const fromRow = (r: Row): TestAccount => ({
  id: r.id, email: r.email, platform: r.platform, state: r.state, createdAt: r.created_at,
  ...(r.leased_by ? { leasedBy: r.leased_by } : {}),
  ...(r.item_id ? { itemId: r.item_id } : {}),
  ...(r.leased_at ? { leasedAt: r.leased_at } : {}),
});

function getRow(wp: Workplace, id: string): TestAccount | undefined {
  const r = db(wp).prepare('select * from test_accounts where id = ?').get(id) as unknown as Row | undefined;
  return r ? fromRow(r) : undefined;
}

export function list(wp: Workplace): TestAccount[] {
  return (db(wp).prepare('select * from test_accounts order by created_at, rowid').all() as unknown as Row[]).map(fromRow);
}

/* ---------- the server-side token store (never in the database, never in a tool answer) ---------- */

const tokenDir = (wp: Workplace): string => join(wp.config.opsDir, 'workplace', 'test-accounts');
const tokenFile = (wp: Workplace, id: string): string => join(tokenDir(wp), `${id}.json`);

function keepToken(wp: Workplace, id: string, email: string, token: string): void {
  mkdirSync(tokenDir(wp), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(wp, id), JSON.stringify({ email, token }), { mode: 0o600 });
  chmodSync(tokenFile(wp, id), 0o600);
}

function keptToken(wp: Workplace, id: string): string | null {
  try { const t = (JSON.parse(readFileSync(tokenFile(wp, id), 'utf8')) as { token?: unknown }).token; return typeof t === 'string' && t ? t : null; } catch { return null; }
}

/* ---------- profiles ---------- */

export const profilePath = (wp: Workplace, emp: string, accountId: string): string => join(wp.config.workDir, emp, 'test-profiles', accountId);

/** A fresh profile, signed in the way the app signs itself in (desktop/auth.js saveCreds). */
function seedProfile(wp: Workplace, emp: string, accountId: string, email: string, token: string): string {
  const dir = profilePath(wp, emp, accountId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify({ email, token }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return dir;
}

const dropProfile = (wp: Workplace, emp: string | undefined, accountId: string): void => {
  if (emp) rmSync(profilePath(wp, emp, accountId), { recursive: true, force: true });
};

/* ---------- the port ---------- */

let port: TestAccountPort | null = null;

/** Swap the account port (tests); returns the restore. */
export function usePort(p: TestAccountPort): () => void {
  const prev = port;
  port = p;
  return () => { port = prev; };
}

function currentPort(wp: Workplace): TestAccountPort {
  if (port) return port;
  // Never a real staging account from a test run.
  if (underTest()) throw new BadRequest('No test-account port in a test: install a fake with usePort().');
  port = e2eAccountPort({ api: wp.config.evidence.stagingUrl, secrets: awsSecrets() });
  return port;
}

/* ---------- staging: up before any account call (dry run 10 Oct, gap #4) ---------- */

/** What the lease needs of staging: healthy, or started and then healthy; throws when it does not come up. */
export interface StagingGate { ensureUp(): Promise<void> }

/** How long a lease waits for a stopped staging to start. */
export const STAGING_WAIT_MS = 6 * 60_000;
export const STAGING_OFF = 'Staging is off and could not be started; told the COO.';
/** One COO item per outage: a repeat within this window is not raised again. */
const COO_REPEAT_MS = 60 * 60_000;

let stagingGate: StagingGate | null = null;
let stagingWaitMs = STAGING_WAIT_MS;
const cooToldAt = new WeakMap<Workplace, number>();

/** Swap the staging gate (tests), optionally with a shorter wait; returns the restore. */
export function useStaging(s: StagingGate, waitMs = STAGING_WAIT_MS): () => void {
  const prev = { gate: stagingGate, wait: stagingWaitMs };
  stagingGate = s;
  stagingWaitMs = waitMs;
  return () => { stagingGate = prev.gate; stagingWaitMs = prev.wait; };
}

/** The gate: the one run_evidence uses (evidence-ports RealStaging: healthz, else staging.sh start). */
async function currentStaging(wp: Workplace): Promise<StagingGate | null> {
  if (stagingGate) return stagingGate;
  // Never a real staging from a test run: without a fake, staging counts as up.
  if (underTest()) return null;
  const evidence = await import('./evidence.js');
  return evidence.stagingPort(wp);
}

/**
 * Staging up, within the bound; else the clear message (and the COO told once per outage), never a
 * raw network error. A start still running past the bound carries on: the next lease finds it up.
 */
async function ensureStaging(wp: Workplace, spec: { emp: string; itemId: string }): Promise<void> {
  const gate = await currentStaging(wp);
  if (!gate) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.ensureUp(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`staging did not come up within ${Math.round(stagingWaitMs / 60_000) || '<1'} min`)), stagingWaitMs); timer.unref?.(); }),
    ]);
    cooToldAt.delete(wp);
  } catch (err) {
    const why = safeError(err);
    log.warn('test-accounts', `staging is not up for ${spec.emp} on ${spec.itemId}: ${why}`);
    const last = cooToldAt.get(wp);
    if (last === undefined || Date.now() - last > COO_REPEAT_MS) {
      cooToldAt.set(wp, Date.now());
      try {
        coo.notifyStall(wp, {
          itemId: spec.itemId, by: 'workplace',
          title: 'Staging is off and could not be started (test-account lease)',
          body: `lease_test_account for ${spec.emp} on ${spec.itemId} needed staging (${wp.config.evidence.stagingUrl}), which is not answering and did not come up: ${why}. Start it (scripts/staging.sh start) and tell them to try again.`,
        });
      } catch (e) { log.warn('test-accounts', `COO not told: ${safeError(e)}`); }
    }
    throw new BadRequest(STAGING_OFF);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------- lease / return / expiry ---------- */

/** The least recently used free account, claimed in one synchronous step (two leases never share one). */
function claimFree(wp: Workplace, spec: { emp: string; itemId: string; platform: TestPlatform }, at: string): TestAccount | undefined {
  const free = db(wp).prepare("select id from test_accounts where state = 'free' order by coalesce(leased_at, created_at), rowid limit 1").get() as { id: string } | undefined;
  if (!free) return undefined;
  db(wp).prepare("update test_accounts set state = 'leased', leased_by = ?, item_id = ?, leased_at = ?, platform = ? where id = ?").run(spec.emp, spec.itemId, at, spec.platform, free.id);
  return getRow(wp, free.id);
}

function release(wp: Workplace, id: string, state: AccountState = 'free'): void {
  db(wp).prepare('update test_accounts set state = ?, leased_by = null, item_id = null where id = ?').run(state, id);
}

/**
 * lease_test_account: a staging test account for this person and story, for four hours. A free one
 * from the pool when there is one, else a new one. On desktop the profile is signed in for them.
 */
export async function lease(wp: Workplace, spec: { emp: string; itemId: string; platform: TestPlatform }, nowMs = Date.now()): Promise<Lease> {
  expireLeases(wp, nowMs);
  const p = currentPort(wp);
  await ensureStaging(wp, spec);
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + LEASE_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = claimFree(wp, spec, at);
    let account: TestAccount;
    let token: string | null = null;
    if (claimed) {
      account = claimed;
      if (spec.platform === 'desktop') {
        token = keptToken(wp, account.id);
        try {
          if (!token || !(await p.tokenValid(token))) {
            token = (await p.signIn(account.email)).token;
            keepToken(wp, account.id, account.email, token);
          }
        } catch (err) {
          // This account cannot be signed in now: set it aside and try the next.
          log.warn('test-accounts', `${account.id} could not be signed in: ${safeError(err)}`);
          release(wp, account.id, 'broken');
          continue;
        }
      }
    } else {
      const total = (db(wp).prepare("select count(*) as n from test_accounts where state != 'broken'").get() as { n: number }).n;
      if (total >= POOL_MAX) throw new BadRequest(`All ${POOL_MAX} test accounts are leased. Return one you are done with (return_test_account), or wait for a lease to end.`);
      const id = newId('ta');
      const email = `workplace-${id.slice(3)}@${EMAIL_DOMAIN}`;
      // The row is written (leased) before the sign-in, so a concurrent lease never takes it.
      db(wp).prepare("insert into test_accounts (id, email, platform, state, leased_by, item_id, leased_at, created_at) values (?, ?, ?, 'leased', ?, ?, ?, ?)").run(id, email, spec.platform, spec.emp, spec.itemId, at, at);
      try {
        token = (await p.signIn(email)).token;
      } catch (err) {
        db(wp).prepare('delete from test_accounts where id = ?').run(id);
        throw new BadRequest(`Could not create a test account: ${safeError(err)}`);
      }
      keepToken(wp, id, email, token);
      account = getRow(wp, id)!;
      log.info('test-accounts', `created ${id} (${email})`);
    }
    const lease: Lease = { accountId: account.id, email: account.email, platform: spec.platform, expiresAt };
    if (spec.platform === 'desktop') lease.profilePath = seedProfile(wp, spec.emp, account.id, account.email, token!);
    trail.record(wp, { itemId: spec.itemId, by: spec.emp, kind: 'note', text: `leased test account ${account.email} (${spec.platform})` });
    return lease;
  }
  throw new BadRequest('No test account could be signed in just now; try again in a few minutes.');
}

/** return_test_account: back to the pool; the profile (and the token in it) is removed. */
export function giveBack(wp: Workplace, accountId: string, emp: string): TestAccount {
  const a = getRow(wp, accountId);
  if (!a) throw new BadRequest(`No test account ${accountId}.`);
  if (a.state !== 'leased') throw new BadRequest(`${accountId} is not leased.`);
  if (a.leasedBy !== emp) throw new BadRequest(`${accountId} is leased by ${a.leasedBy}, not you.`);
  dropProfile(wp, a.leasedBy, a.id);
  release(wp, a.id);
  return getRow(wp, a.id)!;
}

/** Leases past four hours end by themselves (the sweep, and every lease). Returns the ids freed. */
export function expireLeases(wp: Workplace, nowMs = Date.now()): string[] {
  const leased = (db(wp).prepare("select * from test_accounts where state = 'leased'").all() as unknown as Row[]).map(fromRow);
  const freed: string[] = [];
  for (const a of leased) {
    const t = a.leasedAt ? Date.parse(a.leasedAt) : NaN;
    if (!Number.isFinite(t) || nowMs <= t + LEASE_MS) continue;
    dropProfile(wp, a.leasedBy, a.id);
    release(wp, a.id);
    freed.push(a.id);
    if (a.itemId) {
      try { trail.comment(wp, a.itemId, { by: 'workplace', text: `@${a.leasedBy} Your lease of test account ${a.email} expired after 4 hours; its profile was removed. Call lease_test_account again if you still need one.` }); } catch { /* item gone */ }
    }
  }
  return freed;
}

/* ---------- the real port: the e2e account API, mirroring e2e/lib/iris.mjs ---------- */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface E2eSecrets {
  /** An SSM SecureString, decrypted. */
  ssm(name: string): Promise<string>;
  /** The e2e code inbox's Function URL. */
  codesUrl(): Promise<string>;
}

export const E2E_TOKEN_PARAM = '/iris-alpha/e2e-token';
export const E2E_ADMIN_KEY_PARAM = '/iris-staging/e2e-admin-key';

/** Only the request and status: an error never carries a response body (it could echo a key). */
function safeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
}

export function e2eAccountPort(o: { api: string; secrets: E2eSecrets; fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; codeGapMs?: number; codeTimeoutMs?: number }): TestAccountPort {
  const api = o.api.replace(/\/+$/, '');
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }) as never);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const gapMs = o.codeGapMs ?? 50_000;
  const timeoutMs = o.codeTimeoutMs ?? 90_000;

  async function latest(codes: string, auth: string, email: string): Promise<{ code: string; at: number } | null> {
    const r = await f(`${codes}?to=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${auth}` } });
    if (!r.ok) return null;
    const j = await r.json() as { code?: unknown; at?: unknown };
    return { code: String(j.code ?? '').replace(/\D/g, ''), at: Date.parse(String(j.at ?? '')) || 0 };
  }

  return {
    async signIn(email) {
      const e2eToken = await o.secrets.ssm(E2E_TOKEN_PARAM);
      const codes = (await o.secrets.codesUrl()).replace(/\/+$/, '');
      // Only the newest code is valid and sends are 30 s apart: wait until the last one is old enough.
      for (let i = 0; i < 20; i++) {
        const l = await latest(codes, e2eToken, email).catch(() => null);
        const age = l ? Date.now() - l.at : Infinity;
        if (age >= gapMs) break;
        await sleep(gapMs - age);
      }
      const t = Date.now();
      let sent = false;
      for (let i = 0; i < 4 && !sent; i++) {
        const r = await f(`${api}/auth/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
        if (r.ok) { sent = true; break; }
        const j = await r.json().catch(() => ({})) as { reason?: string; retry_after_s?: number };
        if (r.status === 429 && j.reason === 'too_soon') { await sleep((j.retry_after_s ?? 30) * 1000 + 500); continue; }
        throw new Error(`/auth/code ${r.status}`);
      }
      if (!sent) throw new Error('/auth/code kept rate-limiting');
      let code = '';
      for (const t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
        const l = await latest(codes, e2eToken, email).catch(() => null);
        if (l && l.code.length === 6 && l.at >= t - 3000) { code = l.code; break; }
        await sleep(4000);
      }
      if (!code) throw new Error(`no sign-in code for ${email} within ${Math.round(timeoutMs / 1000)} s`);
      // accepted_terms: the robot consents for its own throwaway e2e account (lib/iris.mjs verify).
      const v = await f(`${api}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code, accepted_terms: true }) });
      const vj = await v.json().catch(() => ({})) as { token?: unknown };
      if (!v.ok || typeof vj.token !== 'string' || !vj.token) throw new Error(`/auth/verify ${v.status}`);
      // The robot plan, so a long test is not cut short by the human tester quota (lib/iris.mjs setRobotPlan).
      const admin = await o.secrets.ssm(E2E_ADMIN_KEY_PARAM);
      const plan = await f(`${api}/admin/e2e/plan`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: JSON.stringify({ email, plan: 'robot' }) });
      if (!plan.ok) throw new Error(`/admin/e2e/plan ${plan.status}`);
      return { token: vj.token };
    },
    async tokenValid(token) {
      try {
        const r = await f(`${api}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
        return r.status !== 401 && r.status !== 403;
      } catch {
        return true;   // offline: keep the token, as the app does (desktop/auth.js tokenValid)
      }
    },
  };
}

/** SSM and the code inbox's URL through the aws CLI the ops scripts use (ap-south-1). Values never logged. */
export function awsSecrets(region = 'ap-south-1'): E2eSecrets {
  const aws = (args: string[], what: string): Promise<string> => new Promise((resolve, reject) => {
    execFile('aws', ['--region', region, ...args, '--output', 'text'], { timeout: 30_000, env: { ...process.env, AWS_PAGER: '' } }, (err, stdout) => {
      const v = String(stdout ?? '').trim();
      if (err || !v || v === 'None') return reject(new Error(`could not read ${what} (aws CLI signed in? region ${region})`));
      resolve(v);
    });
  });
  return {
    ssm: name => aws(['ssm', 'get-parameter', '--with-decryption', '--name', name, '--query', 'Parameter.Value'], name),
    codesUrl: () => aws(['lambda', 'get-function-url-config', '--function-name', 'iris-alpha-e2e-codes', '--query', 'FunctionUrl'], 'the e2e code inbox URL'),
  };
}
