import { existsSync, readFileSync } from 'node:fs';

/**
 * A thin Notion client (LLD W7 §1): `fetch`, Notion-Version 2022-06-28, the integration key read
 * from its file on every call (a rotated key needs no restart) and never logged or put in an error.
 * One retry on 429, after the Retry-After the API asks for. List calls follow `next_cursor` to the
 * end, so callers always get every result.
 *
 * `NotionPort` is what docs.ts depends on; tests hand it a fake (test/fakes/fake-notion.ts).
 */

export const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';
/** The longest Retry-After we honour before the one retry (the API asks for seconds). */
const MAX_RETRY_WAIT_MS = 30_000;

export interface RichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: Partial<Record<'bold' | 'italic' | 'strikethrough' | 'underline' | 'code', boolean>> & { color?: string };
  plain_text?: string;
  href?: string | null;
}

/** A block as sent or as listed; the payload sits under the key named by `type`. */
export interface Block {
  object?: 'block';
  id?: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  [payload: string]: unknown;
}

export interface NotionPage { id: string; url: string; archived?: boolean; properties?: Record<string, unknown> }

export interface NotionUser { id: string; type?: 'person' | 'bot'; name?: string | null }

export interface NotionComment {
  id: string;
  discussion_id?: string;
  parent: { type: 'page_id'; page_id: string } | { type: 'block_id'; block_id: string };
  /** The API returns a partial user ({object, id}); `type` is present only on some responses. */
  created_by: { object?: 'user'; id: string; type?: 'person' | 'bot' };
  created_time: string;
  rich_text: RichText[];
  display_name?: { type: string; resolved_name?: string; custom?: { name: string } };
}

export interface CreateCommentBody {
  parent?: { page_id: string } | { block_id: string };
  discussion_id?: string;
  rich_text: RichText[];
  display_name?: { type: 'custom'; custom: { name: string } } | { type: 'integration' } | { type: 'user' };
}

export interface NotionPort {
  createDatabase(body: Record<string, unknown>): Promise<{ id: string; url?: string }>;
  /** Every page matching (pages through the results). */
  queryDatabase(databaseId: string, body?: Record<string, unknown>): Promise<NotionPage[]>;
  createPage(body: Record<string, unknown>): Promise<NotionPage>;
  updatePage(pageId: string, body: Record<string, unknown>): Promise<NotionPage>;
  /** At most 100 children per call (the API's limit); returns the blocks created, in order. */
  appendBlocks(blockId: string, children: Block[]): Promise<Block[]>;
  /** Every child of a block or page (pages through the results). */
  listChildren(blockId: string): Promise<Block[]>;
  deleteBlock(blockId: string): Promise<void>;
  createComment(body: CreateCommentBody): Promise<NotionComment>;
  /** Every comment on a page or block, open discussions only (pages through the results). */
  listComments(blockId: string): Promise<NotionComment[]>;
  /** The integration's own bot user. */
  me(): Promise<NotionUser>;
  getUser(userId: string): Promise<NotionUser>;
}

export class NotionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Notion ${status}${code ? ` ${code}` : ''}: ${message}`);
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface NotionClientOptions {
  keyPath: string;
  fetch?: FetchLike;
  /** Waits before the 429 retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export class NotionClient implements NotionPort {
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: NotionClientOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  /** True when the key file exists (the docs feature is set up). */
  available(): boolean { return existsSync(this.opts.keyPath); }

  private key(): string {
    let key: string;
    try { key = readFileSync(this.opts.keyPath, 'utf8').trim(); } catch { throw new NotionError(0, 'no_key', 'the integration key file is missing'); }
    if (!key) throw new NotionError(0, 'no_key', 'the integration key file is empty');
    return key;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const key = this.key();
    const init = {
      method,
      headers: { 'Authorization': `Bearer ${key}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let res = await this.fetchFn(`${API}${path}`, init);
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      await this.sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000, MAX_RETRY_WAIT_MS));
      res = await this.fetchFn(`${API}${path}`, init);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* a non-JSON error page */ }
    if (res.status < 200 || res.status >= 300) {
      const message = typeof json['message'] === 'string' ? json['message'] as string : text.slice(0, 200);
      // Never echo the key, even if an error page did.
      throw new NotionError(res.status, typeof json['code'] === 'string' ? json['code'] as string : '', message.split(key).join('[key]'));
    }
    return json as T;
  }

  private async paged<T>(fetchPage: (cursor?: string) => Promise<{ results: T[]; has_more?: boolean; next_cursor?: string | null }>): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await fetchPage(cursor);
      all.push(...page.results);
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return all;
  }

  createDatabase(body: Record<string, unknown>) { return this.call<{ id: string; url?: string }>('POST', '/databases', body); }

  queryDatabase(databaseId: string, body: Record<string, unknown> = {}) {
    return this.paged<NotionPage>(cursor => this.call('POST', `/databases/${databaseId}/query`, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
  }

  createPage(body: Record<string, unknown>) { return this.call<NotionPage>('POST', '/pages', body); }

  updatePage(pageId: string, body: Record<string, unknown>) { return this.call<NotionPage>('PATCH', `/pages/${pageId}`, body); }

  async appendBlocks(blockId: string, children: Block[]): Promise<Block[]> {
    if (children.length > 100) throw new NotionError(400, 'validation_error', `at most 100 children per append, got ${children.length}`);
    const r = await this.call<{ results: Block[] }>('PATCH', `/blocks/${blockId}/children`, { children });
    return r.results;
  }

  listChildren(blockId: string) {
    return this.paged<Block>(cursor => this.call('GET', `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`));
  }

  async deleteBlock(blockId: string): Promise<void> { await this.call('DELETE', `/blocks/${blockId}`); }

  createComment(body: CreateCommentBody) { return this.call<NotionComment>('POST', '/comments', body); }

  listComments(blockId: string) {
    return this.paged<NotionComment>(cursor => this.call('GET', `/comments?block_id=${encodeURIComponent(blockId)}&page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`));
  }

  me() { return this.call<NotionUser>('GET', '/users/me'); }

  getUser(userId: string) { return this.call<NotionUser>('GET', `/users/${encodeURIComponent(userId)}`); }
}
