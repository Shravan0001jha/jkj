import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as docs from '../src/services/docs.js';
import type { Block } from '../src/services/notion.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeNotion } from './fakes/fake-notion.js';

/**
 * 13 Nov (as_mw76f3kofcnj3, notifications design): Vikram's doc_write erased the HLD, decisions and LLD
 * sections. Those ## headings had no known owner (written by hand / by another path), so the doc tool
 * filed them under the previous writer's section and deleted them on that writer's rewrite.
 */
const h2 = (text: string): Block => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: text } }] } } as unknown as Block);
const para = (text: string): Block => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } } as unknown as Block);

test('an unowned ## section after a writer\'s section survives that writer\'s rewrite', async () => {
  const { wp, tmp } = testWorkplace();
  const notion = new FakeNotion();
  docs.setNotionPort(wp, notion);
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Notifications', ownerId: 'asha' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Notifications HLD', assigneeId: 'mira' }, 'asha');
    await docs.docWrite(wp, 'nikhil', { itemId: s.id, type: 'RCA', title: 'Plan', markdown: 'First plan.' });
    const pageId = work.get(wp, s.id)!.docId!;
    await notion.seed(pageId, [h2('HLD'), para('The high-level design text.'), h2('Decisions'), para('Alarms follow the local clock.')]);
    await docs.docWrite(wp, 'nikhil', { itemId: s.id, type: 'RCA', title: 'Plan', markdown: 'Second plan.' });
    const md = docs.blocksToMarkdown(notion.pageBlocks(pageId));
    assert.doesNotMatch(md, /First plan\./, 'the writer\'s own old text is replaced');
    assert.match(md, /Second plan\./);
    assert.match(md, /The high-level design text\./, 'the unowned HLD section survives');
    assert.match(md, /Alarms follow the local clock\./, 'the unowned Decisions section survives');
  } finally { tmp.cleanup(); }
});
