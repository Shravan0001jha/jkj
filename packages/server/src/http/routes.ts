import type { IncomingMessage, ServerResponse } from 'node:http';
import { API } from '@jkj/shared';
import type { Config } from '../config.js';
import * as projects from '../services/projects.js';
import * as agents from '../services/agents.js';
import * as context from '../services/context.js';
import * as mcp from '../services/mcp.js';

/**
 * REST surface. One function per route, registered in a table so the list of
 * endpoints is readable at a glance.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

export function createRouter(config: Config) {
  const startedAt = Date.now();

  const routes: { method: string; match: (p: string) => boolean; handler: Handler }[] = [
    {
      method: 'GET',
      match: p => p === API.health,
      handler: (_req, res) => json(res, 200, {
        ok: true,
        name: 'jkj',
        version: config.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      }),
    },
    {
      method: 'GET',
      match: p => p === API.projects,
      handler: (_req, res) => json(res, 200, projects.listProjects()),
    },
    {
      method: 'GET',
      match: p => p === API.agents,
      handler: (_req, res, url) => json(res, 200, agents.listAgents(url.searchParams.get('projectId') ?? undefined)),
    },
    {
      method: 'POST',
      match: p => p === API.agents,
      handler: async (req, res) => {
        const body = await readJson(req);
        // TODO: validate the body properly before it reaches the service.
        json(res, 201, agents.createAgent(body));
      },
    },
    {
      method: 'GET',
      match: p => p.startsWith('/api/agents/') && p.endsWith('/log'),
      handler: (_req, res, url) => {
        const id = url.pathname.split('/')[3] ?? '';
        json(res, 200, agents.getTranscript(id));
      },
    },
    {
      method: 'GET',
      match: p => p === '/api/context',
      handler: (_req, res, url) => {
        const projectId = url.searchParams.get('projectId') ?? '';
        json(res, 200, {
          central: context.getCentralContext(),
          project: context.getProjectContext(projectId),
          assembled: context.assembleContext(projectId),
        });
      },
    },
    {
      method: 'GET',
      match: p => p === API.mcp,
      handler: (_req, res) => json(res, 200, {
        installed: mcp.listInstalled(),
        catalog: mcp.listCatalog(),
      }),
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

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
