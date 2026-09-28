/**
 * The CSRF token the relay sets in a readable cookie beside the session cookie. The name carries
 * the `__Host-` prefix on https (the relay), and none on a plain dev origin; a browser client must
 * read either (QA B10, 29 Sep: the page matched only `wp_csrf=` and every POST through the relay
 * was refused with 403).
 */
export const CSRF_COOKIE = 'wp_csrf';

export function csrfTokenFrom(cookieHeader: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)(?:__Host-)?${CSRF_COOKIE}=([^;]+)`).exec(cookieHeader);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]!); } catch { return m[1]; }
}
