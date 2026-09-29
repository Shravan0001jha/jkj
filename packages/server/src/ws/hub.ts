import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientCommand, ServerEvent, WorkplaceClientCommand, WorkplaceServerEvent } from '@jkj/shared';
import { API } from '@jkj/shared';
import type { Workplace } from '../services/workplace.js';
import type { Auth } from '../http/auth.js';
import { isLoopback } from '../http/auth.js';
import * as agents from '../services/agents.js';
import * as inbox from '../services/inbox.js';
import * as views from '../services/views.js';
import { onRunEvent } from '../services/runs.js';
import { log } from '../util/logger.js';

/**
 * The socket hub: one connection per open page or phone, every Workplace
 * event fanned out. Sessions report themselves; the org and the work emit on
 * change; nothing is polled from disk.
 */

type Command = ClientCommand | WorkplaceClientCommand;

export interface SocketHub {
  /** Terminate every client; a server.close() otherwise waits for them forever. */
  close(): void;
}

export function attachSocket(server: Server, wp: Workplace, auth: Auth): SocketHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  // The lead-only COO items (an escalation, an answer, a forward — /api/coo/{items,answer,forward,
  // reply}) are loopback-only, same as those routes: a socket that arrived through the tunnel
  // (x-via-tunnel) or off loopback never gets a coo.item event. coo.message is different — that is
  // the owner's own Talk with the COO, and he reaches the Workplace only through the tunnel from
  // his phone, so it goes out to every authorised socket like any other event.
  const localOnly = new WeakSet<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== API.socket) return;
    if (!auth.allows(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const local = isLoopback(req.socket.remoteAddress) && !req.headers['x-via-tunnel'];
    wss.handleUpgrade(req, socket, head, ws => {
      if (local) localOnly.add(ws);
      wss.emit('connection', ws, req);
    });
  });

  const broadcast = (event: unknown): void => {
    const isCooItemEvent = typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'coo.item';
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (isCooItemEvent && !localOnly.has(ws)) continue;
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  onRunEvent(({ agent, entry }) => {
    if (agent) broadcast({ type: 'agent.updated', agent });
    if (entry) broadcast({ type: 'agent.log', entry });
  });
  wp.on(event => broadcast(event));

  wss.on('connection', async ws => {
    clients.add(ws);
    log.info('ws', `client connected (${clients.size} open)`);
    send(ws, { type: 'hello', version: wp.config.version, startedAt: new Date().toISOString() });
    try {
      send(ws, { type: 'snapshot', projects: [], agents: await agents.listAgents(), mcp: [] });
      broadcastTo(ws, { type: 'office.snapshot', office: views.office(wp) });
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Could not read the workplace' });
    }

    ws.on('message', raw => {
      let command: Command;
      try {
        command = JSON.parse(String(raw)) as Command;
      } catch {
        return send(ws, { type: 'error', message: 'Malformed command' });
      }
      handleCommand(wp, ws, command);
    });

    ws.on('close', () => {
      clients.delete(ws);
      log.info('ws', `client disconnected (${clients.size} open)`);
    });
  });

  return {
    close: () => {
      for (const ws of clients) ws.terminate();
      clients.clear();
      wss.close();
    },
  };
}

function handleCommand(wp: Workplace, ws: WebSocket, command: Command): void {
  try {
    switch (command.type) {
      case 'subscribe':
        break;
      case 'agent.message':
        agents.sendMessage(command.agentId, command.text);
        break;
      case 'agent.interrupt':
        void agents.interruptAgent(command.agentId);
        break;
      case 'agent.approve':
        agents.resolveApproval(command.agentId, command.decision);
        break;
      case 'agent.mode':
        agents.setPermissionMode(command.agentId, command.mode).catch(err => send(ws, {
          type: 'error', message: err instanceof Error ? err.message : 'Could not change the mode',
        }));
        break;
      case 'inbox.answer':
        inbox.answer(wp, command.id, command.optionId, command.note, 'web');
        break;
    }
  } catch (err) {
    send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Command failed' });
  }
}

function send(ws: WebSocket, event: ServerEvent): void {
  ws.send(JSON.stringify(event));
}

function broadcastTo(ws: WebSocket, event: WorkplaceServerEvent): void {
  ws.send(JSON.stringify(event));
}
