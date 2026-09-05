import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Agent, ClientCommand, ServerEvent } from '@jkj/shared';
import { API } from '@jkj/shared';
import { getSnapshot } from '../services/workspace.js';
import { listInstalled } from '../services/mcp.js';
import { log } from '../util/logger.js';

/**
 * The socket hub.
 *
 * Claude Code writes its state to disk; nothing notifies us when it changes.
 * So the hub re-reads the snapshot on a timer and pushes only what differs,
 * which keeps every open tab current without any client polling.
 */

const POLL_MS = 2500;

export function attachSocket(server: Server, version: string): void {
  const wss = new WebSocketServer({ server, path: API.socket });
  const clients = new Set<WebSocket>();
  let previous = new Map<string, string>();   // agent id -> fingerprint
  let timer: ReturnType<typeof setInterval> | null = null;

  const broadcast = (event: ServerEvent): void => {
    const payload = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
  };

  async function poll(): Promise<void> {
    if (clients.size === 0) return;
    try {
      const { agents } = await getSnapshot(true);
      const next = new Map(agents.map(a => [a.id, fingerprint(a)]));

      for (const agent of agents) {
        if (previous.get(agent.id) !== next.get(agent.id)) broadcast({ type: 'agent.updated', agent });
      }
      for (const id of previous.keys()) {
        if (!next.has(id)) broadcast({ type: 'agent.removed', agentId: id });
      }
      previous = next;
    } catch (err) {
      log.warn('ws', `poll failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  wss.on('connection', async ws => {
    clients.add(ws);
    log.info('ws', `client connected (${clients.size} open)`);

    send(ws, { type: 'hello', version, startedAt: new Date().toISOString() });

    try {
      const snapshot = await getSnapshot();
      previous = new Map(snapshot.agents.map(a => [a.id, fingerprint(a)]));
      send(ws, {
        type: 'snapshot',
        projects: snapshot.projects,
        agents: snapshot.agents,
        mcp: await listInstalled(),
      });
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Could not read your sessions' });
    }

    if (!timer) timer = setInterval(() => void poll(), POLL_MS);

    ws.on('message', raw => {
      let command: ClientCommand;
      try {
        command = JSON.parse(String(raw)) as ClientCommand;
      } catch {
        return send(ws, { type: 'error', message: 'Malformed command' });
      }
      handleCommand(ws, command);
    });

    ws.on('close', () => {
      clients.delete(ws);
      log.info('ws', `client disconnected (${clients.size} open)`);
      if (clients.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    });
  });
}

/**
 * Every command is a write, and JKJ cannot write to a running session yet.
 * Saying so is better than accepting the command and dropping it.
 */
function handleCommand(ws: WebSocket, command: ClientCommand): void {
  if (command.type === 'subscribe') return;
  send(ws, {
    type: 'error',
    message: 'JKJ can read your sessions but not drive them yet.',
  });
}

/** Cheap change detection — the fields the UI actually renders. */
function fingerprint(agent: Agent): string {
  return [agent.status, agent.name, agent.task, agent.usage.inputTokens, agent.usage.outputTokens].join('|');
}

function send(ws: WebSocket, event: ServerEvent): void {
  ws.send(JSON.stringify(event));
}
