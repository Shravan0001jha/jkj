import { API } from '@jkj/shared';
import type { ServerEvent } from '@jkj/shared';

/**
 * One socket for the whole app.
 *
 * The server re-reads Claude Code's files on a timer and pushes what changed,
 * so the UI never polls. A dropped connection retries with a widening delay
 * rather than giving up — the server restarts often during development.
 */

export type SocketStatus = 'connecting' | 'open' | 'closed';

export function connect(
  onEvent: (event: ServerEvent) => void,
  onStatus: (status: SocketStatus) => void,
): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = (): void => {
    if (closed) return;
    onStatus('connecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}${API.socket}`);

    socket.onopen = () => { attempt = 0; onStatus('open'); };
    socket.onmessage = e => {
      try {
        onEvent(JSON.parse(String(e.data)) as ServerEvent);
      } catch {
        // A malformed frame is a server bug; drop it rather than crash the UI.
      }
    };
    socket.onclose = () => {
      onStatus('closed');
      if (closed) return;
      attempt += 1;
      retry = setTimeout(open, Math.min(1000 * 2 ** attempt, 15000));
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}
