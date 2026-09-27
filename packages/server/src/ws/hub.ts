import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientCommand, ServerEvent, WorkplaceClientCommand } from '@jkj/shared';
import { API } from '@jkj/shared';
import type { Workplace } from '../services/workplace.js';
import type { Auth } from '../http/auth.js';
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

export function attachSocket(server: Server, wp: Workplace, auth: Auth): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== API.socket) return;
    if (!auth.allows(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  const broadcast = (event: unknown): void => {
    const payload = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
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
      ws.send(JSON.stringify({ type: 'office.snapshot', office: views.office(wp) }));
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
