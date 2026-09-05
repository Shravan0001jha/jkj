/**
 * @jkj/shared — the contract between the server and the web UI.
 *
 * Nothing in this package may import from @jkj/server or @jkj/web.
 * Types only, plus tiny pure helpers. That rule is what keeps the two
 * sides swappable.
 */
export * from './types.js';
export * from './protocol.js';
