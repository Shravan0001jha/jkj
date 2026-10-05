import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { EvidenceRunRecord, EvidenceServer, EvidenceShare } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { underTest } from './test-guard.js';

/**
 * The global evidence link (docs/HLD-evidence.md D13): after each run, one self-contained HTML (the
 * report with its screenshots inlined, plus summary.txt) goes to a private S3 bucket, and a 7-day
 * presigned URL is what the item, the PR and the workplace/evidence status link to. The 127.0.0.1
 * report route stays for the Mac itself; nobody else can open it.
 */

export const SHARE_TTL_S = 7 * 24 * 3600;
/** A link with less than this left is re-signed before it is posted again. */
const RESIGN_MARGIN_MS = 60 * 60_000;
const REGION = 'ap-south-1';
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const LOG_LINES_KEPT = 300;

/* ---------- the store (a port: the real one is the aws CLI) ---------- */

export interface EvidenceStore {
  /** Upload a local file under `key` (text/html). */
  put(file: string, key: string): Promise<void>;
  /** A GET URL for `key`, valid for `seconds`. */
  presign(key: string, seconds: number): Promise<string>;
}

const stores = new WeakMap<Workplace, EvidenceStore>();

export function useEvidenceStore(wp: Workplace, store: EvidenceStore): void { stores.set(wp, store); }

/** Tests never reach AWS: without a fake, the store is unavailable (the evidence still counts). */
export function storeOf(wp: Workplace): EvidenceStore {
  let s = stores.get(wp);
  if (!s) { s = underTest() ? new UnavailableStore() : new S3Store(); stores.set(wp, s); }
  return s;
}

class UnavailableStore implements EvidenceStore {
  async put(): Promise<void> { throw new Error('no evidence store in tests'); }
  async presign(): Promise<string> { throw new Error('no evidence store in tests'); }
}

function aws(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('aws', ['--region', REGION, '--output', 'text', ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${(String(stderr).trim().split('\n').at(-1) ?? err.message).slice(0, 200)}`));
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * `iris-workplace-evidence-<account id>` in ap-south-1, made on first use if missing: all public
 * access blocked, SSE-S3, objects expire after 90 days, tagged Project=iris-workplace.
 */
export class S3Store implements EvidenceStore {
  private ready: Promise<string> | null = null;

  bucket(): Promise<string> {
    this.ready ??= this.ensure().catch(err => { this.ready = null; throw err; });
    return this.ready;
  }

  private async ensure(): Promise<string> {
    const account = await aws(['sts', 'get-caller-identity', '--query', 'Account']);
    if (!/^\d{12}$/.test(account)) throw new Error('could not read the AWS account id');
    const bucket = `iris-workplace-evidence-${account}`;
    let exists = true;
    try { await aws(['s3api', 'head-bucket', '--bucket', bucket]); } catch { exists = false; }
    if (!exists) await aws(['s3api', 'create-bucket', '--bucket', bucket, '--create-bucket-configuration', `LocationConstraint=${REGION}`, '--object-ownership', 'BucketOwnerEnforced']);
    // Re-applied every boot (idempotent): the bucket's settings are this code's, not a console's.
    await aws(['s3api', 'put-public-access-block', '--bucket', bucket, '--public-access-block-configuration', 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true']);
    await aws(['s3api', 'put-bucket-encryption', '--bucket', bucket, '--server-side-encryption-configuration', JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] })]);
    await aws(['s3api', 'put-bucket-lifecycle-configuration', '--bucket', bucket, '--lifecycle-configuration', JSON.stringify({ Rules: [{ ID: 'expire-90-days', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 90 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] })]);
    await aws(['s3api', 'put-bucket-tagging', '--bucket', bucket, '--tagging', 'TagSet=[{Key=Project,Value=iris-workplace}]']);
    return bucket;
  }

  async put(file: string, key: string): Promise<void> {
    const bucket = await this.bucket();
    await aws(['s3', 'cp', '--only-show-errors', '--content-type', 'text/html; charset=utf-8', '--sse', 'AES256', file, `s3://${bucket}/${key}`], 300_000);
  }

  async presign(key: string, seconds: number): Promise<string> {
    const bucket = await this.bucket();
    const url = await aws(['s3', 'presign', `s3://${bucket}/${key}`, '--expires-in', String(seconds)]);
    if (!/^https:\/\//.test(url)) throw new Error('aws s3 presign returned no URL');
    return url;
  }
}

/* ---------- the bundle ---------- */

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The file a relative report link names, if it stays inside the run directory. */
function inRun(runDir: string, ref: string): string | null {
  if (/^([a-z]+:|#|\/)/i.test(ref) || ref.includes('..')) return null;
  let rel: string;
  try { rel = decodeURIComponent(ref.split(/[?#]/)[0]!); } catch { return null; }
  const file = join(runDir, rel);
  return file.startsWith(runDir + sep) && existsSync(file) && statSync(file).isFile() ? file : null;
}

/** Which server the run tested against: the story's own deployed commit, or what staging was on. */
export function serverLine(srv: EvidenceServer): string {
  if (srv.deployed) return `server: iris-api and cloud-agent at ${(srv.sha ?? '').slice(0, 8)} on staging`;
  const was = srv.sha ? `staging was on iris-api and cloud-agent at ${srv.sha.slice(0, 8)}` : 'staging\'s iris-api and cloud-agent commit is unknown';
  const moved = srv.changedTo === undefined ? '' : `; staging was redeployed${srv.changedTo ? ` to ${srv.changedTo.slice(0, 8)}` : ''} during the run`;
  return `server: ${was} (this story does not change them)${moved}`;
}

/**
 * One self-contained HTML: index.html with every screenshot it shows inlined as base64, links to
 * files not carried (logs, full-size images) disabled, and summary.txt appended. Null without a report.
 */
export function bundle(runDir: string, rec: EvidenceRunRecord, title: string): string | null {
  const index = join(runDir, 'index.html');
  const summaryFile = join(runDir, 'summary.txt');
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '';
  let html = existsSync(index) ? readFileSync(index, 'utf8') : '';
  if (!html && !summary) return null;
  const cache = new Map<string, string>();
  const dataUri = (file: string): string => {
    let d = cache.get(file);
    if (!d) { d = `data:${IMAGE_TYPES[extname(file).toLowerCase()]};base64,${readFileSync(file).toString('base64')}`; cache.set(file, d); }
    return d;
  };
  html = html.replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (all, pre: string, q: string, ref: string) => {
    const file = inRun(runDir, ref);
    return file && IMAGE_TYPES[extname(file).toLowerCase()] ? `${pre}${q}${dataUri(file)}${q}` : all;
  });
  // The screenshot is already on the page; a log is not in this copy (it stays on the Mac).
  html = html.replace(/(<a\b[^>]*?\bhref=)(["'])([^"'#][^"']*)\2/gi, (all, pre: string, q: string, ref: string) =>
    /^[a-z]+:/i.test(ref) ? all : `${pre}${q}#${q} title=${q}${esc(ref)} is on the Mac, not in this copy${q}`);
  const header = `<div style="font:13px system-ui,sans-serif;padding:8px 12px;background:#f3f4f6;color:#111;border-bottom:1px solid #ddd">` +
    `Iris Workplace evidence: ${esc(title)} — ${esc(rec.sha.slice(0, 12))} — ${esc(rec.state)} (${rec.passed} passed, ${rec.failed} failed) — run ${esc(rec.run)}${rec.server ? ` — ${esc(serverLine(rec.server))}` : ''}</div>`;
  const tail = `<section style="font:13px system-ui,sans-serif;padding:12px"><h2>summary.txt</h2><pre style="white-space:pre-wrap">${esc(summary)}</pre></section>`;
  if (!html) return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${header}${tail}`;
  html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, m => m + header) : header + html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tail}</body>`) : html + tail;
}

/** Upload the bundle and sign a link. Null with the reason when it could not (the evidence still counts). */
export async function share(wp: Workplace, itemId: string, runDir: string, rec: EvidenceRunRecord, title: string): Promise<{ share: EvidenceShare } | { error: string }> {
  try {
    const html = bundle(runDir, rec, title);
    if (!html) return { error: 'the run left no report' };
    const file = join(runDir, 'evidence.html');
    writeFileSync(file, html);
    const key = `${itemId}/${rec.run}/evidence.html`;
    const store = storeOf(wp);
    await store.put(file, key);
    const url = await store.presign(key, SHARE_TTL_S);
    return { share: { key, url, expiresAt: new Date(Date.now() + SHARE_TTL_S * 1000).toISOString() } };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200) };
  }
}

/** The link, re-signed when it has expired (or is about to). Null when it cannot be. */
export async function freshLink(wp: Workplace, s: EvidenceShare, nowMs = Date.now()): Promise<EvidenceShare | null> {
  if (Date.parse(s.expiresAt) - nowMs > RESIGN_MARGIN_MS) return s;
  try {
    const url = await storeOf(wp).presign(s.key, SHARE_TTL_S);
    return { ...s, url, expiresAt: new Date(nowMs + SHARE_TTL_S * 1000).toISOString() };
  } catch { return null; }
}

/* ---------- slimming the local copy ---------- */

/** PASS: raw/ goes and every log keeps its last 300 lines. Anything else keeps everything. */
export function slim(runDir: string, state: EvidenceRunRecord['state']): void {
  if (state !== 'success' || !existsSync(runDir)) return;
  rmSync(join(runDir, 'raw'), { recursive: true, force: true });
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(log|txt)$/.test(name) && relative(runDir, p) !== 'summary.txt') {
        const lines = readFileSync(p, 'utf8').split('\n');
        if (lines.length > LOG_LINES_KEPT + 1) writeFileSync(p, lines.slice(-(LOG_LINES_KEPT + 1)).join('\n'));
      }
    }
  };
  walk(runDir);
}
