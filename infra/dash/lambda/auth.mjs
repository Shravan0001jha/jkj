// Owner-only email OTP login for dash.irisforu.com (HLD-dashboard §6). Pure: the store, mailer, clock and randomness are injected.
import { createHash, timingSafeEqual } from 'node:crypto';

export const OTP_TTL_MS = 10 * 60_000;
export const SESSION_MS = 90 * 86_400_000;
export const LOCK_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 5;
export const CODES_PER_15M = 3;
export const CODES_PER_DAY = 10;

const sha = s => createHash('sha256').update(s).digest('hex');
const norm = e => String(e ?? '').trim().toLowerCase();

/**
 * Always returns { ok: true }: a wrong email, a rate limit and a lockout look the same from outside.
 * A code is made and mailed only when the email is the owner's.
 */
export async function start(email, { store, mail, now, randomCode, owner }) {
  const t = now();
  if (norm(email) !== norm(owner)) return { ok: true };
  if ((await store.get('lock#login'))?.until > t) return { ok: true };
  const rl = (await store.get('rl#codes')) ?? { at: [] };
  const recent = rl.at.filter(x => x > t - 86_400_000);
  if (recent.filter(x => x > t - 15 * 60_000).length >= CODES_PER_15M || recent.length >= CODES_PER_DAY) return { ok: true };
  const code = randomCode();
  await store.put('otp#owner', { hash: sha(code + norm(owner)), exp: t + OTP_TTL_MS, attempts: 0 }, t + OTP_TTL_MS);
  await store.put('rl#codes', { at: [...recent, t] }, t + 86_400_000);
  await mail(norm(owner), code);
  return { ok: true };
}

/** { ok: true, token } on the right code; { ok: false } otherwise. Five wrong codes lock login for 15 minutes. */
export async function verify(email, code, { store, now, randomToken, owner, device }) {
  const t = now();
  if (norm(email) !== norm(owner)) return { ok: false };
  if ((await store.get('lock#login'))?.until > t) return { ok: false };
  const otp = await store.get('otp#owner');
  if (!otp || otp.exp <= t) return { ok: false };
  const want = Buffer.from(otp.hash, 'hex');
  const got = Buffer.from(sha(String(code ?? '').trim() + norm(owner)), 'hex');
  if (!timingSafeEqual(want, got)) {
    const attempts = otp.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await store.del('otp#owner');
      await store.put('lock#login', { until: t + LOCK_MS }, t + LOCK_MS);
    } else await store.put('otp#owner', { ...otp, attempts }, otp.exp);
    return { ok: false };
  }
  await store.del('otp#owner');
  const token = randomToken();
  await store.put(`sess#${sha(token)}`, { exp: t + SESSION_MS, created: t, device: String(device ?? '').slice(0, 120) }, t + SESSION_MS);
  return { ok: true, token };
}

/** True for a live session; renews it (sliding 90 days) at most once a day. */
export async function check(token, { store, now }) {
  if (!token) return false;
  const t = now();
  const key = `sess#${sha(token)}`;
  const s = await store.get(key);
  if (!s || s.exp <= t) return false;
  if (s.exp - t < SESSION_MS - 86_400_000) await store.put(key, { ...s, exp: t + SESSION_MS }, t + SESSION_MS);
  return true;
}

export async function logout(token, { store }) {
  if (token) await store.del(`sess#${sha(token)}`);
}
