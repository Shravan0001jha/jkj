import type { Block, CreateCommentBody, NotionComment, NotionPage, NotionPort, NotionUser } from '../../src/services/notion.js';

/**
 * Notion, faked in memory with the real API's shapes and limits: a page's children are listed
 * without nested table rows (has_children instead), appends refuse more than 100 children,
 * comments carry a partial `created_by` ({object, id}) the way the API returns them, and the
 * bot is whoever `me()` says. Every call is recorded.
 */

export const BOT_ID = 'bot-0000';
export const OWNER_ID = 'person-owner';

interface Stored { block: Block; parentId: string; children: string[] }

export class FakeNotion implements NotionPort {
  readonly calls: { op: string; args: unknown[] }[] = [];
  readonly databases = new Map<string, { parentPageId: string; body: Record<string, unknown> }>();
  readonly pages = new Map<string, NotionPage & { parentDb: string; children: string[] }>();
  readonly blocks = new Map<string, Stored>();
  readonly comments: NotionComment[] = [];
  /** Children of the root page that are not ours (child_database blocks the API lists). */
  readonly rootChildren = new Map<string, Block[]>();
  private seq = 0;

  private id(prefix: string): string { return `${prefix}-${String(++this.seq).padStart(4, '0')}`; }
  private rec(op: string, ...args: unknown[]): void { this.calls.push({ op, args: JSON.parse(JSON.stringify(args)) as unknown[] }); }
  count(op: string): number { return this.calls.filter(c => c.op === op).length; }
  last(op: string): unknown[] | undefined { return [...this.calls].reverse().find(c => c.op === op)?.args; }

  async createDatabase(body: Record<string, unknown>) {
    this.rec('createDatabase', body);
    const id = this.id('db');
    const parent = (body['parent'] as { page_id: string }).page_id;
    this.databases.set(id, { parentPageId: parent, body });
    const title = ((body['title'] as { text: { content: string } }[])[0]?.text.content) ?? '';
    const list = this.rootChildren.get(parent) ?? [];
    list.push({ object: 'block', id, type: 'child_database', child_database: { title } });
    this.rootChildren.set(parent, list);
    return { id, url: `https://www.notion.so/${id}` };
  }

  async queryDatabase(databaseId: string, body: Record<string, unknown> = {}) {
    this.rec('queryDatabase', databaseId, body);
    if (!this.databases.has(databaseId)) throw Object.assign(new Error('Notion 404 object_not_found'), { status: 404 });
    const filter = body['filter'] as { property: string; rich_text?: { equals: string } } | undefined;
    return [...this.pages.values()].filter(p => p.parentDb === databaseId && !p.archived).filter(p => {
      if (!filter?.rich_text) return true;
      const prop = p.properties?.[filter.property] as { rich_text: { text: { content: string } }[] } | undefined;
      return prop?.rich_text.map(r => r.text.content).join('') === filter.rich_text.equals;
    });
  }

  async createPage(body: Record<string, unknown>) {
    this.rec('createPage', body);
    const db = (body['parent'] as { database_id: string }).database_id;
    if (!this.databases.has(db)) throw new Error('Notion 404 object_not_found: database');
    const id = this.id('page');
    const page = { id, url: `https://www.notion.so/Doc-${id}`, parentDb: db, properties: body['properties'] as Record<string, unknown>, children: [] as string[] };
    this.pages.set(id, page);
    if (Array.isArray(body['children'])) await this.appendBlocks(id, body['children'] as Block[]);
    return { id: page.id, url: page.url, properties: page.properties };
  }

  async updatePage(pageId: string, body: Record<string, unknown>) {
    this.rec('updatePage', pageId, body);
    const page = this.pages.get(pageId);
    if (!page) throw new Error('Notion 404 object_not_found: page');
    if (body['properties']) page.properties = { ...page.properties, ...(body['properties'] as Record<string, unknown>) };
    if (body['archived'] !== undefined) page.archived = body['archived'] as boolean;
    return { id: page.id, url: page.url, properties: page.properties };
  }

  private childList(parentId: string): string[] {
    const page = this.pages.get(parentId);
    if (page) return page.children;
    const b = this.blocks.get(parentId);
    if (b) return b.children;
    throw new Error(`Notion 404 object_not_found: ${parentId}`);
  }

  async appendBlocks(blockId: string, children: Block[]): Promise<Block[]> {
    this.rec('appendBlocks', blockId, children.length);
    if (children.length > 100) throw new Error(`Notion 400 validation_error: body.children.length should be ≤ 100, instead was ${children.length}`);
    const list = this.childList(blockId);
    const made: Block[] = [];
    for (const child of children) {
      const id = this.id('blk');
      const copy = JSON.parse(JSON.stringify(child)) as Block;
      let rows: Block[] = [];
      if (copy.type === 'table') {
        const t = copy['table'] as { children?: Block[] };
        rows = t.children ?? [];
        delete t.children;
      }
      const stored: Stored = { block: { object: 'block', id, ...copy, has_children: rows.length > 0 }, parentId: blockId, children: [] };
      this.blocks.set(id, stored);
      list.push(id);
      if (rows.length) await this.appendBlocks(id, rows);
      made.push(stored.block);
    }
    return made;
  }

  async listChildren(blockId: string): Promise<Block[]> {
    this.rec('listChildren', blockId);
    // A page outside the database (the root page): its child databases.
    if (!this.pages.has(blockId) && !this.blocks.has(blockId)) return (this.rootChildren.get(blockId) ?? []).map(b => ({ ...b }));
    return this.childList(blockId).map(id => {
      const s = this.blocks.get(id)!;
      return { ...JSON.parse(JSON.stringify(s.block)) as Block, has_children: s.children.length > 0 };
    });
  }

  async deleteBlock(blockId: string): Promise<void> {
    this.rec('deleteBlock', blockId);
    const s = this.blocks.get(blockId);
    if (!s) throw new Error(`Notion 404 object_not_found: ${blockId}`);
    const list = this.childList(s.parentId);
    list.splice(list.indexOf(blockId), 1);
    this.blocks.delete(blockId);
  }

  async createComment(body: CreateCommentBody): Promise<NotionComment> {
    this.rec('createComment', body);
    const parent = body.parent && 'block_id' in body.parent
      ? { type: 'block_id' as const, block_id: body.parent.block_id }
      : { type: 'page_id' as const, page_id: (body.parent as { page_id: string }).page_id };
    const c: NotionComment = {
      id: this.id('cmt'), discussion_id: this.id('disc'), parent,
      created_by: { object: 'user', id: BOT_ID }, created_time: new Date().toISOString(), rich_text: body.rich_text,
      ...(body.display_name && body.display_name.type === 'custom' ? { display_name: { type: 'custom', resolved_name: body.display_name.custom.name } } : {}),
    };
    this.comments.push(c);
    return c;
  }

  /** The owner commenting in Notion (on the page, or on one of its blocks). */
  ownerComments(on: string, text: string, opts: { withType?: boolean } = {}): NotionComment {
    const parent = this.pages.has(on) ? { type: 'page_id' as const, page_id: on } : { type: 'block_id' as const, block_id: on };
    const c: NotionComment = {
      id: this.id('cmt'), discussion_id: this.id('disc'), parent,
      created_by: { object: 'user', id: OWNER_ID, ...(opts.withType ? { type: 'person' as const } : {}) },
      created_time: new Date().toISOString(), rich_text: [{ type: 'text', text: { content: text }, plain_text: text }],
    };
    this.comments.push(c);
    return c;
  }

  async listComments(blockId: string): Promise<NotionComment[]> {
    this.rec('listComments', blockId);
    return this.comments.filter(c => (c.parent.type === 'page_id' ? c.parent.page_id : c.parent.block_id) === blockId);
  }

  async me(): Promise<NotionUser> { this.rec('me'); return { id: BOT_ID, type: 'bot', name: 'Iris Workplace' }; }

  async getUser(userId: string): Promise<NotionUser> {
    this.rec('getUser', userId);
    return userId === BOT_ID ? { id: BOT_ID, type: 'bot' } : { id: userId, type: 'person', name: 'Shravan' };
  }

  /** The page's top-level blocks, as listed. */
  pageBlocks(pageId: string): Block[] {
    return this.pages.get(pageId)!.children.map(id => this.blocks.get(id)!.block);
  }
}
