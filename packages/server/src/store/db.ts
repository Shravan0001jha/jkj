import { mkdirSync } from 'node:fs';

/**
 * Persistence.
 *
 * Right now everything lives in memory and dies with the process. The shape
 * below is deliberately the shape a SQLite-backed store would have, so
 * swapping the implementation does not touch any caller.
 */

export interface Store<T extends { id: string }> {
  all(): T[];
  get(id: string): T | undefined;
  put(row: T): T;
  remove(id: string): void;
}

export function createMemoryStore<T extends { id: string }>(seed: T[] = []): Store<T> {
  const rows = new Map(seed.map(r => [r.id, r]));
  return {
    all: () => [...rows.values()],
    get: id => rows.get(id),
    put: row => (rows.set(row.id, row), row),
    remove: id => void rows.delete(id),
  };
}

/**
 * Prepare the data directory and open the database.
 *
 * TODO: replace the memory stores with `node:sqlite` (built into Node 22+):
 *   - open `${dataDir}/jkj.db`
 *   - run migrations from src/store/migrations/
 *   - return real Store implementations backed by prepared statements
 */
export function openDatabase(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
}
