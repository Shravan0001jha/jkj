import type { IncomingMessage, ServerResponse } from 'node:http';
import { API } from '@jkj/shared';
import type { Config } from '../config.js';
import * as projects from '../services/projects.js';
import * as agents from '../services/agents.js';
import * as context from '../services/context.js';
import * as mcp from '../services/mcp.js';
import * as activity from '../services/activity.js';
import { findClaudeHome } from '../runtime/claude-home.js';

/**
 * REST surface. One entry per route so the whole API is readable at a glance.
 * Handlers translate between HTTP and a service call and decide nothing.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

interface Route {
  method: string;
  match: (path: string) => boolean;
  handler: Handler;
}

export function createRouter(config: Config) {
  const startedAt = Date.now();

  const routes: Route[] = [
    {
      method: 'GET',
      match: p => p === API.health,
      handler: (_req, res) => {
        const home = findClaudeHome();
        json(res, 200, {
          ok: true,
          name: 'jkj',
          version: config.version,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          claudeHome: home.present ? home.configDir : null,
        });
      },
    },
    {
      method: 'GET',
      match: p => p === API.projects,
      handler: async (_req, res) => json(res, 200, await projects.listProjects()),
    },
    {
      method: 'GET',
      match: p => p === API.agents,
      handler: async (_req, res, url) =>
        json(res, 200, await agents.listAgents(url.searchParams.get('projectId') ?? undefined)),
    },
    {
      method: 'GET',
      match: p => p.startsWith('/api/agents/') && p.endsWith('/log'),
      handler: async (_req, res, url) => {
        const id = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/log'.length));
        json(res, 200, await agents.getTranscript(id));
      },
    },
    {
      method: 'GET',
      match: p => p.startsWith('/api/agents/') && p.endsWith('/image'),
      handler: async (_req, res, url) => {
        const id = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/image'.length));
        const image = await agents.getImage(id, url.searchParams.get('ref') ?? '');
        if (!image) return json(res, 404, { error: 'No such image' });

        res.writeHead(200, {
          'content-type': image.mediaType,
          'content-length': image.data.byteLength,
          // The bytes for a given ref never change, so let the browser keep them.
          'cache-control': 'private, max-age=86400, immutable',
        });
        res.end(image.data);
      },
    },
    {
      method: 'GET',
      match: p => p === '/api/context',
      handler: async (_req, res, url) => {
        const projectId = url.searchParams.get('projectId') ?? '';
        json(res, 200, {
          central: context.getCentralContext(),
          project: await context.getProjectContext(projectId),
          assembled: await context.assembleContext(projectId),
        });
      },
    },
    {
      method: 'PUT',
      match: p => p === '/api/context',
      handler: async (req, res, url) => {
        const body = await readJson(req);
        const text = typeof body.body === 'string' ? body.body : '';
        const projectId = url.searchParams.get('projectId');

        json(res, 200, body.scope === 'central'
          ? context.setCentralContext(text)
          : await context.setProjectContext(projectId ?? '', text));
      },
    },
    {
      method: 'GET',
      match: p => p === API.mcp,
      handler: async (_req, res) => json(res, 200, {
        installed: await mcp.listInstalled(),
        catalog: mcp.listCatalog(),
      }),
    },
    {
      method: 'GET',
      match: p => p === API.activity,
      handler: async (_req, res) => json(res, 200, await activity.listActivity()),
    },
  ];

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) return false;

    const route = routes.find(r => r.method === req.method && r.match(url.pathname));
    if (!route) {
      json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return true;
    }

    try {
      await route.handler(req, res, url);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : 'Unknown error' });
    }
    return true;
  };
}

/* ---------- helpers ---------- */

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Request body was not valid JSON');
  }
}
