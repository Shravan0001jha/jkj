import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as work from '../src/services/work.js';
import * as docs from '../src/services/docs.js';
import { NotionClient, NOTION_VERSION, type Block, type RichText } from '../src/services/notion.js';
import { workplaceTools, WORKPLACE_TOOLS } from '../src/services/employees.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeNotion, OWNER_ID } from './fakes/fake-notion.js';

/** W7 (TDD-rework-2026-10 §W7): Notion docs, with the Notion port faked. */

type WP = ReturnType<typeof testWorkplace>['wp'];

async function toolsFor(wp: WP, employeeId: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as { type: string; text: string }[]).map(c => c.text).join('\n');
  };
  return { client, call };
}

function story(wp: WP) {
  const epic = items.create(wp, { level: 'epic', title: 'Iris remembers names', ownerId: 'asha' }, 'owner');
  return items.create(wp, { level: 'story', parentId: epic.id, title: 'Names are forgotten after restart', assigneeId: 'mira' }, 'asha');
}

const plain = (rt: RichText[]) => rt.map(r => r.text.content).join('');
const payload = <T>(b: Block): T => b[b.type] as T;

const SAMPLE = [
  '# Memory of names',
  '',
  'Intro with **bold**, *italic*, `code` and a [link](https://example.com/a).',
  '',
  '## Steps',
  '',
  '- one',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] open todo',
  '- [x] done todo',
  '',
  '### Flow',
  '',
  '```mermaid',
  'graph TD',
  '  A-->B',
  '```',
  '',
  '```typescript',
  'const a = 1;',
  '```',
  '',
  '> a quote',
  '',
  '| Case | Result |',
  '| --- | --- |',
  '| greet | **pass** |',
  '| recall | [log](https://example.com/log) |',
].join('\n');

/* ---------- markdown conversion ---------- */

test('1. headings, lists, to-dos, a mermaid code block, a table and links convert to blocks', () => {
  const blocks = docs.markdownToBlocks(SAMPLE);
  assert.deepEqual(blocks.map(b => b.type), [
    'heading_1', 'paragraph', 'heading_2', 'bulleted_list_item', 'bulleted_list_item', 'numbered_list_item', 'numbered_list_item',
    'to_do', 'to_do', 'heading_3', 'code', 'code', 'quote', 'table',
  ]);
  const intro = payload<{ rich_text: RichText[] }>(blocks[1]!).rich_text;
  assert.equal(plain(intro), 'Intro with bold, italic, code and a link.');
  assert.equal(intro.find(r => r.text.content === 'bold')!.annotations?.bold, true);
  assert.equal(intro.find(r => r.text.content === 'italic')!.annotations?.italic, true);
  assert.equal(intro.find(r => r.text.content === 'code')!.annotations?.code, true);
  assert.equal(intro.find(r => r.text.content === 'link')!.text.link?.url, 'https://example.com/a');
  assert.equal(payload<{ checked: boolean }>(blocks[7]!).checked, false);
  assert.equal(payload<{ checked: boolean }>(blocks[8]!).checked, true);
  const mermaid = payload<{ language: string; rich_text: RichText[] }>(blocks[10]!);
  assert.equal(mermaid.language, 'mermaid', 'mermaid stays mermaid');
  assert.equal(plain(mermaid.rich_text), 'graph TD\n  A-->B');
  const table = payload<{ table_width: number; has_column_header: boolean; children: Block[] }>(blocks[13]!);
  assert.equal(table.table_width, 2);
  assert.equal(table.has_column_header, true);
  assert.equal(table.children.length, 3);
  const cells = payload<{ cells: RichText[][] }>(table.children[1]!).cells;
  assert.equal(plain(cells[0]!), 'greet');
  assert.equal(cells[1]![0]!.annotations?.bold, true);
  assert.equal(payload<{ cells: RichText[][] }>(table.children[2]!).cells[1]![0]!.text.link?.url, 'https://example.com/log');
});

test('2. converting those blocks back gives the same markdown', () => {
  assert.equal(docs.blocksToMarkdown(docs.markdownToBlocks(SAMPLE)), SAMPLE);
});

test('3. text over 2000 characters is split into chunks of at most 2000', () => {
  const long = 'x'.repeat(4500);
  const code = 'y'.repeat(2500);
  const md = `${long}\n\n\`\`\`\n${code}\n\`\`\``;
  const blocks = docs.markdownToBlocks(md);
  const para = payload<{ rich_text: RichText[] }>(blocks[0]!).rich_text;
  assert.deepEqual(para.map(r => r.text.content.length), [2000, 2000, 500]);
  const codeRt = payload<{ rich_text: RichText[] }>(blocks[1]!).rich_text;
  assert.deepEqual(codeRt.map(r => r.text.content.length), [2000, 500]);
  assert.equal(docs.blocksToMarkdown(blocks), md, 'chunks join back without a seam');
  // A long bold run stays one bold run when read back.
  const bold = docs.markdownToBlocks(`**${'b'.repeat(2100)}**`);
  assert.equal(docs.blocksToMarkdown(bold), `**${'b'.repeat(2100)}**`);
});

test('3b. a long doc is appended in groups of at most 100 blocks, in order', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    const md = Array.from({ length: 250 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n');
    const mira = await toolsFor(wp, 'mira');
    const out = await mira.call('doc_write', { itemId: s.id, type: 'Research', title: 'Long research', markdown: md });
    assert.match(out, /https:\/\/www\.notion\.so\//);
    const pageId = work.get(wp, s.id)!.docId!;
    const appends = notion.calls.filter(c => c.op === 'appendBlocks' && c.args[0] === pageId).map(c => c.args[1] as number);
    assert.ok(appends.length >= 3 && appends.every(n => n <= 100), `appends: ${appends.join(',')}`);
    const texts = notion.pageBlocks(pageId).filter(b => b.type === 'paragraph').map(b => plain(payload<{ rich_text: RichText[] }>(b).rich_text));
    assert.equal(texts[0], 'Paragraph 1');
    assert.equal(texts[249], 'Paragraph 250');
    await mira.client.close();
  } finally { tmp.cleanup(); }
});

/* ---------- doc_write ---------- */

test('4. the first doc_write creates the database and a page with the properties and the template headings', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    const mira = await toolsFor(wp, 'mira');
    const out = await mira.call('doc_write', { itemId: s.id, type: 'RCA', title: 'RCA: names forgotten', markdown: '## Symptom\n\nNames vanish after a restart.' });
    assert.equal(notion.count('createDatabase'), 1);
    const db = [...notion.databases.values()][0]!;
    assert.equal(db.parentPageId, wp.config.notionRootPageId);
    const dbProps = db.body['properties'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(dbProps).sort(), ['Charter', 'Date', 'Name', 'Owner', 'Status', 'Story', 'Story id', 'Type'].sort());
    const typeOptions = (dbProps['Type']!['select'] as { options: { name: string }[] }).options.map(o => o.name);
    assert.deepEqual(typeOptions, ['RCA', 'Design', 'Research', 'QA report', 'Release report', 'Incident', 'Decision']);
    assert.deepEqual((dbProps['Status']!['select'] as { options: { name: string }[] }).options.map(o => o.name), ['Draft', 'In review', 'Final']);
    assert.equal(notion.count('createPage'), 1);
    const page = [...notion.pages.values()][0]!;
    const props = page.properties as Record<string, Record<string, unknown>>;
    assert.equal(plain(props['Name']!['title'] as RichText[]), 'RCA: names forgotten');
    assert.deepEqual(props['Type']!['select'], { name: 'RCA' });
    assert.deepEqual(props['Status']!['select'], { name: 'Draft' });
    assert.equal(plain(props['Owner']!['rich_text'] as RichText[]), 'Mira');
    assert.equal(plain(props['Story id']!['rich_text'] as RichText[]), s.id);
    assert.match(props['Story']!['url'] as string, new RegExp(`/api/items/${s.id}$`));
    assert.match((props['Date']!['date'] as { start: string }).start, /^\d{4}-\d{2}-\d{2}$/);
    const headings = notion.pageBlocks(page.id).filter(b => b.type.startsWith('heading_')).map(b => plain(payload<{ rich_text: RichText[] }>(b).rich_text));
    assert.deepEqual(headings, ['Symptom', 'Root cause', 'Why it escaped', 'Fix at the root', 'Regression guard'], 'template headings the markdown lacked are added, none twice');
    assert.match(out, new RegExp(page.url.replace(/[.]/g, '\\.')));
    assert.equal(wp.db.prepare('select value from settings where key = ?').get('notion:docs-db') ? true : false, true);
    await mira.client.close();
  } finally { tmp.cleanup(); }
});

test('5. a second doc_write on the same story updates that same page: one doc per story', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    const mira = await toolsFor(wp, 'mira');
    await mira.call('doc_write', { itemId: s.id, type: 'Design', title: 'Names design', markdown: '## Context\n\nFirst draft.' });
    const pageId = work.get(wp, s.id)!.docId!;
    const out = await mira.call('doc_write', { itemId: s.id, type: 'Design', title: 'Names design v2', markdown: '## Context\n\nSecond draft.', status: 'In review' });
    assert.equal(notion.count('createPage'), 1, 'no second page');
    assert.equal(notion.count('createDatabase'), 1, 'the database is found, not made again');
    assert.equal(work.get(wp, s.id)!.docId, pageId);
    const props = notion.pages.get(pageId)!.properties as Record<string, Record<string, unknown>>;
    assert.equal(plain(props['Name']!['title'] as RichText[]), 'Names design v2');
    assert.deepEqual(props['Status']!['select'], { name: 'In review' });
    const md = docs.blocksToMarkdown(notion.pageBlocks(pageId));
    assert.match(md, /Second draft\./);
    assert.doesNotMatch(md, /First draft\./, 'the old content is replaced, not appended to');
    assert.equal(md.match(/## Context/g)!.length, 1);
    assert.match(out, /notion\.so/);
    // Read back through doc_read.
    const read = await mira.call('doc_read', { itemId: s.id });
    assert.match(read, /Second draft\./);
    await mira.client.close();
  } finally { tmp.cleanup(); }
});

test('5b. a story whose link was lost finds its page by Story id instead of making a second one', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Decision', title: 'Pick', markdown: 'v1' });
    const w = work.get(wp, s.id)!;
    const { docId: _d, docUrl: _u, ...rest } = w;
    work.saveQuiet(wp, rest);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Decision', title: 'Pick', markdown: 'v2' });
    assert.equal(notion.count('createPage'), 1);
    assert.equal(work.get(wp, s.id)!.docId, w.docId);
  } finally { tmp.cleanup(); }
});

test('6. doc_write sets item.docUrl and docId, records a doc activity, and the item shows the link', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'QA report', title: 'QA', markdown: 'All good.' });
    const w = work.get(wp, s.id)!;
    const page = [...notion.pages.values()][0]!;
    assert.equal(w.docUrl, page.url);
    assert.equal(w.docId, page.id);
    assert.equal(items.get(wp, s.id)!.docUrl, page.url);
    const act = trail.activityFor(wp, s.id).filter(a => a.kind === 'doc');
    assert.equal(act.length, 1);
    assert.equal(act[0]!.by, 'mira');
    assert.equal(act[0]!.link, page.url);
  } finally { tmp.cleanup(); }
});

/* ---------- comments ---------- */

test('7. doc_comment posts under the agent\'s name: display_name custom "Mira (lead)"; a quote anchors it to its block', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    const mira = await toolsFor(wp, 'mira');
    await mira.call('doc_write', { itemId: s.id, type: 'Research', title: 'R', markdown: '## Question\n\nWhy do names vanish?\n\n## Findings\n\nThe cache is per process.' });
    const pageId = work.get(wp, s.id)!.docId!;
    const out = await mira.call('doc_comment', { itemId: s.id, text: 'Ready for a look.' });
    assert.match(out, /Commented/);
    const body = notion.last('createComment')![0] as { parent: Record<string, string>; display_name: unknown; rich_text: RichText[] };
    assert.deepEqual(body.display_name, { type: 'custom', custom: { name: 'Mira (lead)' } });
    assert.deepEqual(body.parent, { page_id: pageId });
    assert.equal(plain(body.rich_text), 'Ready for a look.');
    await mira.call('doc_comment', { itemId: s.id, text: 'This is the cause.', quote: 'cache is per process' });
    const anchored = notion.last('createComment')![0] as { parent: Record<string, string> };
    const target = notion.pageBlocks(pageId).find(b => plain(payload<{ rich_text: RichText[] }>(b).rich_text ?? []).includes('cache is per process'))!;
    assert.deepEqual(anchored.parent, { block_id: target.id });
    await mira.client.close();
  } finally { tmp.cleanup(); }
});

test('8. the relay forwards the owner\'s comment to the doc owner exactly once, and records it on the item', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Design', title: 'D', markdown: '## Context\n\nThe cache.' });
    const pageId = work.get(wp, s.id)!.docId!;
    notion.ownerComments(pageId, 'Why not persist to SQLite?');
    const block = notion.pageBlocks(pageId).find(b => b.type === 'paragraph')!;
    notion.ownerComments(block.id!, 'Explain this line.', { withType: true });
    const delivered: { to: string; text: string }[] = [];
    const deliver = (to: string, text: string) => { delivered.push({ to, text }); };
    assert.equal(await docs.relaySweep(wp, { deliver }), 2);
    assert.equal(await docs.relaySweep(wp, { deliver }), 0, 'the second sweep relays nothing new');
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every(d => d.to === 'mira'));
    assert.match(delivered[0]!.text, /Why not persist to SQLite\?/);
    assert.match(delivered[0]!.text, new RegExp(s.id));
    assert.match(delivered[1]!.text, /Explain this line\./);
    assert.match(delivered[1]!.text, /The cache\./, 'a block comment carries the text it is on');
    const ownerComments = trail.comments(wp, s.id).filter(c => c.by === 'owner');
    assert.equal(ownerComments.length, 2);
    assert.match(ownerComments[0]!.details ?? ownerComments[0]!.text, /Why not persist to SQLite\?/);
    assert.ok(wp.db.prepare('select value from settings where key = ?').get(`notion:seen:${pageId}`));
  } finally { tmp.cleanup(); }
});

test('8b. a rewrite never loses an owner comment on a block it deletes', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Design', title: 'D', markdown: 'Old line.' });
    const pageId = work.get(wp, s.id)!.docId!;
    const block = notion.pageBlocks(pageId).find(b => b.type === 'paragraph')!;
    notion.ownerComments(block.id!, 'Keep this line.');
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Design', title: 'D', markdown: 'New line.' });
    const delivered: string[] = [];
    await docs.relaySweep(wp, { deliver: (_to, text) => { delivered.push(text); } });
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /Keep this line\./);
    assert.match(delivered[0]!, /Old line\./);
  } finally { tmp.cleanup(); }
});

test('9. the bot\'s own comments are ignored by the relay', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Incident', title: 'I', markdown: 'Down for 5 min.' });
    await docs.docComment(wp, 'mira', { itemId: s.id, text: 'Timeline added.' });
    await docs.docComment(wp, 'asha', { itemId: s.id, text: 'Looks right.', quote: 'Down for 5 min' });
    const delivered: string[] = [];
    assert.equal(await docs.relaySweep(wp, { deliver: (_to, text) => { delivered.push(text); } }), 0);
    assert.deepEqual(delivered, []);
    assert.equal(trail.comments(wp, s.id).filter(c => c.by === 'owner').length, 0);
    assert.ok(!notion.calls.some(c => c.op === 'getUser' && c.args[0] !== OWNER_ID), 'the bot is known from me(), not looked up per comment');
  } finally { tmp.cleanup(); }
});

test('9b. docs of finished stories are not swept', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Decision', title: 'D', markdown: 'Pick A.' });
    const w = work.get(wp, s.id)!;
    work.saveQuiet(wp, { ...w, status: 'done', resolution: 'done' });
    notion.ownerComments(w.docId!, 'Late note.');
    const before = notion.count('listComments');
    assert.equal(await docs.relaySweep(wp, { deliver: () => {} }), 0);
    assert.equal(notion.count('listComments'), before);
  } finally { tmp.cleanup(); }
});

/* ---------- missing key ---------- */

test('10. with no key the tools return "Docs are not set up yet" and the sweep is a no-op', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    assert.equal(docs.notionPort(wp), null, 'the temp ops dir has no notion.key');
    const mira = await toolsFor(wp, 'mira');
    for (const [name, args] of [
      ['doc_write', { itemId: s.id, type: 'RCA', title: 'x', markdown: 'y' }],
      ['doc_read', { itemId: s.id }],
      ['doc_comment', { itemId: s.id, text: 'z' }],
    ] as const) {
      assert.match(await mira.call(name, args), /Docs are not set up yet/, name);
    }
    let called = false;
    assert.equal(await docs.relaySweep(wp, { deliver: () => { called = true; } }), 0);
    assert.equal(called, false);
    await mira.client.close();
  } finally { tmp.cleanup(); }
});

test('the doc tools are Workplace tools', () => {
  for (const name of ['doc_write', 'doc_read', 'doc_comment']) assert.ok((WORKPLACE_TOOLS as readonly string[]).includes(name), name);
});

test('doc_read caps at 30k characters and says so', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const s = story(wp);
    await docs.docWrite(wp, 'mira', { itemId: s.id, type: 'Research', title: 'Big', markdown: Array.from({ length: 40 }, () => 'z'.repeat(1000)).join('\n\n') });
    const out = await docs.docRead(wp, s.id);
    assert.ok(out.length < 31_000, String(out.length));
    assert.match(out, /cut at 30000 characters/);
    assert.match(out, /notion\.so/);
    assert.match(await docs.docRead(wp, story(wp).id), /No doc/);
  } finally { tmp.cleanup(); }
});

/* ---------- the client ---------- */

test('the Notion client: version header, key from file, one 429 retry after Retry-After, the key never in an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-key-'));
  const keyPath = join(dir, 'notion.key');
  writeFileSync(keyPath, 'secret_TESTKEY123\n');
  try {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const waits: number[] = [];
    let n = 0;
    const client = new NotionClient({
      keyPath,
      sleep: async ms => { waits.push(ms); },
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers });
        n++;
        if (n === 1) return { status: 429, headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) }, text: async () => '{}' };
        if (n === 2) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ results: [{ id: 'c1' }], has_more: true, next_cursor: 'cur' }) };
        if (n === 3) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ results: [{ id: 'c2' }], has_more: false, next_cursor: null }) };
        return { status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ code: 'unauthorized', message: 'API token secret_TESTKEY123 is invalid.' }) };
      },
    });
    assert.equal(client.available(), true);
    const comments = await client.listComments('blk-1');
    assert.deepEqual(comments.map(c => c.id), ['c1', 'c2'], 'pages through next_cursor');
    assert.deepEqual(waits, [2000]);
    assert.equal(seen[0]!.headers['Notion-Version'], NOTION_VERSION);
    assert.equal(seen[0]!.headers['Authorization'], 'Bearer secret_TESTKEY123');
    assert.match(seen[2]!.url, /start_cursor=cur/);
    await assert.rejects(client.me(), (err: Error) => /401/.test(err.message) && !err.message.includes('secret_TESTKEY123'));
    rmSync(keyPath);
    assert.equal(client.available(), false);
    await assert.rejects(client.me(), /key file is missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
