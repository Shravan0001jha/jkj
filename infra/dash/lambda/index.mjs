// dash.irisforu.com API (HLD-dashboard §6): owner-only email OTP, then the private snapshot. Behind CloudFront `/api/*`.
import { randomBytes, randomInt } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { start, verify, check, logout, SESSION_MS } from './auth.mjs';

const { OWNER_EMAIL, TABLE, DATA_BUCKET, MAIL_FROM, SES_REGION = 'ap-south-1' } = process.env;
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({ region: SES_REGION });
const COOKIE = '__Host-dash';
const MIN_START_MS = 600;   // login/start answers no faster than this, owner email or not

const store = {
  async get(k) {
    const r = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { k: { S: k } }, ConsistentRead: true }));
    if (!r.Item) return null;
    if (Number(r.Item.ttl?.N ?? 0) * 1000 <= Date.now()) return null;   // DynamoDB TTL deletes lazily
    return JSON.parse(r.Item.v.S);
  },
  async put(k, item, ttlMs) {
    await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { k: { S: k }, v: { S: JSON.stringify(item) }, ttl: { N: String(Math.ceil(ttlMs / 1000)) } } }));
  },
  async del(k) { await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { k: { S: k } } })); },
};

async function mail(to, code) {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: MAIL_FROM,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: `Iris Workplace sign-in code: ${code}` },
      Body: { Text: { Data: `Your code for dash.irisforu.com is ${code}.\n\nIt works once and expires in 10 minutes. If you didn't ask for it, ignore this email.` } },
    } },
  }));
}

const ctx = extra => ({
  store, mail, owner: OWNER_EMAIL, now: () => Date.now(),
  randomCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
  randomToken: () => randomBytes(32).toString('base64url'),
  ...extra,
});

const res = (status, body, headers = {}, cookies) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  ...(cookies ? { cookies } : {}),
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const tokenOf = ev => {
  for (const c of ev.cookies ?? []) { const i = c.indexOf('='); if (c.slice(0, i).trim() === COOKIE) return c.slice(i + 1).trim(); }
  return null;
};
const body = ev => { try { return JSON.parse(ev.isBase64Encoded ? Buffer.from(ev.body ?? '', 'base64').toString() : ev.body ?? '{}'); } catch { return {}; } };

export async function handler(ev) {
  const method = ev.requestContext?.http?.method ?? 'GET';
  const path = ev.rawPath ?? '/';
  // Non-GET calls must carry a custom header: browsers can't add one cross-site without CORS, and we allow no CORS.
  if (method !== 'GET' && ev.headers?.['x-dash'] !== '1') return res(403, { error: 'Missing x-dash header.' });
  try {
    if (method === 'POST' && path === '/api/login/start') {
      const t = Date.now();
      await start(body(ev).email, ctx());
      const wait = MIN_START_MS - (Date.now() - t);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      return res(200, { ok: true });
    }
    if (method === 'POST' && path === '/api/login/verify') {
      const b = body(ev);
      const r = await verify(b.email, b.code, ctx({ device: ev.headers?.['user-agent'] }));
      if (!r.ok) return res(401, { ok: false, error: 'That code did not work. Check it, or ask for a new one.' });
      const cookie = `${COOKIE}=${r.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
      return res(200, { ok: true }, {}, [cookie]);
    }
    if (method === 'POST' && path === '/api/logout') {
      await logout(tokenOf(ev), ctx());
      return res(200, { ok: true }, {}, [`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`]);
    }
    if (method === 'GET' && (path === '/api/me' || path === '/api/snapshot')) {
      if (!(await check(tokenOf(ev), ctx()))) return res(401, { ok: false });
      if (path === '/api/me') return res(200, { ok: true });
      const obj = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: 'snapshot-v1.json' }));
      return res(200, await obj.Body.transformToString());
    }
    return res(404, { error: 'Not found.' });
  } catch (e) {
    console.error(e);
    return res(500, { error: 'Something went wrong on the server.' });
  }
}
