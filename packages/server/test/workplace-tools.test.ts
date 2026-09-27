import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { workplaceTools, WORKPLACE_TOOLS } from '../src/services/employees.js';
import * as proposals from '../src/services/proposals.js';
import { readEmployeeFile } from '../src/services/org.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The Workplace's own tools, listed and called through a real MCP client.
 * A schema the MCP SDK cannot serialise takes every tool of the server down
 * with it, silently; this is the test that caught it.
 */
async function connect(wp: ReturnType<typeof testWorkplace>['wp'], employeeId: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  return client;
}

test('every Workplace tool is listed by an MCP client', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const client = await connect(wp, 'asha');
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(names, [...WORKPLACE_TOOLS].sort());
    await client.close();
  } finally {
    tmp.cleanup();
  }
});

test('report_status and write_handoff write the employee files; propose_org_change files a proposal', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const client = await connect(wp, 'asha');
    await client.callTool({ name: 'report_status', arguments: { doing: 'the split plan', done: 'nothing yet', blocked: '-' } });
    await client.callTool({ name: 'write_handoff', arguments: { handoff: 'Next: ask the leads for boundaries.' } });
    assert.equal(readEmployeeFile(wp.org, 'asha', 'status.md'), 'doing: the split plan\ndone: nothing yet\nblocked: -\n');
    assert.equal(readEmployeeFile(wp.org, 'asha', 'handoff.md'), 'Next: ask the leads for boundaries.\n');
    const r = await client.callTool({ name: 'propose_org_change', arguments: { kind: 'reassign', reason: 'Mira knows the character code.', paramsJson: JSON.stringify({ charterId: 'character', toEmployeeId: 'mira' }) } });
    assert.match(JSON.stringify(r.content), /Proposed as op_/);
    assert.equal(proposals.list(wp).length, 1);
    const bad = await client.callTool({ name: 'propose_org_change', arguments: { kind: 'hire', reason: 'x', paramsJson: '{not json' } });
    assert.match(JSON.stringify(bad.content), /not valid JSON/);
    await client.close();
  } finally {
    tmp.cleanup();
  }
});
