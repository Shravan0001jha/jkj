/**
 * @jkj/shared — the contract between the server, the web UI and the phone app.
 *
 * Nothing in this package may import from @jkj/server or @jkj/web.
 * Types only, plus tiny pure helpers. That rule is what keeps the sides
 * swappable.
 */
export * from './types.js';
export * from './context.js';
export * from './protocol.js';
export * from './workplace.js';
export * from './workplace-api.js';
export * from './csrf.js';
export * from './chat-view.js';
