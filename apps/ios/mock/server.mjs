#!/usr/bin/env node
// A dependency-free mock of the Workplace API (LLD §14) for simulator and device runs.
// REST + WebSocket, bearer-token auth off loopback, pairing, answers that mutate state,
// and a scripted stream of socket events so live updates can be seen.
//
//   node mock/server.mjs [--host 0.0.0.0] [--port 4399] [--quiet]
//
// Pairing code: 482913 (printed at start). Token after exchange: mock-token-0123456789abcdef.
// Relay sign-in: GET /login?app=1 and /login/enrol?app=1 serve a page whose button redirects to
// irisworkplace://auth#token=mock-session-<n>; any mock-session-* bearer is accepted.
// --mac-offline (or POST /api/_offline {offline:true}) answers 503 {error:"Mac offline"} like a relay
// whose Mac is down. Loopback needs no token (as the real server).

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as D from './data.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const HOST = opt('--host', '127.0.0.1');
const PORT = Number(opt("--port", 4399));
const QUIET = args.includes('--quiet');
const TOKEN = 'mock-token-0123456789abcdef';
const PAIR_CODE = '482913';
const SESSION_PREFIX = 'mock-session-';
let macOffline = args.includes('--mac-offline');

// Mutable state: a fresh copy of the data on every start, and on POST /api/_reset (tests).
const fresh = () => ({
  inbox: structuredClone(D.inbox),
  cards: structuredClone(D.cards),
  agents: Object.fromEntries(Object.values(structuredClone(D.agents)).map(a => [a.id, a])),
  logs: structuredClone(D.logs),
  features: structuredClone(D.features),
  assignments: structuredClone(D.assignments),
  spend: structuredClone(D.spend),
  threads: structuredClone(D.roomThreads),
  messages: structuredClone(D.roomMessages),
  usedCodes: new Set(),
});
let msgSeq = 100;
let state = fresh();
let logSeq = 100;

const clients = new Set();
let tick = 0;
const log = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); };

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};
const readJson = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve(null); } });
});
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const validToken = (t) => t === TOKEN || (typeof t === 'string' && t.startsWith(SESSION_PREFIX));
const authed = (req, url) => {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ') && validToken(h.slice(7))) return true;
  if (validToken(url.searchParams.get('token'))) return true;
  return isLoopback(req);
};

// The relay's sign-in pages. The button redirects to the app's callback with the session in the fragment.
const loginPage = (title, action) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui;padding:32px;max-width:420px;margin:auto}button{font-size:18px;padding:14px 20px;border-radius:12px;border:0;background:#4f66ea;color:#fff;width:100%}</style></head>
<body><h1>Iris Workplace</h1><p>Mock relay: ${title.toLowerCase()}.</p>
<button id="go" onclick="location.href='irisworkplace://auth#token=${SESSION_PREFIX}' + Date.now()">${action}</button>
<p style="color:#888;font-size:14px">Redirects to <code>irisworkplace://auth#token=…</code></p></body></html>`;
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

const office = () => ({
  units: D.units.filter(u => u.kind === 'unit').map(unit => ({ unit, employees: state.cards.filter(c => c.employee.unitId === unit.id) })),
  coverage: D.coverage,
  needsYou: state.inbox.filter(i => i.state === 'open').length,
  spend: state.spend,
  lintErrors: 0,
  counts: D.counts(state.cards, state.inbox),
});

const broadcast = (event) => {
  const frame = encodeFrame(JSON.stringify(event));
  for (const c of clients) c.write(frame);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;
  log(m, p, isLoopback(req) ? '(loopback)' : req.socket.remoteAddress);

  // Pairing: /api/pair is loopback only; /api/pair/exchange is open.
  if (m === 'POST' && p === '/api/pair') {
    if (!isLoopback(req)) return json(res, 401, { error: 'pairing starts from the Mac' });
    return json(res, 200, { code: PAIR_CODE, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  }
  if (m === 'POST' && p === '/api/pair/exchange') {
    const body = await readJson(req);
    if (!body || typeof body.code !== 'string') return json(res, 400, { error: 'code required' });
    if (body.code !== PAIR_CODE) return json(res, 400, { error: 'Unknown or expired code' });
    if (state.usedCodes.has(body.code) && !args.includes('--reusable-code')) return json(res, 409, { error: 'Code already used' });
    state.usedCodes.add(body.code);
    return json(res, 200, { token: TOKEN });
  }
  if (m === 'POST' && p === '/api/_reset') { state = fresh(); tick = 0; macOffline = false; log('state reset'); return json(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/api/_offline') { const body = await readJson(req); macOffline = !!body?.offline; log('mac offline =', macOffline); return json(res, 200, { ok: true, macOffline }); }
  if (m === 'GET' && (p === '/login' || p === '/login/')) return html(res, loginPage('Sign in', 'Sign in with passkey (mock)'));
  if (m === 'GET' && (p === '/login/enrol' || p === '/login/enrol/')) return html(res, loginPage('Set up a passkey', 'Create passkey (mock)'));
  if (macOffline && p.startsWith('/api/')) { log('503 mac offline'); return json(res, 503, { error: 'Mac offline' }); }
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });

  const seg = p.split('/').filter(Boolean); // ['api', ...]
  const id = seg[2] ? decodeURIComponent(seg[2]) : undefined;

  if (m === 'GET' && p === '/api/health') return json(res, 200, { ...D.health, uptimeSeconds: Math.round(process.uptime()) });
  if (m === 'GET' && p === '/api/office') return json(res, 200, office());
  if (m === 'GET' && p === '/api/org') return json(res, 200, D.org());
  if (m === 'GET' && seg[1] === 'charters' && id) {
    const c = D.charters.find(c => c.id === id);
    if (!c) return json(res, 404, { error: 'no such charter' });
    return json(res, 200, id === 'experts' ? D.charterFull : { ...D.charterFull, ...c, path: `/Users/shravan0001jha/iris-workplace/charters/${id}.md`, body: `# ${c.title}\n\n## Mission\n${c.mission}\n` });
  }
  if (m === 'GET' && p === '/api/inbox') return json(res, 200, [...state.inbox].sort((a, b) => (a.state === 'open') === (b.state === 'open') ? b.createdAt.localeCompare(a.createdAt) : a.state === 'open' ? -1 : 1));
  if (m === 'POST' && seg[1] === 'inbox' && seg[3] === 'answer') {
    const item = state.inbox.find(i => i.id === id);
    if (!item) return json(res, 404, { error: 'no such item' });
    if (item.state !== 'open') return json(res, 409, { error: 'Already answered' });
    const body = await readJson(req);
    const opt = item.options.find(o => o.id === body?.optionId);
    if (!opt) return json(res, 400, { error: 'unknown option' });
    if (opt.needsNote && !body.note) return json(res, 400, { error: 'This answer needs a note' });
    item.state = 'answered';
    item.answer = { optionId: opt.id, note: body.note, at: new Date().toISOString(), via: isLoopback(req) ? 'web' : 'phone' };
    broadcast({ type: 'inbox.updated', item });
    for (const card of state.cards.filter(c => c.employee.id === item.raisedBy || item.affects.includes(c.employee.id))) {
      card.needsYou = state.inbox.filter(i => i.state === 'open' && i.raisedBy === card.employee.id).length;
      broadcast({ type: 'office.updated', card });
    }
    broadcast({ type: 'alert', level: 'info', title: `Answered: ${item.title}`, body: `${opt.label}${body.note ? ' · ' + body.note : ''}`, inboxId: item.id });
    return json(res, 200, item);
  }
  if (m === 'GET' && p === '/api/employees') return json(res, 200, D.employees);
  if (m === 'GET' && seg[1] === 'employees' && id && !seg[3]) {
    const d = D.employeeDetail(id);
    if (!d) return json(res, 404, { error: 'no such employee' });
    d.sessions = Object.values(state.agents).filter(a => a.name === id);
    d.needsYou = state.inbox.filter(i => i.state === 'open' && (i.raisedBy === id || i.affects.includes(id)));
    return json(res, 200, d);
  }
  if (m === 'POST' && seg[1] === 'employees' && seg[3] === 'talk') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text required' });
    let agent = Object.values(state.agents).find(a => a.name === id && ['running', 'waiting', 'idle'].includes(a.status));
    if (!agent) {
      agent = { ...D.agents.mira, id: `s-${id}-${Date.now()}`, name: id, task: body.text.slice(0, 60), status: 'running', startedAt: new Date().toISOString(), approval: undefined, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      state.agents[agent.id] = agent;
      state.logs[agent.id] = [];
    }
    agent.status = 'running';
    const push = (kind, label, text) => {
      const entry = { id: `l-${logSeq++}`, agentId: agent.id, at: new Date().toISOString(), kind, label, text };
      state.logs[agent.id].push(entry);
      broadcast({ type: 'agent.log', entry });
    };
    push('user', '', body.text);
    broadcast({ type: 'agent.updated', agent });
    setTimeout(() => push('read', 'Read', 'employees/' + id + '/status.md'), 600);
    setTimeout(() => push('assistant', '', `On it. Current state: ${D.employeeDetail(id)?.status.split('\n')[0] ?? 'idle'}. I will report with evidence when done.`), 1600);
    setTimeout(() => { agent.status = 'idle'; agent.usage.costUsd += 0.02; broadcast({ type: 'agent.updated', agent }); }, 2200);
    return json(res, 200, agent);
  }
  if (m === 'POST' && seg[1] === 'employees' && seg[3] === 'end-session') {
    for (const a of Object.values(state.agents)) if (a.name === id && a.status !== 'done') { a.status = 'done'; a.endedAt = new Date().toISOString(); broadcast({ type: 'agent.updated', agent: a }); }
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && seg[1] === 'agents' && seg[3] === 'log') return json(res, 200, state.logs[id] ?? []);
  if (m === 'POST' && seg[1] === 'agents' && seg[3] === 'interrupt') {
    const a = state.agents[id];
    if (!a) return json(res, 404, { error: 'no such session' });
    a.status = 'idle';
    broadcast({ type: 'agent.updated', agent: a });
    const entry = { id: `l-${logSeq++}`, agentId: a.id, at: new Date().toISOString(), kind: 'system', label: '', text: 'Interrupted from the phone.' };
    (state.logs[id] ??= []).push(entry);
    broadcast({ type: 'agent.log', entry });
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/features') return json(res, 200, { features: state.features, byState: state.features.reduce((acc, f) => (acc[f.state] = (acc[f.state] ?? 0) + 1, acc), {}) });
  if (m === 'GET' && p === '/api/features/pivot') {
    const rows = url.searchParams.get('rows');
    if (!D.pivots[rows]) return json(res, 400, { error: 'rows must be charter, platform or team' });
    return json(res, 200, D.pivots[rows]);
  }
  if (m === 'GET' && seg[1] === 'features' && id && !seg[3]) {
    const d = D.featureDetail(id);
    if (!d) return json(res, 404, { error: 'no such feature' });
    d.assignments = state.assignments.filter(a => a.featureId === id);
    return json(res, 200, d);
  }
  if (m === 'GET' && p === '/api/requirements') return json(res, 200, D.requirements);
  if (m === 'GET' && p === '/api/requirements/coverage') return json(res, 200, D.coverage);
  if (m === 'GET' && p === '/api/spend') return json(res, 200, state.spend);
  if (m === 'GET' && p === '/api/health/signals') return json(res, 200, D.signals);
  if (m === 'GET' && p === '/api/work') return json(res, 200, state.assignments);
  if (m === 'GET' && p === '/api/room') return json(res, 200, { threads: [...state.threads].sort((a, b) => b.lastAt.localeCompare(a.lastAt)) });
  if (m === 'POST' && p === '/api/room') {
    const body = await readJson(req);
    if (!body || !body.title || !body.text) return json(res, 400, { error: 'title and text required' });
    const now = new Date().toISOString();
    const thread = { id: `rt-${Date.now().toString(36)}`, title: body.title, charterIds: body.charterIds ?? [], createdBy: 'owner', createdAt: now, state: 'open', lastAt: now, messageCount: 1, participants: ['owner', ...(body.mentions ?? [])], escalations: [], headline: `You opened it; waiting for ${(body.mentions ?? ['the team']).join(', ')}.` };
    const message = { id: `m-${msgSeq++}`, threadId: thread.id, at: now, by: 'owner', owner: true, text: body.text, mentions: body.mentions ?? [] };
    state.threads.push(thread); state.messages[thread.id] = [message];
    broadcast({ type: 'room.thread', thread }); broadcast({ type: 'room.message', message, thread });
    return json(res, 200, { thread, messages: [message] });
  }
  if (m === 'GET' && seg[1] === 'room' && id && !seg[3]) {
    const thread = state.threads.find(t => t.id === id);
    if (!thread) return json(res, 404, { error: 'no such thread' });
    return json(res, 200, { thread, messages: state.messages[id] ?? [] });
  }
  if (m === 'POST' && seg[1] === 'room' && seg[3] === 'messages') {
    const thread = state.threads.find(t => t.id === id);
    if (!thread) return json(res, 404, { error: 'no such thread' });
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text required' });
    const now = new Date().toISOString();
    const message = { id: `m-${msgSeq++}`, threadId: id, at: now, by: 'owner', owner: true, text: body.text, mentions: body.mentions ?? [] };
    (state.messages[id] ??= []).push(message);
    thread.lastAt = now; thread.messageCount += 1; if (!thread.participants.includes('owner')) thread.participants.push('owner');
    broadcast({ type: 'room.message', message, thread }); broadcast({ type: 'room.thread', thread });
    // A mentioned employee answers in a moment.
    const who = (body.mentions ?? [])[0] ?? thread.participants.find(x => x !== 'owner' && x !== 'workplace');
    if (who) setTimeout(() => {
      const reply = { id: `m-${msgSeq++}`, threadId: id, at: new Date().toISOString(), by: who, owner: false, text: `Noted. I will answer in the thread with evidence.\n\nDetails: reading the latest messages and my charter first; back within the hour.`, mentions: ['owner'] };
      state.messages[id].push(reply); thread.lastAt = reply.at; thread.messageCount += 1; thread.headline = `${who} replied; will answer with evidence within the hour.`;
      broadcast({ type: 'room.message', message: reply, thread }); broadcast({ type: 'room.thread', thread });
    }, 1500);
    return json(res, 200, message);
  }
  if (m === 'POST' && seg[1] === 'room' && seg[3] === 'resolve') {
    const thread = state.threads.find(t => t.id === id);
    if (!thread) return json(res, 404, { error: 'no such thread' });
    const body = await readJson(req);
    thread.state = 'resolved'; thread.summary = body?.summary ?? ''; thread.headline = `Resolved: ${thread.summary}`; thread.lastAt = new Date().toISOString();
    broadcast({ type: 'room.thread', thread });
    return json(res, 200, thread);
  }
  if (m === 'GET' && p === '/api/spend/entries') return json(res, 200, D.spendEntries);
  if (m === 'GET' && p === '/api/releases') return json(res, 200, [D.release]);
  if (m === 'GET' && p === '/api/proposals') return json(res, 200, [D.proposal]);
  return json(res, 404, { error: `no route ${m} ${p}` });
});

// ---- WebSocket (RFC 6455, server side, text frames only) ----

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  if (!authed(req, url)) { socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n'); log('ws refused (no token)'); return; }
  if (macOffline) { socket.end('HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: 23\r\n\r\n{"error":"Mac offline"}'); log('ws refused (mac offline)'); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  clients.add(socket);
  log('ws open', `(${clients.size})`);
  socket.write(encodeFrame(JSON.stringify({ type: 'hello', version: D.health.version, startedAt: new Date().toISOString() })));
  socket.write(encodeFrame(JSON.stringify({ type: 'snapshot', projects: [], agents: Object.values(state.agents), mcp: [] })));
  socket.write(encodeFrame(JSON.stringify({ type: 'office.snapshot', office: office() })));

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = decodeFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.length);
      if (f.opcode === 0x8) { socket.end(encodeFrame('', 0x8)); break; }
      if (f.opcode === 0x9) { socket.write(encodeFrame(f.payload, 0xA)); continue; }
      if (f.opcode === 0x1) handleCommand(socket, f.payload.toString('utf8'));
    }
  });
  socket.on('close', () => { clients.delete(socket); log('ws closed', `(${clients.size})`); });
  socket.on('error', () => clients.delete(socket));
});

function handleCommand(socket, text) {
  let cmd;
  try { cmd = JSON.parse(text); } catch { return socket.write(encodeFrame(JSON.stringify({ type: 'error', message: 'Malformed command' }))); }
  log('ws command', cmd.type);
  switch (cmd.type) {
    case 'agent.approve': {
      const a = state.agents[cmd.agentId];
      if (!a || !a.approval || a.approval.id !== cmd.approvalId) return socket.write(encodeFrame(JSON.stringify({ type: 'error', message: 'No such approval' })));
      const tool = a.approval.tool;
      a.approval = undefined;
      a.status = cmd.decision === 'deny' ? 'idle' : 'running';
      if (cmd.decision === 'always') a.alwaysAllowed = [...new Set([...(a.alwaysAllowed ?? []), tool])];
      broadcast({ type: 'agent.updated', agent: a });
      const entry = { id: `l-${logSeq++}`, agentId: a.id, at: new Date().toISOString(), kind: 'system', label: '', text: cmd.decision === 'deny' ? `${tool} denied from the phone.` : `${tool} approved (${cmd.decision}).` };
      (state.logs[a.id] ??= []).push(entry);
      broadcast({ type: 'agent.log', entry });
      if (cmd.decision !== 'deny') {
        setTimeout(() => {
          const e2 = { id: `l-${logSeq++}`, agentId: a.id, at: new Date().toISOString(), kind: 'assistant', label: '', text: '48 passed, 0 failed. Moving the assignment to review with the evidence attached.' };
          state.logs[a.id].push(e2);
          broadcast({ type: 'agent.log', entry: e2 });
          a.status = 'idle';
          broadcast({ type: 'agent.updated', agent: a });
        }, 1500);
      }
      break;
    }
    case 'agent.mode': {
      const a = state.agents[cmd.agentId];
      if (!a) return;
      a.permissionMode = cmd.mode;
      broadcast({ type: 'agent.updated', agent: a });
      break;
    }
    case 'agent.interrupt': {
      const a = state.agents[cmd.agentId];
      if (!a) return;
      a.status = 'idle';
      broadcast({ type: 'agent.updated', agent: a });
      break;
    }
    case 'inbox.answer': {
      const item = state.inbox.find(i => i.id === cmd.id);
      if (!item || item.state !== 'open') return socket.write(encodeFrame(JSON.stringify({ type: 'error', message: 'Already answered' })));
      item.state = 'answered';
      item.answer = { optionId: cmd.optionId, note: cmd.note, at: new Date().toISOString(), via: 'phone' };
      broadcast({ type: 'inbox.updated', item });
      break;
    }
    default:
      break;
  }
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, data]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, length: off + maskLen + len };
}

// ---- A scripted stream of live events, so the screens visibly change ----

setInterval(() => {
  if (clients.size === 0) return;
  tick++;
  const rohan = state.cards.find(c => c.employee.id === 'rohan');
  switch (tick % 6) {
    case 1: {
      state.spend.companyInr = Math.round((state.spend.companyInr + 3.5) * 10) / 10;
      state.spend.byEmployee.rohan = Math.round((state.spend.byEmployee.rohan + 3.5) * 10) / 10;
      broadcast({ type: 'spend.updated', summary: state.spend });
      break;
    }
    case 2: {
      const a = Object.values(state.agents).find(x => x.name === 'rohan');
      if (!a) break;
      const entry = { id: `l-${logSeq++}`, agentId: a.id, at: new Date().toISOString(), kind: 'bash', label: 'Bash', text: `npm test -- --grep errand  # run ${tick}` };
      (state.logs[a.id] ??= []).push(entry);
      broadcast({ type: 'agent.log', entry });
      break;
    }
    case 3: {
      if (!rohan) break;
      rohan.lastReport = `Desktop handler: ${212 + tick} tests green, live run ${tick} of 20 done.`;
      rohan.spendTodayInr = state.spend.byEmployee.rohan;
      broadcast({ type: 'office.updated', card: rohan });
      break;
    }
    case 5: {
      if (tick % 30 === 5) broadcast({ type: 'alert', level: 'needs-you', title: 'Mira needs an approval', body: 'Run pytest on the errand tests?', inboxId: 'ib-5' });
      break;
    }
    default: break;
  }
}, 5000);

server.listen(PORT, HOST, () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Mock Workplace listening on http://${HOST}:${PORT}`);
  if (HOST !== '127.0.0.1') console.log(`LAN addresses: ${ips.join(', ')}`);
  console.log(`Pairing code: ${PAIR_CODE}   (token after exchange: ${TOKEN})`);
});
