import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csrfTokenFrom } from '@jkj/shared';

/** QA B10: the relay's cookie is `__Host-wp_csrf`; the page must read it, or every POST is a 403. */
test('the CSRF token is read from the relay\'s __Host- cookie and from a plain one', () => {
  assert.equal(csrfTokenFrom('__Host-wp_session=abc; __Host-wp_csrf=t0k3n; __Host-wp_device=d'), 't0k3n');
  assert.equal(csrfTokenFrom('wp_csrf=plain'), 'plain');
  assert.equal(csrfTokenFrom('x=1; __Host-wp_csrf=a%2Fb'), 'a/b');
  assert.equal(csrfTokenFrom('notwp_csrf=nope'), undefined);
  assert.equal(csrfTokenFrom(''), undefined);
});
