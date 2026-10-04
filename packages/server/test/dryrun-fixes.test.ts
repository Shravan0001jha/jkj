import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as employees from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Dry run, 4 Oct: the fixes found in the night's practice stories (#11, #17, #19, #20, #22, #23). */

const runtime = installFakeRuntime();
after(() => runtime.restore());

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

test('#11: every employee session runs with WORKPLACE_EMPLOYEE=<its id>, so pre-pr.sh records who ran it', () => {
  const { wp, tmp } = testWorkplace();
  withOauth(tmp.dir);
  try {
    employees.talk(wp, 'tara', 'hello', [], { autonomous: true });
    const env = runtime.last().options.env!;
    assert.equal(env['WORKPLACE_EMPLOYEE'], 'tara');
    assert.equal(employees.childEnv(wp)['WORKPLACE_EMPLOYEE'], undefined, 'never inherited from the server');
  } finally { tmp.cleanup(); }
});
