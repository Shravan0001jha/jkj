import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Attachment, CreateAgentRequest, Evidence, PermissionMode, PivotRows, ProposalKind, Shippable, WorkKind, WorkState,
} from '@jkj/shared';
import type { Config } from '../config.js';
import type { Workplace } from '../services/workplace.js';
import type { Auth } from './auth.js';
import * as agents from '../services/agents.js';
import * as employees from '../services/employees.js';
import * as work from '../services/work.js';
import * as inbox from '../services/inbox.js';
import * as proposals from '../services/proposals.js';
import * as releases from '../services/releases.js';
import * as spend from '../services/spend.js';
import * as health from '../services/health.js';
import * as views from '../services/views.js';
import * as stall from '../services/stall.js';
import * as room from '../services/room.js';
import * as features from '../services/features.js';
import * as digest from '../services/digest.js';
import type { Telegram } from '../services/telegram.js';
import type { Tunnel } from '../services/tunnel.js';
import type { Push } from '../services/push.js';
import { isLoopback } from './auth.js';
import { route as routeThings } from '../services/ownership.js';
import { coverage } from '../services/requirements.js';
import { commitOrg, parseCharter, renderCharter, writeCharter } from '../services/org.js';
import { readEmployeeContext, saveEmployeeContext } from '../services/context.js';
import { findClaudeHome } from '../runtime/claude-home.js';
import { BadRequest, NotFound, Unauthorized, statusOf } from '../util/errors.js';

/**
 * REST surface (LLD §14). One entry per route so the whole API is readable
 * at a glance. Handlers translate between HTTP and a service call and
 * decide nothing. Off loopback, every route needs the bearer token.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, params: string[]) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export interface RouterDeps {
  config: Config;
  wp: Workplace;
  auth: Auth;
  telegram?: Telegram;
  tunnel?: Tunnel | null;
  push?: Push;
}

export function createRouter({ config, wp, auth, telegram, tunnel, push }: RouterDeps) {
  const startedAt = Date.now();
  const r = (method: string, pattern: string, handler: Handler): Route => ({
    method,
    pattern: new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, '([^/]+)')}$`),
    handler,
  });

  const routes: Route[] = [
    r('GET', '/api/health', (_req, res) => {
      const home = findClaudeHome();
      json(res, 200, {
        ok: true, name: 'jkj', version: config.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        claudeHome: home.present ? home.configDir : null,
        workplace: { dataDir: config.workplaceDir, capInr: spend.capFor(wp), day: spend.dayOf(), telegram: config.telegram, published: tunnel ? tunnel.status : 'not-configured', push: push ? push.status() : { enabled: false, sentToday: 0, suppressedToday: 0 } },
      });
    }),

    /* ---------- pairing (phone) ---------- */
    r('POST', '/api/pair', (req, res) => json(res, 200, auth.pair(req))),
    r('POST', '/api/pair/exchange', async (req, res) => {
      const body = await readJson(req);
      const token = auth.exchange(String(body['code'] ?? ''));
      if (!token) throw new Unauthorized('That pairing code is not valid any more.');
      json(res, 200, { token });
    }),

    /* ---------- screens ---------- */
    r('GET', '/api/office', (_req, res) => json(res, 200, views.office(wp))),
    r('GET', '/api/org', (_req, res) => json(res, 200, views.org(wp))),

    r('GET', '/api/charters/:id', (_req, res, _url, [id]) => {
      const c = wp.org.charters.get(dec(id));
      if (!c) throw new NotFound(`No charter ${dec(id)}`);
      json(res, 200, c);
    }),
    r('PUT', '/api/charters/:id', async (req, res, _url, [id]) => {
      const existing = wp.org.charters.get(dec(id));
      if (!existing) throw new NotFound(`No charter ${dec(id)}`);
      const body = await readJson(req);
      const text = typeof body['body'] === 'string' ? body['body'] : '';
      if (!text.trim()) throw new BadRequest('A charter body cannot be empty.');
      // Validate by parsing the rendered file before writing it.
      const next = { ...existing, body: text, version: existing.version + 1 };
      const parsed = parseCharter(renderCharter(next), existing.path);
      writeCharter(wp.org, { ...parsed, holderIds: existing.holderIds, owns: existing.owns });
      commitOrg(wp.org.dir, `Edit charter ${existing.id} (v${next.version})`);
      wp.reloadOrg();
      json(res, 200, wp.org.charters.get(existing.id));
    }),

    /* ---------- inbox ---------- */
    r('GET', '/api/inbox', (_req, res) => json(res, 200, inbox.list(wp))),
    r('POST', '/api/inbox/:id/answer', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const optionId = typeof body['optionId'] === 'string' ? body['optionId'] : '';
      if (!optionId) throw new BadRequest('Which option?');
      const note = typeof body['note'] === 'string' ? body['note'] : undefined;
      json(res, 200, inbox.answer(wp, dec(id), optionId, note, viaOf(req)));
    }),

    /* ---------- employees ---------- */
    r('GET', '/api/employees', (_req, res) => json(res, 200, wp.org.employees.map(e => ({ ...e, state: employees.stateOf(wp, e.id) })))),
    r('GET', '/api/employees/:id', (_req, res, _url, [id]) => json(res, 200, views.employeeDetail(wp, dec(id)))),
    r('POST', '/api/employees/:id/talk', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const { text, attachments } = validateMessage(body);
      json(res, 201, employees.talk(wp, dec(id), text, attachments, { probe: body['probe'] === true }));
    }),
    r('POST', '/api/employees/:id/end-session', async (_req, res, _url, [id]) => {
      const open = employees.openSession(dec(id));
      if (open) await employees.endSession(wp, open.agentId, 150_000);
      json(res, 200, { ok: true });
    }),
    r('GET', '/api/employees/:id/context', async (_req, res, _url, [id]) => json(res, 200, await readEmployeeContext(wp, dec(id)))),
    r('PUT', '/api/employees/:id/context', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const layerId = typeof body['id'] === 'string' ? body['id'] : '';
      if (!layerId) throw new BadRequest('Which layer?');
      json(res, 200, await saveEmployeeContext(wp, dec(id), layerId, typeof body['body'] === 'string' ? body['body'] : ''));
    }),

    /* ---------- sessions (kept from JKJ) ---------- */
    r('GET', '/api/agents', async (_req, res) => json(res, 200, await agents.listAgents())),
    r('GET', '/api/agents/:id/log', async (_req, res, _url, [id]) => json(res, 200, await agents.getTranscript(dec(id)))),
    r('POST', '/api/agents/:id/message', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const { text, attachments } = validateMessage(body);
      agents.sendMessage(dec(id), text, attachments);
      json(res, 202, { ok: true });
    }),
    r('POST', '/api/agents/:id/interrupt', async (_req, res, _url, [id]) => { await agents.interruptAgent(dec(id)); json(res, 200, { ok: true }); }),
    r('POST', '/api/agents/:id/approve', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const decision = body['decision'];
      if (decision !== 'once' && decision !== 'always' && decision !== 'deny') throw new BadRequest('decision must be once, always or deny');
      agents.resolveApproval(dec(id), decision);
      json(res, 200, { ok: true });
    }),
    r('POST', '/api/agents/:id/mode', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      if (!isMode(body['mode'])) throw new BadRequest('Unknown permission mode');
      await agents.setPermissionMode(dec(id), body['mode']);
      json(res, 200, { ok: true });
    }),
    r('DELETE', '/api/agents/:id', (_req, res, _url, [id]) => { agents.archiveAgent(dec(id)); json(res, 200, { ok: true }); }),
    r('GET', '/api/agents/:id/image', async (_req, res, url, [id]) => {
      const image = await agents.getImage(dec(id), url.searchParams.get('ref') ?? '');
      if (!image) return json(res, 404, { error: 'No such image' });
      res.writeHead(200, { 'content-type': image.mediaType, 'content-length': image.data.byteLength, 'cache-control': 'private, max-age=86400, immutable' });
      res.end(image.data);
    }),
    // Legacy JKJ route, kept so the transcript machinery is reachable from tests and tools.
    r('POST', '/api/agents', async (req, res) => json(res, 201, await agents.createAgent(validateCreate(await readJson(req))))),

    /* ---------- work ---------- */
    r('GET', '/api/work', (_req, res, url) => json(res, 200, stall.annotate(wp, work.list(wp, {
      ...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind') as WorkKind } : {}),
      ...(url.searchParams.get('state') ? { state: url.searchParams.get('state') as WorkState } : {}),
      ...(url.searchParams.get('charterId') ? { charterId: url.searchParams.get('charterId')! } : {}),
      ...(url.searchParams.get('employeeId') ? { employeeId: url.searchParams.get('employeeId')! } : {}),
      ...(url.searchParams.get('featureId') ? { featureId: url.searchParams.get('featureId')! } : {}),
    })))),
    r('POST', '/api/work', async (req, res) => {
      const body = await readJson(req);
      const kind = body['kind'];
      if (kind !== 'assignment' && kind !== 'bug' && kind !== 'question' && kind !== 'feature') throw new BadRequest('kind must be feature, assignment, bug or question');
      const item = work.create(wp, {
        kind, title: str(body['title']), body: str(body['body'], ''),
        ...(typeof body['charterId'] === 'string' ? { charterId: body['charterId'] } : {}),
        ...(typeof body['employeeId'] === 'string' ? { employeeId: body['employeeId'] } : {}),
        requirementIds: strs(body['requirementIds']), platformIds: strs(body['platformIds']),
        by: 'owner',
      });
      // An assignment with an assignee starts its session unless asked not to.
      if (item.kind === 'assignment' && item.employeeId && body['start'] !== false) {
        try { employees.assign(wp, item.id); } catch (err) { work.transition(wp, item.id, { to: 'blocked', by: 'workplace', note: err instanceof Error ? err.message : String(err) }); }
      }
      json(res, 201, work.get(wp, item.id));
    }),
    r('GET', '/api/work/:id', (_req, res, _url, [id]) => json(res, 200, work.require$(wp, dec(id)))),
    r('POST', '/api/work/:id/transition', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const to = str(body['to']) as WorkState;
      const evidence = body['evidence'] && typeof body['evidence'] === 'object' ? body['evidence'] as Evidence : undefined;
      json(res, 200, work.transition(wp, dec(id), {
        to, by: typeof body['by'] === 'string' ? body['by'] : 'owner',
        ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
        ...(evidence ? { evidence } : {}),
        ...(typeof body['plan'] === 'string' ? { plan: body['plan'] } : {}),
        ...(typeof body['spec'] === 'string' ? { spec: body['spec'] } : {}),
      }));
    }),
    r('POST', '/api/work/:id/start', (_req, res, _url, [id]) => json(res, 201, employees.assign(wp, dec(id)))),

    /* ---------- features ---------- */
    r('GET', '/api/features', (_req, res) => json(res, 200, views.featureBoard(wp))),
    r('GET', '/api/features/pivot', (_req, res, url) => {
      const rows = url.searchParams.get('rows');
      if (rows !== 'charter' && rows !== 'platform' && rows !== 'team') throw new BadRequest('rows must be charter, platform or team');
      json(res, 200, views.pivot(wp, rows as PivotRows));
    }),
    r('POST', '/api/features', async (req, res) => {
      const body = await readJson(req);
      const item = work.create(wp, {
        kind: 'feature', title: str(body['title']), body: str(body['body'], ''),
        requirementIds: strs(body['requirementIds']), platformIds: strs(body['platformIds']),
        ...(typeof body['spec'] === 'string' && body['spec'].trim() ? { spec: body['spec'] } : {}),
      });
      if (item.spec) work.transition(wp, item.id, { to: 'specced', by: 'owner', spec: item.spec });
      else if (body['askSpec'] !== false) features.requestSpec(wp, item);
      json(res, 201, work.get(wp, item.id));
    }),
    r('GET', '/api/features/:id', (_req, res, _url, [id]) => json(res, 200, views.featureDetail(wp, dec(id)))),
    r('POST', '/api/features/:id/decompose', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const result = work.decompose(wp, dec(id), { paths: strs(body['paths']), services: strs(body['services']) });
      if (body['start'] !== false) {
        for (const a of result.assignments) {
          if (a.state !== 'proposed' || !a.employeeId || a.sessionId) continue;
          try { employees.assign(wp, a.id); } catch (err) { work.transition(wp, a.id, { to: 'blocked', by: 'workplace', note: err instanceof Error ? err.message : String(err) }); }
        }
      }
      json(res, 200, { ...result, assignments: result.assignments.map(a => work.get(wp, a.id)) });
    }),

    /* ---------- requirements, routing ---------- */
    r('GET', '/api/requirements/coverage', (_req, res) => json(res, 200, coverage(wp.requirements()))),
    r('GET', '/api/requirements', (_req, res, url) => {
      const group = url.searchParams.get('group');
      json(res, 200, wp.requirements().filter(q => !group || q.group === group));
    }),
    r('GET', '/api/route', (_req, res, url) => {
      const list = (k: string) => (url.searchParams.get(k) ?? '').split(',').map(s => s.trim()).filter(Boolean);
      json(res, 200, routeThings(wp.org.map, {
        title: url.searchParams.get('text') ?? '',
        things: [
          ...list('paths').map(key => ({ kind: 'path' as const, key })),
          ...list('platforms').map(key => ({ kind: 'platform' as const, key })),
          ...list('requirementIds').map(key => ({ kind: 'requirement' as const, key })),
        ],
      }, wp.requirements()));
    }),

    /* ---------- proposals ---------- */
    r('GET', '/api/proposals', (_req, res) => json(res, 200, proposals.list(wp))),
    r('POST', '/api/proposals', async (req, res) => {
      const body = await readJson(req);
      const kind = str(body['kind']) as ProposalKind;
      if (!['hire', 'retire', 'split', 'merge', 'reassign', 'restructure'].includes(kind)) throw new BadRequest('Unknown proposal kind');
      json(res, 201, proposals.propose(wp, {
        kind, reason: str(body['reason']),
        params: body['params'] && typeof body['params'] === 'object' ? body['params'] as Record<string, unknown> : {},
        proposedBy: typeof body['proposedBy'] === 'string' ? body['proposedBy'] : 'owner',
      }));
    }),
    r('POST', '/api/proposals/:id/apply', (_req, res, _url, [id]) => json(res, 200, proposals.apply(wp, dec(id)))),

    /* ---------- releases ---------- */
    r('GET', '/api/releases', (_req, res) => json(res, 200, releases.list(wp))),
    r('POST', '/api/releases', async (req, res) => {
      const body = await readJson(req);
      const shippable = str(body['shippable']) as Shippable;
      json(res, 201, releases.propose(wp, shippable, str(body['version']), typeof body['by'] === 'string' ? body['by'] : 'owner'));
    }),
    r('POST', '/api/releases/:id/run', async (_req, res, _url, [id]) => json(res, 200, await releases.run(wp, dec(id)))),

    /* ---------- published access: the emergency off switch ---------- */
    r('POST', '/api/relay/off', (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) throw new BadRequest('The off switch is pressed from this Mac (or Telegram: "off").');
      if (!tunnel) return json(res, 200, { published: 'not-configured' });
      tunnel.off();
      json(res, 200, { published: tunnel.status });
    }),

    /* ---------- the Team Room ---------- */
    r('GET', '/api/room', (_req, res) => json(res, 200, { threads: room.listThreads(wp) })),
    r('POST', '/api/room', async (req, res) => {
      const body = await readJson(req);
      const { thread } = room.createThread(wp, { title: str(body['title']), text: str(body['text']), by: 'owner', charterIds: strs(body['charterIds']), mentions: strs(body['mentions']) });
      json(res, 201, { thread, messages: room.messages(wp, thread.id) });
    }),
    r('GET', '/api/room/:id', (_req, res, _url, [id]) => {
      const thread = room.getThread(wp, dec(id));
      if (!thread) throw new NotFound(`No thread ${dec(id)}`);
      json(res, 200, { thread, messages: room.messages(wp, thread.id) });
    }),
    r('POST', '/api/room/:id/messages', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      json(res, 201, room.post(wp, dec(id), { text: str(body['text']), by: 'owner', mentions: strs(body['mentions']) }));
    }),
    r('POST', '/api/room/:id/resolve', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      json(res, 200, room.resolve(wp, dec(id), { summary: str(body['summary']), by: 'owner' }));
    }),

    /* ---------- digest ---------- */
    r('POST', '/api/digest', async (_req, res) => {
      if (!telegram) throw new BadRequest('No Telegram channel is attached.');
      json(res, 200, await digest.send(wp, telegram));
    }),
    r('GET', '/api/digest', (_req, res) => json(res, 200, { text: digest.build(wp) })),

    /* ---------- spend and health ---------- */
    r('GET', '/api/spend', (_req, res, url) => json(res, 200, spend.summary(wp, url.searchParams.get('day') ?? undefined))),
    r('GET', '/api/health/signals', (_req, res) => json(res, 200, health.signals(wp))),
  ];

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) return false;

    // The exchange is how a phone GETS the token; it carries a one-time code instead.
    const exchanging = req.method === 'POST' && url.pathname === '/api/pair/exchange';
    if (!exchanging && !auth.allows(req)) {
      json(res, 401, { error: 'A bearer token is required off loopback.' });
      return true;
    }

    const found = routes.map(route => ({ route, m: route.pattern.exec(url.pathname) })).find(x => x.m && x.route.method === req.method);
    if (!found?.m) {
      json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return true;
    }

    try {
      await found.route.handler(req, res, url, found.m.slice(1));
    } catch (err) {
      json(res, statusOf(err), { error: err instanceof Error ? err.message : 'Unknown error' });
    }
    return true;
  };
}

/* ---------- helpers ---------- */

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const dec = (s: string | undefined): string => decodeURIComponent(s ?? '');

const viaOf = (req: IncomingMessage): 'web' | 'phone' => {
  const ua = String(req.headers['user-agent'] ?? '');
  return /IrisWorkplace|CFNetwork|Darwin\/\d/.test(ua) && !/Mozilla/.test(ua) ? 'phone' : 'web';
};

const MODES: PermissionMode[] = ['ask', 'auto', 'acceptEdits', 'plan', 'dontAsk'];
const isMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (MODES as string[]).includes(value);

function str(v: unknown, fallback?: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (fallback !== undefined) return fallback;
  throw new BadRequest('A required field is missing.');
}

const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [];

/** Attachments are decoded on the server, so the wire is checked first. */
export function validateMessage(body: Record<string, unknown>): { text: string; attachments: Attachment[] } {
  const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
  const raw = Array.isArray(body['attachments']) ? body['attachments'] : [];

  const attachments: Attachment[] = raw.map(item => {
    const file = item as Record<string, unknown>;
    const data = typeof file['data'] === 'string' ? file['data'] : '';
    const mediaType = typeof file['mediaType'] === 'string' ? file['mediaType'] : '';
    const name = typeof file['name'] === 'string' ? file['name'] : 'attachment';
    if (!data || !mediaType) throw new BadRequest(`${name} arrived without any content.`);
    return { name, mediaType, data };
  });

  if (!text && attachments.length === 0) throw new BadRequest('Nothing to send.');
  return { text: text || 'See the attached file.', attachments };
}

/** A request body is untrusted until every field has been checked. */
export function validateCreate(body: Record<string, unknown>): CreateAgentRequest {
  const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
  const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : '';
  if (!task) throw new BadRequest('A session needs something to do.');
  if (!projectId) throw new BadRequest('A session needs a project to run in.');

  const mode = body['permissionMode'];
  return {
    projectId,
    task,
    model: typeof body['model'] === 'string' && body['model'] ? body['model'] : 'sonnet',
    workspace: 'branch',
    permissionMode: isMode(mode) ? mode : 'ask',
    attachments: validateMessage({ text: task, attachments: body['attachments'] }).attachments,
  };
}

/** Attachments arrive base64-encoded, so bodies are large but not unbounded. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) throw new BadRequest('That is too large to send. Keep attachments under about 24 MB.');
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new BadRequest('Request body was not valid JSON');
  }
}
