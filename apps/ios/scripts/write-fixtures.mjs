#!/usr/bin/env node
// Writes mock/data.mjs out as JSON fixtures for the XCTest target. Run `make fixtures`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures } from '../mock/data.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
mkdirSync(out, { recursive: true });
for (const [name, value] of Object.entries(fixtures())) {
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(fixtures()).length} fixtures to ${out}`);
