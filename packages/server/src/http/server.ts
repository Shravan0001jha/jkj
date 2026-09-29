import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { createRouter, type RouterDeps } from './routes.js';
import { log } from '../util/logger.js';

/**
 * The HTTP server does two jobs: answer /api/*, and serve the built web UI.
 * In development the UI is served by Vite instead, and Vite proxies /api here.
 */

const WEB_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function createHttpServer(deps: RouterDeps): Server {
  const api = createRouter(deps);

  return createServer(async (req, res) => {
    if (await api(req, res)) return;
    serveStatic(req.url ?? '/', res);
  });
}

function serveStatic(rawUrl: string, res: import('node:http').ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Iris Workplace</h1><p>The web UI is not built yet. Run <code>npm run build</code>, or <code>npm run dev</code> and open the Vite URL.</p>');
    return;
  }

  const path = new URL(rawUrl, 'http://localhost').pathname;
  // Resolve inside WEB_DIST only — never let a request walk out of it.
  const candidate = join(WEB_DIST, normalize(path));
  const exists = candidate.startsWith(WEB_DIST) && existsSync(candidate) && statSync(candidate).isFile();
  // A missing hashed asset is a 404, not the page (QA B13): a stale tab then reloads instead of parsing HTML as a script.
  if (!exists && path.startsWith('/assets/')) {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ error: `No such asset: ${path}. The page was rebuilt; reload.` }));
    return;
  }
  const file = exists ? candidate : join(WEB_DIST, 'index.html');   // SPA fallback
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cacheControlFor(path, exists) });
  createReadStream(file).pipe(res);
}

/** Vite names assets by content hash, so they are immutable; the page itself is always revalidated (QA B13). */
export function cacheControlFor(path: string, isFile: boolean): string {
  if (isFile && path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/**
 * Loopback is always bound: the page on this Mac and the pairing route need
 * it. `--host <ip>` adds ONE more listener on that address (never 0.0.0.0),
 * which is how the phone reaches the Workplace over the LAN or the tailnet;
 * every request there must carry the bearer token.
 */
export function listen(server: Server, config: Config): Promise<void> {
  const hosts = ['127.0.0.1', ...(config.host && !['127.0.0.1', 'localhost', '::1'].includes(config.host) ? [config.host] : [])];
  return new Promise((resolve, reject) => {
    // A port already taken (another instance, or one still shutting down) fails the start; it never runs half-bound.
    server.once('error', err => reject(new Error(`cannot listen on http://${hosts[0]}:${config.port}: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
    server.listen(config.port, hosts[0], () => {
      log.info('http', `listening on http://${hosts[0]}:${config.port}`);
      if (hosts.length === 1) return resolve();
      const port = (server.address() as { port: number }).port;
      const extra = createServer((req, res) => server.emit('request', req, res));
      extra.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
      extra.on('error', reject);
      extra.listen(port, hosts[1], () => {
        log.info('http', `listening on http://${hosts[1]}:${port} (bearer token required)`);
        server.once('close', () => extra.close());
        resolve();
      });
    });
  });
}
