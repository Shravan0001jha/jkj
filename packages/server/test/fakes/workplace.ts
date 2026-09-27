import type { Workplace } from '../../src/services/workplace.js';
import { createWorkplace } from '../../src/services/workplace.js';
import { loadConfig } from '../../src/config.js';
import { tmpWorkplace, type TmpWorkplace } from './tmp-workplace.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A full Workplace (config, org, in-memory store, requirements) in a temp dir. */
export function testWorkplace(overrides: Partial<Record<string, string>> = {}): { wp: Workplace; tmp: TmpWorkplace } {
  const tmp = tmpWorkplace();
  const argv = ['--no-open', '--no-seed', ...(overrides['WORKPLACE_TELEGRAM'] === '1' ? [] : ['--no-telegram'])];
  const config = loadConfig(argv, {
    IRIS_WORKPLACE_DIR: tmp.dir,
    IRIS_OPS_DIR: `${tmp.dir}/ops`,
    WORKPLACE_CAP_INR: '1000',
    WORKPLACE_USD_INR: '88',
    ...overrides,
  });
  const extract = readFileSync(fileURLToPath(new URL('../../../../docs/product-definition-extract.md', import.meta.url)), 'utf8');
  const wp = createWorkplace(config, { db: tmp.db, extractMarkdown: extract });
  return { wp, tmp };
}
