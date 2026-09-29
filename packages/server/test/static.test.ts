import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheControlFor } from '../src/http/server.js';
import { boot } from './fakes/boot.js';

/** QA B13: hashed assets are immutable for a year, the page is always revalidated, a missing asset is a 404. */

const DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

test('cache-control per path', () => {
  assert.equal(cacheControlFor('/assets/index-abc123.js', true), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/index.html', true), 'no-cache');
  assert.equal(cacheControlFor('/', false), 'no-cache');
  assert.equal(cacheControlFor('/assets/gone.js', false), 'no-cache');
});

test('over HTTP: the page is no-cache, a hashed asset is immutable, a missing asset is a 404 not the page', { skip: !existsSync(join(DIST, 'index.html')) && 'web not built' }, async () => {
  const b = await boot();
  try {
    const page = await fetch(`${b.base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const js = readdirSync(join(DIST, 'assets')).find(f => f.endsWith('.js'))!;
    const asset = await fetch(`${b.base}/assets/${js}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    const gone = await fetch(`${b.base}/assets/index-oldhash.js`);
    assert.equal(gone.status, 404);
    assert.match(gone.headers.get('content-type') ?? '', /json/);
    const deep = await fetch(`${b.base}/inbox`);
    assert.equal(deep.status, 200, 'SPA fallback for routes');
    assert.equal(deep.headers.get('cache-control'), 'no-cache');
  } finally {
    await b.stop();
  }
});
