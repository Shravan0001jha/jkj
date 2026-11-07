import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.js';

/**
 * One server read for a screen, re-read whenever the board changes (the socket bumps `tick` on
 * sprint, item, inbox and update events) and when `key` changes. The last good value stays on screen
 * while a reload is in flight, so the page never blanks on a refresh.
 */
export function useApi<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const tick = useStore(s => s.tick);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const lastKey = useRef(key);

  useEffect(() => {
    let live = true;
    if (lastKey.current !== key) { setData(null); lastKey.current = key; }
    setLoading(true);
    loader.current().then(
      value => { if (live) { setData(value); setError(null); setLoading(false); } },
      (err: unknown) => { if (live) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); } },
    );
    return () => { live = false; };
  }, [key, tick, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { data, error, loading, reload };
}
