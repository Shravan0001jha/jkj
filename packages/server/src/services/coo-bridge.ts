import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from './workplace.js';
import { newId, now } from './store.js';

/**
 * The COO bridge file (`<workplaceDir>/coo/inbox.jsonl`), write side only. Its own module so that
 * low-level services (the Inbox copies every agent-raised owner item to the COO) can write a line
 * without importing coo.ts and the services it pulls in.
 */

export function bridgeDir(wp: Workplace): string {
  const d = join(wp.config.workplaceDir, 'coo');
  mkdirSync(d, { recursive: true });
  return d;
}

export const bridgeFile = (wp: Workplace): string => join(bridgeDir(wp), 'inbox.jsonl');

/** Append one line for the lead's watcher; returns its id (cbi_…). */
export function appendBridgeLine(wp: Workplace, entry: Record<string, unknown>): string {
  const id = newId('cbi');
  appendFileSync(bridgeFile(wp), `${JSON.stringify({ id, at: now(), ...entry })}\n`, 'utf8');
  return id;
}
