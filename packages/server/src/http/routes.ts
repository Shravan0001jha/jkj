import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import type {
  Attachment, CreateAgentRequest, Evidence, PermissionMode, PivotRows, ProposalKind, Shippable, WorkKind, WorkState,
} from '@jkj/shared';
import { toChatView } from '@jkj/shared';
import type { Config } from '../config.js';
import type { Workplace } from '../services/workplace.js';
import type { Auth } from './auth.js';
import * as agents from '../services/agents.js';
import * as employees from '../services/employees.js';
import * as work from '../services/work.js';
import * as inbox from '../services/inbox.js';
import * as proposals from '../services/proposals.js';
import * as releases from '../services/releases.js';
import * as requests from '../services/requests.js';
import * as spend from '../services/spend.js';
import * as health from '../services/health.js';
import * as views from '../services/views.js';
import * as stall from '../services/stall.js';
import * as room from '../services/room.js';
import * as coo from '../services/coo.js';
import * as ownerInbox from '../services/owner-inbox.js';
import * as superFocus from '../services/focus.js';
import * as features from '../services/features.js';
import * as digest from '../services/digest.js';
import * as items from '../services/items.js';
import * as trail from '../services/trail.js';
import * as areas from '../services/areas.js';
import * as releasePosts from '../services/release-posts.js';
import * as statusAnswers from '../services/status.js';
import * as pace from '../services/pace.js';
import * as spendCaps from '../services/spend-caps.js';
import * as floor from '../services/floor.js';
import * as awaitingMac from '../services/awaiting-mac.js';
import * as dispatch from '../services/dispatch.js';
import * as githubFlow from '../services/github-flow.js';
import * as board from '../services/board.js';
import * as talk from '../services/talk.js';
import * as talkStore from '../services/talk-store.js';
import * as evidence from '../services/evidence.js';
import * as deferred from '../services/deferred.js';
import * as stagingDiag from '../services/staging-diag.js';
import * as hygiene from '../services/hygiene.js';
import * as macQueue from '../services/mac-queue.js';
import type { Telegram } from '../services/telegram.js';
import type { Tunnel } from '../services/tunnel.js';
import type { Push } from '../services/push.js';
import { isLoopback } from './auth.js';
import { log } from '../util/logger.js';
import { route as routeThings } from '../services/ownership.js';
import { coverage } from '../services/requirements.js';
import { commitOrg, parseCharter, renderCharter, writeCharter } from '../services/org.js';
import { readEmployeeContext, saveEmployeeContext } from '../services/context.js';
import { findClaudeHome } from '../runtime/claude-home.js';
import { BadRequest, NotFound, TooLarge, Unauthorized, statusOf } from '../util/errors.js';

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
  /** Boots, uptime, the tunnel's stats and the watchdog's state for /api/health (docs/RESILIENCE-workplace.md §5). */
  resilience?: () => unknown;
}

export function createRouter({ config, wp, auth, telegram, tunnel, push, resilience }: RouterDeps) {
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
        ...(resilience ? { resilience: resilience() } : {}),
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
    r('GET', '/api/inbox', (_req, res, url) => json(res, 200, inbox.ownerPage(wp, { state: url.searchParams.get('state'), limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }))),
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
    // The default Talk: the Chief of Staff (29 Sep, phone).
    // The sender is the actor (owner, or the COO from this Mac), never assumed (docs/LLD-app-fixes.md §1).
    r('POST', '/api/talk', async (req, res) => {
      const body = await readJson(req);
      const cos = features.chiefOfStaff(wp);
      if (!cos) throw new BadRequest('No Chief of Staff in the organisation.');
      const { message, agent } = talk.send(wp, cos, talkSpec(req, body));
      json(res, 201, { ...agent!, message });
    }),
    r('POST', '/api/employees/:id/talk', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const emp = wp.org.employees.find(e => e.id === dec(id));
      if (!emp) throw new NotFound(`No employee ${dec(id)}`);
      if (emp.virtual) throw new BadRequest(`${emp.name} is reached through POST /api/coo/message, not Talk.`);
      const { message, agent } = talk.send(wp, dec(id), talkSpec(req, body));
      json(res, 201, { ...agent!, message });
    }),

    /* ---------- Talk threads (docs/LLD-app-fixes.md §2) ---------- */
    r('GET', '/api/talk/threads', (_req, res) => json(res, 200, talkStore.threads(wp))),
    r('GET', '/api/talk/threads/:id', (_req, res, _url, [id]) => json(res, 200, talkStore.thread(wp, dec(id)))),
    r('GET', '/api/talk/threads/:id/messages', (_req, res, url, [id]) => {
      const limit = url.searchParams.get('limit');
      if (limit !== null && !/^[1-9]\d*$/.test(limit)) throw new BadRequest('limit must be a positive whole number');
      json(res, 200, talkStore.messages(wp, dec(id), { ...(limit ? { limit: Number(limit) } : {}), ...(url.searchParams.get('before') ? { before: url.searchParams.get('before')! } : {}) }));
    }),
    r('POST', '/api/talk/threads/:id/messages', async (req, res, _url, [id]) => {
      json(res, 201, talk.send(wp, dec(id), talkSpec(req, await readJson(req))));
    }),
    r('POST', '/api/talk/threads/:id/read', async (req, res, _url, [id]) => {
      const upTo = (await readJson(req))['upTo'];
      json(res, 200, talkStore.markThreadRead(wp, dec(id), typeof upTo === 'string' && upTo ? upTo : undefined));
    }),
    r('POST', '/api/talk/threads/:id/pin', async (req, res, _url, [id]) => {
      const pinned = (await readJson(req))['pinned'];
      if (typeof pinned !== 'boolean') throw new BadRequest('pinned must be true or false');
      json(res, 200, talkStore.setPinned(wp, dec(id), pinned));
    }),
    r('POST', '/api/talk/threads/:id/attachments', async (req, res, url, [id]) => {
      talkStore.requireThread(wp, dec(id));
      const data = await readRaw(req, talkStore.MAX_FILE_BYTES);
      const mediaType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
      json(res, 201, talkStore.saveAttachment(wp, dec(id), { name: url.searchParams.get('name') ?? 'file', mediaType, data }));
    }),
    r('POST', '/api/talk/threads/:id/voice', async (req, res, url, [id]) => {
      talkStore.requireThread(wp, dec(id));
      const data = await readRaw(req, talkStore.MAX_FILE_BYTES);
      const ms = Number(url.searchParams.get('durationMs') ?? '');
      json(res, 201, await talk.sendVoice(wp, dec(id), {
        from: actorOf(req), name: url.searchParams.get('name') ?? 'voice-note.m4a', mediaType: String(req.headers['content-type'] ?? ''), data,
        ...(Number.isFinite(ms) && ms > 0 ? { durationMs: Math.round(ms) } : {}),
        ...(url.searchParams.get('replyTo') ? { replyTo: url.searchParams.get('replyTo')! } : {}),
      }));
    }),
    r('GET', '/api/talk/attachments/:id', (_req, res, url, [id]) => {
      const { meta, data } = talkStore.attachmentBytes(wp, dec(id));
      const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      res.writeHead(200, {
        'content-type': meta.mediaType, 'content-length': data.byteLength, 'cache-control': 'private, max-age=86400, immutable',
        'content-disposition': `${disposition}; filename="${meta.name.replace(/[^\x20-\x7e]|"/g, '_')}"`, 'x-content-type-options': 'nosniff',
      });
      res.end(data);
    }),
    r('GET', '/api/mentionable', (_req, res) => json(res, 200, talk.mentionable(wp))),
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
    // Talk must read like a chat (owner, 29 Sep): ?view=chat collapses consecutive tool activity and
    // keeps only the owner's/employee's messages; approvals stay inline (Agent.approval, not a log
    // entry). The full log is still the default and always reachable with no query or ?view=full.
    r('GET', '/api/agents/:id/log', async (_req, res, url, [id]) => {
      // A transcript read back from disk has lost each line's sender; the Talk store gives it back.
      const entries = talkStore.overlaySenders(wp, await agents.getTranscript(dec(id)));
      json(res, 200, url.searchParams.get('view') === 'chat' ? toChatView(entries) : entries);
    }),
    r('POST', '/api/agents/:id/message', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const { text, attachments } = validateMessage(body);
      agents.sendMessage(dec(id), text, attachments, actorOf(req));
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
      const featureId = typeof body['featureId'] === 'string' && body['featureId'] ? body['featureId'] : undefined;
      if (featureId) {
        const feature = work.get(wp, featureId);
        if (!feature || feature.kind !== 'feature') throw new BadRequest(`No feature ${featureId}`);
        if (kind === 'feature') throw new BadRequest('A feature cannot be under a feature');
      }
      const item = work.create(wp, {
        kind, title: str(body['title']), body: str(body['body'], ''),
        ...(typeof body['charterId'] === 'string' ? { charterId: body['charterId'] } : {}),
        ...(typeof body['employeeId'] === 'string' ? { employeeId: body['employeeId'] } : {}),
        ...(featureId ? { featureId } : {}),
        requirementIds: strs(body['requirementIds']), platformIds: strs(body['platformIds']),
        by: actorOf(req),
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
        to, by: byOf(req, body['by']),
        ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
        ...(evidence ? { evidence } : {}),
        ...(typeof body['plan'] === 'string' ? { plan: body['plan'] } : {}),
        ...(typeof body['spec'] === 'string' ? { spec: body['spec'] } : {}),
      }));
    }),
    r('POST', '/api/work/:id/start', (_req, res, _url, [id]) => json(res, 201, employees.assign(wp, dec(id)))),

    /* ---------- the owner's requests ---------- */
    r('GET', '/api/requests', (_req, res) => json(res, 200, requests.list(wp))),
    r('POST', '/api/requests', async (req, res) => {
      const body = await readJson(req);
      json(res, 201, requests.create(wp, { text: str(body['text'], ''), platformIds: strs(body['platformIds']) }));
    }),

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
      if (item.spec) work.transition(wp, item.id, { to: 'specced', by: actorOf(req), spec: item.spec });
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
        proposedBy: byOf(req, body['proposedBy']),
      }));
    }),
    r('GET', '/api/proposals/:id', (_req, res, _url, [id]) => {
      const proposal = proposals.get(wp, dec(id));
      if (!proposal) throw new NotFound(`No proposal ${dec(id)}`);
      const item = inbox.get(wp, proposal.inboxId);
      if (!item) throw new NotFound(`No Inbox item for ${proposal.id}`);
      json(res, 200, { proposal, item });
    }),
    r('POST', '/api/proposals/:id/apply', (_req, res, _url, [id]) => json(res, 200, proposals.apply(wp, dec(id)))),

    /* ---------- releases ---------- */
    r('GET', '/api/releases/ready', (_req, res) => json(res, 200, releases.readiness(wp))),
    r('GET', '/api/releases', (_req, res) => json(res, 200, releases.list(wp))),
    r('POST', '/api/releases', async (req, res) => {
      const body = await readJson(req);
      const shippable = str(body['shippable']) as Shippable;
      json(res, 201, releases.propose(wp, shippable, str(body['version']), byOf(req, body['by'])));
    }),
    // 202: the script runs on; a release takes minutes and the relay's request timeout would drop a 200.
    r('POST', '/api/releases/:id/run', async (_req, res, _url, [id]) => { const { release, done } = releases.start(wp, dec(id)); done.catch(err => log.warn('releases', String(err))); json(res, 202, release); }),

    /* ---------- the COO bridge ---------- */
    // "Claude — COO" is the lead's own terminal session, not an Agent SDK employee (no mirroring:
    // only what the owner sent and what the lead replied ever appears here).
    //
    // Owner-facing (log, message, presence): the owner reaches the Workplace only through the
    // tunnel from his phone, so these need the ordinary bearer/cookie session the router already
    // requires off loopback — no extra guard, same as any other /api/* route.
    r('GET', '/api/coo/log', (_req, res) => json(res, 200, coo.transcript(wp))),
    r('POST', '/api/coo/message', async (req, res) => json(res, 201, coo.sendOwnerMessage(wp, str((await readJson(req))['text'])))),
    r('GET', '/api/coo/presence', (_req, res) => json(res, 200, coo.presence(wp))),
    // Lead-only (reply, items, answer, forward): only the lead's own process ever writes as the
    // COO, so these stay loopback and refuse a request that arrived through the tunnel, exactly as
    // /api/pair and /api/relay/off already do — a valid owner bearer token is not enough here.
    r('POST', '/api/coo/reply', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      const attachments = talkStore.cooFiles(wp, { attachmentIds: strs(body['attachmentIds']), files: strs(body['files']) });
      json(res, 201, coo.replyFromCoo(wp, {
        inReplyTo: str(body['inReplyTo']), text: typeof body['text'] === 'string' ? body['text'] : '', ...(attachments.length ? { attachments } : {}),
        ...(typeof body['details'] === 'string' && body['details'].trim() ? { details: body['details'] } : {}),
      }));
    }),
    r('GET', '/api/coo/items', (req, res, url) => { requireLocal(req); const state = url.searchParams.get('state'); json(res, 200, coo.listItems(wp, state === 'open' || state === 'answered' || state === 'forwarded' ? state : undefined)); }),
    r('POST', '/api/coo/answer', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, coo.answerItem(wp, { itemId: str(body['itemId']), optionId: str(body['optionId']), ...(typeof body['note'] === 'string' && body['note'].trim() ? { note: body['note'] } : {}) }));
    }),
    // The COO answering in an epic thread or on an item, as itself (owner, 2 Oct): the owner's
    // routes always write as 'owner', so the lead has its own, loopback only like the rest.
    // The COO raising a real decision to the owner's Inbox (owner, 2 Oct: "you and Asha both
    // should have a way"); loopback only like every other /api/coo/* route.
    r('POST', '/api/coo/decision', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      const options = strs(body['options']).map(o => ({ id: o.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: o }));
      json(res, 201, inbox.raise(wp, {
        kind: 'decision', title: str(body['title']), body: str(body['body']), raisedBy: 'coo',
        ...(options.length ? { options } : {}),
        ...(typeof body['recommendation'] === 'string' && body['recommendation'].trim() ? { recommendation: body['recommendation'] } : {}),
      } as never));
    }),
    // The COO works the owner's Inbox down (rework W4): every agent-raised owner item is copied to
    // him and its push held 15 min. He resolves it for the owner (never pushed; the raiser is told)
    // or says why it needs the owner (pushed now, his note on top). Loopback only like the rest.
    r('GET', '/api/coo/owner-inbox', (req, res) => { requireLocal(req); json(res, 200, ownerInbox.list(wp)); }),
    r('POST', '/api/coo/owner-inbox/:id/resolve', async (req, res, _url, [id]) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, ownerInbox.resolve(wp, dec(id), {
        text: typeof body['text'] === 'string' ? body['text'] : '',
        ...(typeof body['optionId'] === 'string' && body['optionId'].trim() ? { optionId: body['optionId'] } : {}),
      }));
    }),
    r('POST', '/api/coo/owner-inbox/:id/needs-you', async (req, res, _url, [id]) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, ownerInbox.needsYou(wp, dec(id), { text: typeof body['text'] === 'string' ? body['text'] : '' }));
    }),
    r('POST', '/api/coo/thread-reply', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      const threadId = typeof body['threadId'] === 'string' && body['threadId'].trim() ? body['threadId'].trim() : undefined;
      const itemId = typeof body['itemId'] === 'string' && body['itemId'].trim() ? body['itemId'].trim() : undefined;
      json(res, 201, coo.threadReply(wp, { ...(threadId ? { threadId } : {}), ...(itemId ? { itemId } : {}), text: str(body['text']) }));
    }),
    r('POST', '/api/coo/forward', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, coo.forwardItem(wp, { itemId: str(body['itemId']), recommendation: str(body['recommendation']) }));
    }),
    // A live check on the real Mac is the COO's call, never a session's own: loopback only, like
    // the rest of the lead-only routes, and refused over the tunnel for the same reason.
    r('POST', '/api/coo/live-window', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      const employeeId = str(body['employeeId']);
      employees.employee(wp, employeeId); // throws if unknown
      const window = coo.openLiveWindow(wp, employeeId, Number(body['minutes']));
      employees.refreshLiveWindow(wp, employeeId, Date.parse(window.until));
      json(res, 200, window);
    }),

    // The Mac queue (LLD-rework §W6.1): who holds the owner's Mac and who waits. The owner (phone or
    // web) or the COO hands it over now, session or not.
    r('GET', '/api/mac-queue', (_req, res) => json(res, 200, macQueue.list(wp))),
    r('POST', '/api/mac-queue/:id/grant', (req, res, _url, [id]) => json(res, 200, macQueue.grantNow(wp, dec(id), actorOf(req)))),

    // "Pause all" (owner, 4 Oct): nothing unattended starts while it is on; talk still works.
    // Reload the org (map.yaml, charters, roles) without a restart (5 Oct: map fixes waited on live windows).
    // New sessions and guard checks read wp.org, so a fixed map applies at once.
    r('POST', '/api/coo/reload-org', (req, res) => {
      requireLocal(req);
      const org = wp.reloadOrg();
      json(res, 200, { employees: org.employees.length, charters: org.charters.size, mapEntries: org.map.length });
    }),
    // The Mac verification queue (owner rule, 23 Oct): stories done on staging that only wait for a Mac check.
    // The COO closes them here when a Mac session is open: result pass (with evidence) or fail (back to In progress + a bug).
    r('GET', '/api/coo/awaiting-mac', (req, res) => { requireLocal(req); json(res, 200, { items: awaitingMac.list(wp) }); }),
    r('POST', '/api/coo/awaiting-mac/close', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      if (typeof body['itemId'] !== 'string') throw new BadRequest('itemId must be a string.');
      const result = body['result'];
      if (result !== 'pass' && result !== 'fail') throw new BadRequest('result must be pass or fail.');
      json(res, 200, awaitingMac.close(wp, body['itemId'], { result, note: typeof body['note'] === 'string' ? body['note'] : '' }, 'coo'));
    }),
    // One-shot adopt of existing parked/merged Mac-check stories (the COO runs it): { itemIds: [...], note: "what the Mac must confirm" }.
    r('POST', '/api/coo/awaiting-mac/adopt', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      const ids = body['itemIds'];
      if (!Array.isArray(ids) || !ids.length || ids.some(i => typeof i !== 'string')) throw new BadRequest('itemIds must be a non-empty list of item ids.');
      if (typeof body['note'] !== 'string') throw new BadRequest('note must be a string naming what the Mac check must confirm.');
      json(res, 200, awaitingMac.adopt(wp, ids as string[], body['note']));
    }),
    r('GET', '/api/coo/floor', (req, res) => { requireLocal(req); json(res, 200, floor.state(wp)); }),
    r('POST', '/api/coo/floor', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      if (typeof body['paused'] !== 'boolean') throw new BadRequest('paused must be true or false.');
      const reason = typeof body['reason'] === 'string' ? body['reason'].trim().slice(0, 300) : '';
      const st = floor.setPaused(wp, body['paused'], reason, 'coo');
      // Resumed: the queued work starts now, not at the next sweep.
      if (!st.paused) { try { dispatch.sweep(wp); } catch (err) { log.warn('floor', `sweep after resume: ${err instanceof Error ? err.message : err}`); } }
      json(res, 200, st);
    }),

    // Weekly pacing on/off (owner's call, relayed by the COO): off lifts any hold at once. This is the
    // permanent switch; the owner's one-day bypass is his answer to the pace-cap decision in the Inbox.
    r('GET', '/api/coo/pace', (req, res) => { requireLocal(req); json(res, 200, pace.status(wp)); }),
    r('POST', '/api/coo/pace', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      if (body['capToday'] !== undefined) {
        // Raise today's cap only (never lowers; gone at the next pace day).
        const cap = Number(body['capToday']);
        try { pace.setCapOverride(wp, cap, 'coo (for the owner)'); } catch (err) { throw new BadRequest(err instanceof Error ? err.message : String(err)); }
      }
      if (body['disabled'] !== undefined || body['capToday'] === undefined) pace.setDisabled(wp, body['disabled'] === true);
      json(res, 200, pace.status(wp));
    }),

    // The daily spend caps (owner, 18 Oct): GitHub Actions $5, agents' work $10 (AWS excluded), per IST day.
    // POST {"liftGithubCap":true} is the owner's lift of the GitHub cap for the rest of today.
    r('GET', '/api/coo/spend-today', (req, res) => { requireLocal(req); json(res, 200, spendCaps.today(wp)); }),
    r('POST', '/api/coo/spend-today', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      if (body['liftGithubCap'] === true) spendCaps.liftGithub(wp, 'owner (via the COO)');
      json(res, 200, spendCaps.today(wp));
    }),

    // The GitHub flow (docs/LLD-github-flow.md §6): the mode, and the COO's merge. Loopback only, like the rest.
    r('GET', '/api/coo/github', (req, res) => { requireLocal(req); json(res, 200, githubFlow.state(wp)); }),
    r('POST', '/api/coo/github', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      githubFlow.setMode(wp, str(body['mode']), 'coo');
      json(res, 200, githubFlow.state(wp));
    }),
    // Board maintenance (owner, 18 Oct): the COO's loopback door to the same functions as Asha's tools.
    r('POST', '/api/coo/board/:action', async (req, res, _url, [action]) => {
      requireLocal(req);
      const b = await readJson(req);
      const by = 'coo';
      const reason = str(b['reason'], '');
      const id = str(b['itemId'], '');
      switch (action) {
        case 'pr-close': return json(res, 200, await board.closePr(wp, id, by, reason));
        case 'approval-revoke': return json(res, 200, await board.revokeApproval(wp, id, str(b['approver'], ''), by, reason));
        case 'close-no-code': return json(res, 200, board.closeNoCode(wp, id, by, reason));
        case 'signoff-recut': return json(res, 200, board.recutSignoff(wp, str(b['sha'], ''), by, reason));
        case 'github-resume': return json(res, 200, board.resumeGithub(wp, by, reason));
        case 'status-repost': return json(res, 200, { posted: await board.repostStatus(wp, id, by, reason) });
        case 'branch-reset': return json(res, 200, await board.resetBranch(wp, id, by, reason));
        case 'map-assign': return json(res, 200, board.assignMap(wp, Array.isArray(b['paths']) ? (b['paths'] as unknown[]).map(String) : [], str(b['charterId'], ''), by, reason));
        default: throw new NotFound(`No board action ${action}`);
      }
    }),
    r('POST', '/api/coo/merge', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, await githubFlow.merge(wp, str(body['itemId']), 'coo'));
    }),
    // Merges without the COO (rework W3): only a PR touching CI workflows or infrastructure waits for his
    // spend approval, which this records; the automatic merge then goes on. Loopback only, like the rest.
    r('POST', '/api/coo/approve-spend', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, await githubFlow.approveSpend(wp, str(body['itemId']), 'coo'));
    }),

    // The COO's developer approval of a CTO-authored PR (dry run #12, 10 Oct): the CTO has no team and the
    // author never approves their own, so the COO gives approval 1 of 2 on the CTO's stories, and only
    // those (any other author is refused). QA's approval 2 of 2 is still needed, unless the PR changes only
    // docs (*.md, docs/**): then the COO's approval alone is enough and the Workplace merges it. Body
    // {itemId, note}; the note (what was checked) is required. Loopback only, like the rest.
    r('POST', '/api/coo/review-approve', async (req, res) => {
      requireLocal(req);
      const body = await readJson(req);
      json(res, 200, await githubFlow.cooReviewApprove(wp, str(body['itemId']), str(body['note'])));
    }),

    // run_evidence (docs/LLD-evidence.md §5): the queue for the COO (loopback only), and the reports
    // for the owner and reviewers (same auth as every /api route, so the tunnel and the token work).
    // staging_diag for the COO: the same whitelisted read-only queries the agents' tool runs (loopback only).
    r('GET', '/api/staging/diag', async (req, res, url) => {
      requireLocal(req);
      const g = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;
      const kind = g('kind');
      if (kind !== 'logs' && kind !== 'chat' && kind !== 'version') throw new BadRequest('kind is logs, chat or version.');
      const result = await stagingDiag.stagingDiag({
        kind, by: actorOf(req), start: g('start') === 'true',
        ...(g('since') ? { since: g('since')! } : {}), ...(g('until') ? { until: g('until')! } : {}),
        ...(g('filter') ? { filter: g('filter')! } : {}), ...(g('account') ? { account: g('account')! } : {}),
      }, stagingDiag.realRunner(wp.config.evidence.stagingScript));
      json(res, 200, result);
    }),
    r('GET', '/api/coo/evidence', (req, res) => { requireLocal(req); json(res, 200, evidence.state(wp)); }),
    r('GET', '/api/coo/evidence/staging', (req, res) => { requireLocal(req); json(res, 200, evidence.stagingServer(wp)); }),
    r('GET', '/api/coo/evidence/deferred', (req, res) => { requireLocal(req); json(res, 200, deferred.allowlist(wp)); }),
    r('POST', '/api/coo/evidence/deferred', async (req, res) => { requireLocal(req); const body = await readJson(req); json(res, 200, deferred.allow(wp, { case: str(body['case']), storyId: str(body['storyId']), reason: str(body['reason']) }, str(body['by']) || 'coo')); }),
    r('POST', '/api/coo/evidence/rescore', async (req, res) => { requireLocal(req); const body = await readJson(req); json(res, 200, await evidence.rescore(wp, str(body['itemId']), str(body['by']) || 'coo', str(body['run']) || undefined)); }),
    r('POST', '/api/coo/evidence/staging', async (req, res) => { requireLocal(req); const body = await readJson(req); json(res, 200, evidence.recordStagingDeploy(wp, str(body['sha']), str(body['by']) || 'coo')); }),
    r('GET', '/api/evidence/:item/:run(?:/(.*))?', (_req, res, _url, [item, run, rest]) => {
      const file = evidence.reportFile(wp, item ?? '', run ?? '', rest);
      if (!file) return json(res, 404, { error: 'No such report file.' });
      const size = statSync(file).size;
      res.writeHead(200, {
        'content-type': REPORT_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': size,
        // The report is the runner's HTML: it never runs as the Workplace's origin.
        'content-security-policy': "sandbox allow-scripts allow-popups; default-src 'self' 'unsafe-inline' data: blob:",
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=300',
      });
      createReadStream(file).pipe(res);
    }),

    /* ---------- published access: the emergency off switch ---------- */
    r('POST', '/api/relay/off', (req, res) => {
      // A relay request arrives on loopback too (the tunnel forwards it); the header the tunnel sets keeps the phone out (as for pairing).
      if (!isLocal(req)) throw new BadRequest('The off switch is pressed from this Mac (or Telegram: "off").');
      if (!tunnel) return json(res, 200, { published: 'not-configured' });
      tunnel.off();
      json(res, 200, { published: tunnel.status });
    }),

    /* ---------- the Team Room ---------- */
    r('GET', '/api/room', (_req, res) => json(res, 200, { threads: room.listThreads(wp) })),
    r('POST', '/api/room', async (req, res) => {
      const body = await readJson(req);
      const { thread } = room.createThread(wp, { title: str(body['title']), text: str(body['text']), by: actorOf(req), charterIds: strs(body['charterIds']), mentions: strs(body['mentions']) });
      json(res, 201, { thread, messages: room.messages(wp, thread.id) });
    }),
    r('GET', '/api/room/:id', (_req, res, _url, [id]) => {
      const thread = room.getThread(wp, dec(id));
      if (!thread) throw new NotFound(`No thread ${dec(id)}`);
      json(res, 200, { thread: room.ownerThread(wp, thread), messages: room.messages(wp, thread.id) });
    }),
    r('POST', '/api/room/:id/messages', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      json(res, 201, room.post(wp, dec(id), { text: str(body['text']), by: actorOf(req), mentions: talk.validMentions(wp, strs(body['mentions'])) }));
    }),
    r('POST', '/api/room/:id/resolve', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      json(res, 200, room.resolve(wp, dec(id), { summary: str(body['summary']), by: actorOf(req) }));
    }),

    /* ---------- digest ---------- */
    r('POST', '/api/digest', async (_req, res) => {
      if (!telegram) throw new BadRequest('No Telegram channel is attached.');
      json(res, 200, await digest.send(wp, telegram));
    }),
    r('GET', '/api/digest', (_req, res) => json(res, 200, { text: digest.build(wp) })),

    /* ---------- v2: the plan (LLD §19.8) — owner-facing, ordinary auth, relay allowed ---------- */
    r('GET', '/api/plan', (_req, res, url) => json(res, 200, items.plan(wp, url.searchParams.get('view') === 'board' ? 'board' : undefined))),
    r('GET', '/api/focus', (_req, res) => json(res, 200, items.getFocus(wp))),
    // Is the board true (docs/HLD-jira-lifecycle.md §5): the current violations and the clean percentage.
    r('GET', '/api/hygiene', (_req, res) => json(res, 200, hygiene.report(wp))),
    // Super focus (rework W4): quiet hours off and night rings allowed until `until`. The owner (his
    // phone) or the COO (this Mac, x-workplace-actor: coo) sets it; `hours: 0` clears it.
    r('GET', '/api/settings/super-focus', (_req, res) => json(res, 200, superFocus.getSuperFocus(wp))),
    r('POST', '/api/settings/super-focus', async (req, res) => {
      const body = await readJson(req);
      json(res, 200, superFocus.setSuperFocus(wp, { hours: body['hours'] as number, by: actorOf(req) }));
    }),
    r('POST', '/api/focus', async (req, res) => json(res, 200, items.setFocus(wp, strs((await readJson(req))['epicIds']), actorOf(req)))),
    r('GET', '/api/items', (_req, res, url) => {
      const q = (k: string) => url.searchParams.get(k) ?? undefined;
      const sort = q('sort');
      if (sort && !(items.ITEM_SORTS as readonly string[]).includes(sort)) throw new BadRequest(`sort must be one of ${items.ITEM_SORTS.join(', ')}`);
      const order = q('order');
      if (order && order !== 'asc' && order !== 'desc') throw new BadRequest('order must be asc or desc');
      json(res, 200, items.list(wp, {
        level: q('level'), status: q('status'), assigneeId: q('assigneeId'), ownerId: q('ownerId'), areaId: q('areaId'), parentId: q('parentId'), q: q('q'),
        ...(sort ? { sort: sort as items.ItemQuery['sort'] } : {}), ...(order ? { order: order as 'asc' | 'desc' } : {}),
        finishedLast: q('finishedLast') === '1' || q('finishedLast') === 'true',
      }));
    }),
    r('POST', '/api/items', async (req, res) => {
      const body = await readJson(req);
      const item = items.create(wp, body as never, actorOf(req));
      json(res, 201, items.detail(wp, item.id));
    }),
    r('GET', '/api/items/:id', (_req, res, _url, [id]) => json(res, 200, items.detail(wp, dec(id)))),
    r('POST', '/api/items/:id', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      const item = items.update(wp, dec(id), body as never, actorOf(req));
      // start: true on a move to in-progress hands the item to its assignee's session.
      if (body['start'] === true && item.status === 'in-progress' && item.assigneeId && item.assigneeId !== 'owner') employees.assign(wp, item.id);
      json(res, 200, items.detail(wp, dec(id)));
    }),
    r('POST', '/api/items/:id/comments', async (req, res, _url, [id]) => {
      items.require$(wp, dec(id));
      const body = await readJson(req);
      json(res, 201, trail.comment(wp, dec(id), { by: actorOf(req), text: str(body['text']), mentions: talk.validMentions(wp, strs(body['mentions'])) }));
    }),
    r('POST', '/api/items/:id/handback', async (req, res, _url, [id]) => {
      const note = (await readJson(req))['note'];
      items.handback(wp, dec(id), typeof note === 'string' ? note : '', actorOf(req));
      json(res, 200, items.detail(wp, dec(id)));
    }),
    r('POST', '/api/items/:id/merge', async (req, res, _url, [id]) => {
      const survivor = items.merge(wp, dec(id), str((await readJson(req))['intoId']), actorOf(req));
      json(res, 200, items.detail(wp, survivor.id));
    }),
    r('GET', '/api/updates', (_req, res, url) => {
      const limit = Number(url.searchParams.get('limit') ?? '');
      json(res, 200, trail.updates(wp, { ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), ...(url.searchParams.get('before') ? { before: url.searchParams.get('before')! } : {}) }));
    }),
    r('GET', '/api/status', (_req, res, url) => json(res, 200, statusAnswers.answer(wp, url.searchParams.get('q') ?? ''))),
    r('GET', '/api/areas', (_req, res) => json(res, 200, areas.list(wp))),
    r('POST', '/api/areas', async (req, res) => {
      const body = await readJson(req);
      json(res, 201, areas.create(wp, { title: str(body['title'], ''), ...(typeof body['description'] === 'string' ? { description: body['description'] } : {}), ...(typeof body['ownerId'] === 'string' ? { ownerId: body['ownerId'] } : {}) }, actorOf(req)));
    }),
    r('POST', '/api/areas/:id', async (req, res, _url, [id]) => json(res, 200, areas.update(wp, dec(id), await readJson(req) as never, actorOf(req)))),
    r('GET', '/api/rooms', (_req, res) => json(res, 200, room.listRooms(wp))),
    r('GET', '/api/rooms/:id', (_req, res, _url, [id]) => json(res, 200, room.roomDetail(wp, dec(id)))),
    r('GET', '/api/releases/posts', (_req, res) => json(res, 200, releasePosts.list(wp))),
    r('POST', '/api/releases/posts', async (req, res) => {
      const body = await readJson(req);
      json(res, 201, releasePosts.create(wp, {
        version: str(body['version'], ''), ...(typeof body['shippable'] === 'string' ? { shippable: body['shippable'] } : {}),
        ...(Array.isArray(body['itemIds']) ? { itemIds: strs(body['itemIds']) } : {}), ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      }, actorOf(req)));
    }),
    r('GET', '/api/releases/posts/:id', (_req, res, _url, [id]) => {
      const post = releasePosts.get(wp, dec(id));
      if (!post) throw new NotFound(`No release post ${dec(id)}`);
      json(res, 200, post);
    }),
    r('GET', '/api/inbox/:id', (_req, res, _url, [id]) => json(res, 200, inbox.thread(wp, dec(id)))),
    r('POST', '/api/inbox/:id/reply', async (req, res, _url, [id]) => {
      const body = await readJson(req);
      json(res, 200, inbox.reply(wp, dec(id), {
        by: 'owner', via: viaOf(req),
        ...(typeof body['text'] === 'string' ? { text: body['text'] } : {}),
        ...(typeof body['optionId'] === 'string' && body['optionId'] ? { optionId: body['optionId'] } : {}),
      }));
    }),

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

const REPORT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const dec = (s: string | undefined): string => decodeURIComponent(s ?? '');

/** From this Mac itself: loopback, and not a relayed request (the tunnel arrives on loopback too and sets x-via-tunnel). */
const isLocal = (req: IncomingMessage): boolean => isLoopback(req.socket.remoteAddress) && !req.headers['x-via-tunnel'];

/** The COO bridge, pairing and the off switch: this Mac only, never through the tunnel. */
function requireLocal(req: IncomingMessage): void {
  if (!isLocal(req)) throw new BadRequest('This is reached from this Mac only.');
}

/**
 * Who an owner-facing write is attributed to (LLD §19.8 "Actor"). The COO drives the same API from
 * this Mac and says so with `x-workplace-actor: coo`; that header counts only on a local request
 * (requireLocal's test). A relayed request is always the owner, whatever it carries.
 */
export function actorOf(req: IncomingMessage): 'owner' | 'coo' {
  const raw = req.headers['x-workplace-actor'];
  if (raw === undefined || !isLocal(req)) return 'owner';
  const v = String(raw).trim().toLowerCase();
  if (v === 'coo' || v === 'owner') return v;
  throw new BadRequest(`x-workplace-actor must be coo or owner, not "${String(raw)}".`);
}

/** A `by` named in the body (old engine routes) counts only from this Mac; otherwise the actor. */
const byOf = (req: IncomingMessage, value: unknown): string =>
  isLocal(req) && typeof value === 'string' && value.trim() ? value : actorOf(req);

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

/** A Talk send body: text, reply-to, mentions, uploaded ids, base64 files (the old format). */
function talkSpec(req: IncomingMessage, body: Record<string, unknown>): talk.SendSpec {
  const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
  const raw = Array.isArray(body['attachments']) ? body['attachments'] : [];
  const attachments = raw.length ? validateMessage({ text: text || 'x', attachments: raw }).attachments : [];
  return {
    from: actorOf(req), text, attachments,
    mentions: strs(body['mentions']), attachmentIds: strs(body['attachmentIds']),
    ...(typeof body['replyTo'] === 'string' && body['replyTo'] ? { replyTo: body['replyTo'] } : {}),
    ...(body['probe'] === true ? { probe: true } : {}),
  };
}

/** A raw upload (a file or a voice note), refused past `max` bytes without reading the rest into memory. */
export async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > max) throw new TooLarge('That file is over 20 MB; send a smaller one or a link.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > max) throw new TooLarge('That file is over 20 MB; send a smaller one or a link.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new BadRequest('The upload was empty.');
  return Buffer.concat(chunks);
}

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
