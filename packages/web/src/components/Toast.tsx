import { useStore } from '../state/store.js';

/** Transient confirmation of something that happened off-screen. */
export function Toast() {
  const message = useStore(s => s.toast);
  if (!message) return null;
  return <div className="toast" role="status">{message}</div>;
}
