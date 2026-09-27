import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Requirement, WorkplaceServerEvent, ServerEvent } from '@jkj/shared';
import type { Config } from '../config.js';
import { ensureWorkplace, loadOrg, type Org } from './org.js';
import { openStore, type Db } from './store.js';
import { importRequirements, readRequirements, withOwners } from './requirements.js';
import { log } from '../util/logger.js';

/**
 * The one object every Workplace service works on: the config, the live
 * organisation, the store, and the event bus the socket hub fans out.
 *
 * Services take it as their first argument rather than importing singletons,
 * so a test can hold a dozen workplaces in temp directories at once.
 */

export type WorkplaceEvent = WorkplaceServerEvent | ServerEvent;
type Listener = (event: WorkplaceEvent) => void;

export interface Workplace {
  config: Config;
  org: Org;
  db: Db;
  /** Requirements with their owners resolved through the current map. */
  requirements(): Requirement[];
  reloadOrg(): Org;
  emit(event: WorkplaceEvent): void;
  on(listener: Listener): () => void;
}

export const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));
const EXTRACT_PATH = fileURLToPath(new URL('../../../../docs/product-definition-extract.md', import.meta.url));

export function createWorkplace(config: Config, options: { db?: Db; extractMarkdown?: string } = {}): Workplace {
  const { seeded } = config.seed
    ? ensureWorkplace(config.workplaceDir, SEED_DIR)
    : { seeded: false };
  if (seeded) log.info('workplace', `seeded ${config.workplaceDir} from ${SEED_DIR}`);

  const db = options.db ?? openStore(join(config.workplaceDir, 'workplace.db'));
  const listeners = new Set<Listener>();
  const state = { org: loadOrg(config.workplaceDir) };

  // Requirements are imported once; a later re-import is an explicit action.
  if (readRequirements(config.workplaceDir).length === 0) {
    const markdown = options.extractMarkdown ?? readExtract();
    const imported = importRequirements(config.workplaceDir, markdown);
    log.info('workplace', `imported ${imported.length} requirements`);
  }

  return {
    config,
    get org() { return state.org; },
    db,
    requirements: () => withOwners(readRequirements(config.workplaceDir), state.org.map),
    reloadOrg: () => { state.org = loadOrg(config.workplaceDir); return state.org; },
    emit: event => { for (const fn of listeners) { try { fn(event); } catch (err) { log.warn('events', String(err)); } } },
    on: fn => { listeners.add(fn); return () => void listeners.delete(fn); },
  };
}

function readExtract(): string {
  try {
    return readFileSync(EXTRACT_PATH, 'utf8');
  } catch {
    log.warn('workplace', `no product-definition extract at ${EXTRACT_PATH}; only the checklist is imported`);
    return '';
  }
}
