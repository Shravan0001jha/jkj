import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientCommand, ServerEvent } from '@jkj/shared';
import { API } from '@jkj/shared';
import * as agents from '../services/agents.js';
import * as projects from '../services/projects.js';
import * as mcp from '../services/mcp.js';
import { log } from '../util/logger.js';

/**
 * The socket hub.
 *
 * One connection per open tab. Every client gets every event for now; when
 * that becomes wasteful, filter on the projectId from the `subscribe`
 * command, which clients already send.
 */

export function attachSocket(server: Server, version: string): void {
  const wss = new WebSocketServer({ server, path: API.socket });
  const clients = new Set<WebSocket>();

  const broadcast = (event: ServerEvent): void => {
    const payload = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
  };

  // Anything the agent service does reaches every open tab.
  agents.onAgentEvent(({ agent, entry, removedId }) => {
    if (agent) broadcast({ type: 'agent.updated', agent });
    if (entry) broadcast({ type: 'agent.log', entry });
    if (removedId) broadcast({ type: 'agent.removed', agentId: removedId });
  });

  wss.on('connection', ws => {
    clients.add(ws);
    log.info('ws', `client connected (${clients.size} open)`);

    send(ws, { type: 'hello', version, startedAt: new Date().toISOString() });
    send(ws, {
      type: 'snapshot',
      projects: projects.listProjects(),
      agents: agents.listAgents(),
      mcp: mcp.listInstalled(),
    });

    ws.on('message', raw => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(String(raw)) as ClientCommand;
      } catch {
        return send(ws, { type: 'error', message: 'Malformed command' });
      }
      handleCommand(cmd);
    });

    ws.on('close', () => {
      clients.delete(ws);
      log.info('ws', `client disconnected (${clients.size} open)`);
    });
  });
}

/** One switch, one line per command. Keep the bodies in the services. */
function handleCommand(cmd: ClientCommand): void {
  switch (cmd.type) {
    case 'subscribe':
      // TODO: remember which project this client cares about and filter events.
      break;
    case 'agent.message':
      agents.sendMessage(cmd.agentId, cmd.text);
      break;
    case 'agent.interrupt':
      agents.interruptAgent(cmd.agentId);
      break;
    case 'agent.approve':
      agents.resolveApproval(cmd.agentId, cmd.approvalId, cmd.decision);
      break;
  }
}

function send(ws: WebSocket, event: ServerEvent): void {
  ws.send(JSON.stringify(event));
}
