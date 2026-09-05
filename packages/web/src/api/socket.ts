import { useEffect, useRef, useState } from 'react';
import { API } from '@jkj/shared';
import type { ClientCommand, ServerEvent } from '@jkj/shared';

export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface SocketState {
  status: SocketStatus;
  /** The most recent event, for the hello-world panel. */
  lastEvent: ServerEvent | null;
  send: (cmd: ClientCommand) => void;
}

/**
 * One socket for the whole app.
 *
 * TODO: move the received events into state/store.ts and let components
 * select from there instead of reading `lastEvent`.
 */
export function useSocket(): SocketState {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const ref = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${API.socket}`);
    ref.current = ws;

    ws.onopen = () => setStatus('open');
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('closed');
    ws.onmessage = e => {
      try {
        setLastEvent(JSON.parse(String(e.data)) as ServerEvent);
      } catch {
        // A malformed frame is a server bug; drop it rather than crash the UI.
      }
    };

    // TODO: reconnect with backoff instead of staying closed.
    return () => ws.close();
  }, []);

  return {
    status,
    lastEvent,
    send: cmd => ref.current?.readyState === WebSocket.OPEN && ref.current.send(JSON.stringify(cmd)),
  };
}
