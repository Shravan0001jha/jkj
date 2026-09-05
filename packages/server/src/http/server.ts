import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { createRouter } from './routes.js';
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

export function createHttpServer(config: Config): Server {
  const api = createRouter(config);

  return createServer(async (req, res) => {
    if (await api(req, res)) return;
    serveStatic(req.url ?? '/', res);
  });
}

function serveStatic(rawUrl: string, res: import('node:http').ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>JKJ</h1><p>The web UI is not built yet. Run <code>npm run dev</code> and open the Vite URL.</p>');
    return;
  }

  const path = new URL(rawUrl, 'http://localhost').pathname;
  // Resolve inside WEB_DIST only — never let a request walk out of it.
  const candidate = join(WEB_DIST, normalize(path));
  const file = candidate.startsWith(WEB_DIST) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(WEB_DIST, 'index.html');   // SPA fallback

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

export function listen(server: Server, config: Config): Promise<void> {
  return new Promise(resolve => {
    server.listen(config.port, config.host, () => {
      log.info('http', `listening on http://${config.host}:${config.port}`);
      resolve();
    });
  });
}
