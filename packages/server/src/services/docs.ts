import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { NotionClient, NotionError, type Block, type NotionComment, type NotionPort, type RichText } from './notion.js';
import * as trail from './trail.js';
import * as work from './work.js';
import { chiefOfStaffId, nameOf, rawGet } from './v2-map.js';
import { log } from '../util/logger.js';

/**
 * Notion docs (HLD §3 flow 5, LLD W7). Big documents live in the Notion "Iris Docs" database, one
 * page per story, written and commented on through the doc_write / doc_read / doc_comment tools.
 * Agents never hold the key: every call goes through the server's NotionPort. The owner's Notion
 * comments are polled every 2 minutes and relayed to the doc's owner (relaySweep).
 */

export const NOT_SET_UP = 'Docs are not set up yet: the Workplace has no Notion key. Put the content on the item for now and tell Asha.';
export const DOCS_DB_TITLE = 'Iris Docs';
export const DOC_TYPES = ['RCA', 'Design', 'Research', 'QA report', 'Release report', 'Incident', 'Decision'] as const;
export type DocType = typeof DOC_TYPES[number];
export const DOC_STATUSES = ['Draft', 'In review', 'Final'] as const;
export type DocStatus = typeof DOC_STATUSES[number];
export const DOC_READ_MAX = 30_000;
/** Notion's limit on one rich-text item's content. */
export const TEXT_CHUNK = 2000;
/** Notion's limits on one append: 100 children, 1000 blocks counting nested ones. */
const APPEND_MAX = 100;
const APPEND_WEIGHT_MAX = 1000;
/** Block-comment listings per relay sweep (page comments are always read): ~1 request/s over 2 min. */
const BLOCK_BUDGET = 100;

/** Headings a new doc of each type gets when its markdown lacks them (LLD W7 §4). */
export const TEMPLATES: Record<DocType, string[]> = {
  'RCA': ['Symptom', 'Root cause', 'Why it escaped', 'Fix at the root', 'Regression guard'],
  'Design': ['Context', 'HLD', 'LLD', 'Test plan'],
  'Research': ['Question', 'Findings', 'Sources'],
  'QA report': ['Cases (with evidence)', 'Not checked', 'Residual risk'],
  'Release report': ['Scope', 'Results by platform', 'Issues'],
  'Incident': ['Timeline', 'Impact', 'Cause', 'Follow-ups'],
  'Decision': ['Question', 'Options', 'Recommendation'],
};

/* ---------- the port ---------- */

const injected = new WeakMap<Workplace, NotionPort | null>();

/** Tests (and the smoke script) hand in a port; `null` restores the default. */
export function setNotionPort(wp: Workplace, port: NotionPort | null): void {
  if (port) injected.set(wp, port); else injected.delete(wp);
}

/** The port, or null when docs are not set up (no key file). */
export function notionPort(wp: Workplace): NotionPort | null {
  const given = injected.get(wp);
  if (given) return given;
  const client = new NotionClient({ keyPath: wp.config.notionKeyPath });
  return client.available() ? client : null;
}

/* ---------- settings ---------- */

const getSetting = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const putSetting = (wp: Workplace, key: string, value: string): void =>
  void wp.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
const delSetting = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);

/* ---------- inline markdown <-> rich text ---------- */

interface Seg { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }

function parseInline(s: string, base: Omit<Seg, 'text'> = {}): Seg[] {
  const out: Seg[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ ...base, text: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if (s[i] === '`' && (m = rest.match(/^`([^`]+)`/))) {
      flush(); out.push({ ...base, text: m[1]!, code: true }); i += m[0].length; continue;
    }
    if (s[i] === '[' && (m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush(); out.push(...parseInline(m[1]!, { ...base, link: m[2]! })); i += m[0].length; continue;
    }
    if (rest.startsWith('***') && (m = rest.match(/^\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*/))) {
      flush(); out.push(...parseInline(m[1]!, { ...base, bold: true, italic: true })); i += m[0].length; continue;
    }
    if (rest.startsWith('**') && (m = rest.match(/^\*\*(\S(?:[\s\S]*?\S)?)\*\*/))) {
      flush(); out.push(...parseInline(m[1]!, { ...base, bold: true })); i += m[0].length; continue;
    }
    if (s[i] === '*' && (m = rest.match(/^\*([^*\s](?:[^*]*[^*\s])?)\*/))) {
      flush(); out.push(...parseInline(m[1]!, { ...base, italic: true })); i += m[0].length; continue;
    }
    buf += s[i]; i++;
  }
  flush();
  return out;
}

const sameStyle = (a: Omit<Seg, 'text'>, b: Omit<Seg, 'text'>) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && (a.link ?? '') === (b.link ?? '');

function segsToRich(segs: Seg[]): RichText[] {
  const merged: Seg[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && sameStyle(prev, s)) prev.text += s.text; else merged.push({ ...s });
  }
  const out: RichText[] = [];
  for (const s of merged) {
    for (let i = 0; i < s.text.length; i += TEXT_CHUNK) {
      const content = s.text.slice(i, i + TEXT_CHUNK);
      const annotations = { ...(s.bold ? { bold: true } : {}), ...(s.italic ? { italic: true } : {}), ...(s.code ? { code: true } : {}) };
      out.push({ type: 'text', text: { content, ...(s.link ? { link: { url: s.link } } : {}) }, ...(Object.keys(annotations).length ? { annotations } : {}) });
    }
  }
  return out;
}

/** Markdown inline text → Notion rich text, each item at most 2000 characters. */
export function richText(s: string): RichText[] { return segsToRich(parseInline(s)); }

/** Plain text, unformatted, chunked (code blocks). */
function plainRich(s: string): RichText[] { return segsToRich([{ text: s }]); }

const contentOf = (r: RichText): string => r.text?.content ?? r.plain_text ?? '';
const linkOf = (r: RichText): string | undefined => r.text?.link?.url ?? r.href ?? undefined;

export function plainText(rt: RichText[] | undefined): string { return (rt ?? []).map(contentOf).join(''); }

/** Notion rich text → markdown inline text (the inverse of richText). */
export function richToMarkdown(rt: RichText[] | undefined): string {
  const segs: Seg[] = (rt ?? []).map(r => {
    const a = r.annotations ?? {};
    const link = linkOf(r);
    return { text: contentOf(r), ...(a.bold ? { bold: true } : {}), ...(a.italic ? { italic: true } : {}), ...(a.code ? { code: true } : {}), ...(link ? { link } : {}) };
  });
  const merged: Seg[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && sameStyle(prev, s)) prev.text += s.text; else merged.push({ ...s });
  }
  return merged.map(s => {
    let t = s.text;
    if (!t) return '';
    if (s.code) t = `\`${t}\``;
    if (s.bold && s.italic) t = `***${t}***`; else if (s.bold) t = `**${t}**`; else if (s.italic) t = `*${t}*`;
    if (s.link) t = `[${t}](${s.link})`;
    return t;
  }).join('');
}

/* ---------- block markdown <-> blocks ---------- */

const LANG_ALIASES: Record<string, string> = {
  '': 'plain text', text: 'plain text', txt: 'plain text', plain: 'plain text', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  sh: 'shell', zsh: 'shell', console: 'shell', py: 'python', yml: 'yaml', md: 'markdown', kt: 'kotlin', rb: 'ruby', rs: 'rust', cpp: 'c++', 'c#': 'c#', cs: 'c#',
  objc: 'objective-c', 'objective-c': 'objective-c', golang: 'go', dockerfile: 'docker',
};
const NOTION_LANGS = new Set(['abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml', 'java/c/c++/c#']);

function notionLanguage(lang: string): string {
  const l = lang.trim().toLowerCase();
  const mapped = LANG_ALIASES[l] ?? l;
  return NOTION_LANGS.has(mapped) ? mapped : 'plain text';
}

const block = (type: string, payload: Record<string, unknown>): Block => ({ object: 'block', type, [type]: payload });

const FENCE = /^\s*```\s*([^`\s]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TODO = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const DIVIDER = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableStart = (lines: string[], i: number) => lines[i]!.trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-');
const startsBlock = (lines: string[], i: number) => {
  const l = lines[i]!;
  return !l.trim() || FENCE.test(l) || HEADING.test(l) || TODO.test(l) || BULLET.test(l) || NUMBERED.test(l) || QUOTE.test(l) || DIVIDER.test(l) || isTableStart(lines, i);
};

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Markdown → Notion blocks (LLD W7 §3). A table carries its rows under `table.children`. */
export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) { body.push(lines[i]!); i++; }
      i++; // the closing fence (or the end)
      out.push(block('code', { rich_text: plainRich(body.join('\n')), language: notionLanguage(m[1] ?? '') }));
      continue;
    }
    if ((m = line.match(HEADING))) {
      const level = Math.min(m[1]!.length, 3);
      out.push(block(`heading_${level}`, { rich_text: richText(m[2]!.trim()) }));
      i++; continue;
    }
    if (DIVIDER.test(line)) { out.push(block('divider', {})); i++; continue; }
    if ((m = line.match(TODO))) { out.push(block('to_do', { rich_text: richText(m[2]!), checked: m[1] !== ' ' })); i++; continue; }
    if ((m = line.match(BULLET))) { out.push(block('bulleted_list_item', { rich_text: richText(m[1]!) })); i++; continue; }
    if ((m = line.match(NUMBERED))) { out.push(block('numbered_list_item', { rich_text: richText(m[1]!) })); i++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (m = lines[i]!.match(QUOTE))) { body.push(m[1]!); i++; }
      out.push(block('quote', { rich_text: richText(body.join('\n')) }));
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const rows: string[][] = [header];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) { rows.push(splitRow(lines[i]!)); i++; }
      const width = header.length;
      out.push(block('table', {
        table_width: width, has_column_header: true, has_row_header: false,
        children: rows.map(r => block('table_row', { cells: Array.from({ length: width }, (_, c) => richText(r[c] ?? '')) })),
      }));
      continue;
    }
    const body: string[] = [line];
    i++;
    while (i < lines.length && !startsBlock(lines, i)) { body.push(lines[i]!); i++; }
    out.push(block('paragraph', { rich_text: richText(body.join('\n')) }));
  }
  return out;
}

const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

/** Notion blocks → markdown, the inverse of markdownToBlocks (doc_read). Children sit under `<type>.children`. */
export function blocksToMarkdown(blocks: Block[], indent = ''): string {
  const parts: { type: string; text: string }[] = [];
  let n = 0;
  for (const b of blocks) {
    const p = (b[b.type] ?? {}) as { rich_text?: RichText[]; children?: Block[]; checked?: boolean; language?: string; url?: string; title?: string; caption?: RichText[]; expression?: string; file?: { url: string }; external?: { url: string }; has_column_header?: boolean };
    n = b.type === 'numbered_list_item' ? n + 1 : 0;
    const rt = richToMarkdown(p.rich_text);
    const nested = p.children?.length && b.type !== 'table' ? `\n${blocksToMarkdown(p.children, `${indent}  `)}` : '';
    let text: string;
    switch (b.type) {
      case 'heading_1': case 'heading_2': case 'heading_3':
        text = `${'#'.repeat(Number(b.type.slice(-1)))} ${rt}`; break;
      case 'paragraph': if (!rt && !nested) continue; text = rt; break;
      case 'bulleted_list_item': text = `- ${rt}`; break;
      case 'numbered_list_item': text = `${n}. ${rt}`; break;
      case 'to_do': text = `- [${p.checked ? 'x' : ' '}] ${rt}`; break;
      case 'quote': case 'callout': text = rt.split('\n').map(l => `> ${l}`).join('\n'); break;
      case 'code': {
        const lang = p.language && p.language !== 'plain text' ? p.language : '';
        text = `\`\`\`${lang}\n${plainText(p.rich_text)}\n\`\`\``; break;
      }
      case 'divider': text = '---'; break;
      case 'table': {
        const rows = (p.children ?? []).map(r => ((r['table_row'] as { cells: RichText[][] } | undefined)?.cells ?? []).map(c => richToMarkdown(c).replace(/\|/g, '\\|')));
        if (!rows.length) continue;
        const width = Math.max(...rows.map(r => r.length));
        const line = (r: string[]) => `| ${Array.from({ length: width }, (_, c) => r[c] ?? '').join(' | ')} |`;
        text = [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
        break;
      }
      case 'toggle': text = rt; break;
      case 'equation': text = `$$${p.expression ?? ''}$$`; break;
      case 'image': case 'file': case 'pdf': case 'video': {
        const url = p.file?.url ?? p.external?.url ?? '';
        text = `![${plainText(p.caption) || b.type}](${url})`; break;
      }
      case 'bookmark': case 'embed': case 'link_preview': text = p.url ?? ''; break;
      case 'child_page': case 'child_database': text = `[${p.title ?? b.type}]`; break;
      default: text = rt || `[${b.type.replace(/_/g, ' ')} (not shown here; open the doc in Notion)]`;
    }
    parts.push({ type: b.type, text: indent ? text.split('\n').map(l => indent + l).join('\n') + nested : text + nested });
  }
  let md = '';
  parts.forEach((part, k) => {
    if (k > 0) md += LIST_TYPES.has(part.type) && parts[k - 1]!.type === part.type ? '\n' : indent ? '\n' : '\n\n';
    md += part.text;
  });
  return md;
}

/* ---------- templates ---------- */

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Insert the type's template headings the markdown lacks, each before the next one it has. */
export function withTemplate(md: string, type: DocType): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const headingAt = (h: string): number => {
    const key = norm(h);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i]!)) inFence = !inFence;
      if (inFence) continue;
      const m = lines[i]!.match(HEADING);
      if (m && norm(m[2]!).startsWith(key)) return i;
    }
    return -1;
  };
  const template = TEMPLATES[type];
  for (let k = 0; k < template.length; k++) {
    if (headingAt(template[k]!) >= 0) continue;
    const next = template.slice(k + 1).map(headingAt).find(i => i >= 0);
    if (next === undefined) lines.push('', `## ${template[k]}`);
    else lines.splice(next, 0, `## ${template[k]}`, '');
  }
  return lines.join('\n').replace(/^\n+/, '');
}

/* ---------- the database ---------- */

const verifiedDb = new WeakMap<Workplace, string>();

/** Find or create the "Iris Docs" database under the root page; its id is the setting notion:docs-db. */
export async function ensureDocsDb(wp: Workplace, port: NotionPort | null = notionPort(wp)): Promise<string> {
  if (!port) throw new Error(NOT_SET_UP);
  const known = verifiedDb.get(wp);
  if (known) return known;
  const remember = (id: string) => { putSetting(wp, 'notion:docs-db', id); verifiedDb.set(wp, id); return id; };
  const stored = getSetting(wp, 'notion:docs-db');
  if (stored) {
    try {
      await port.queryDatabase(stored, { filter: { property: 'Story id', rich_text: { equals: '__probe__' } } });
      return remember(stored);
    } catch (err) {
      log.warn('docs', `the stored Iris Docs database is not reachable (${err instanceof Error ? err.message : err}); looking under the root page`);
    }
  }
  const root = wp.config.notionRootPageId;
  const found = (await port.listChildren(root)).find(b => b.type === 'child_database' && !b.archived && (b['child_database'] as { title?: string } | undefined)?.title === DOCS_DB_TITLE);
  if (found?.id) return remember(found.id);
  const select = (names: readonly string[]) => ({ select: { options: names.map(name => ({ name })) } });
  const db = await port.createDatabase({
    parent: { type: 'page_id', page_id: root },
    title: [{ type: 'text', text: { content: DOCS_DB_TITLE } }],
    is_inline: false,
    properties: {
      'Name': { title: {} },
      'Type': select(DOC_TYPES),
      'Charter': { select: { options: [] } },
      'Owner': { rich_text: {} },
      'Status': select(DOC_STATUSES),
      'Story': { url: {} },
      'Story id': { rich_text: {} },
      'Date': { date: {} },
    },
  });
  log.info('docs', `created the ${DOCS_DB_TITLE} database under the root page`);
  return remember(db.id);
}

/* ---------- helpers ---------- */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isGone = (err: unknown) => (err instanceof NotionError && (err.status === 404 || /archived/i.test(err.message))) || /404|object_not_found|archived/i.test(errText(err));

function charterName(wp: Workplace, w: WorkItem): string | undefined {
  const id = w.charterId ?? wp.org.employees.find(e => e.id === w.employeeId)?.charterIds[0];
  if (!id) return undefined;
  const title = wp.org.charters.get(id)?.title ?? id;
  return title.replace(/,/g, ' ').slice(0, 100);
}

function storyUrl(wp: Workplace, itemId: string): string {
  return `${wp.config.github.linkBase.replace(/\/+$/, '')}/api/items/${itemId}`;
}

function properties(wp: Workplace, w: WorkItem, by: string, spec: { type: DocType; title: string; status?: DocStatus }, creating: boolean): Record<string, unknown> {
  const charter = charterName(wp, w);
  return {
    'Name': { title: plainRich(spec.title.trim() || w.title) },
    'Type': { select: { name: spec.type } },
    ...(charter ? { 'Charter': { select: { name: charter } } } : {}),
    'Owner': { rich_text: plainRich(nameOf(wp, by)) },
    ...(spec.status || creating ? { 'Status': { select: { name: spec.status ?? 'Draft' } } } : {}),
    'Story': { url: storyUrl(wp, w.id) },
    'Story id': { rich_text: plainRich(w.id) },
    'Date': { date: { start: new Date().toISOString().slice(0, 10) } },
  };
}

/** Append in groups the API accepts (≤100 children, ≤1000 blocks counting table rows); a table over 100 rows is filled after. */
async function appendAll(port: NotionPort, parentId: string, blocks: Block[]): Promise<void> {
  const later: { index: number; rows: Block[] }[] = [];
  const prepared = blocks.map((b, index) => {
    if (b.type !== 'table') return b;
    const t = b['table'] as { children: Block[] };
    if (t.children.length <= APPEND_MAX) return b;
    later.push({ index, rows: t.children.slice(APPEND_MAX) });
    return { ...b, table: { ...t, children: t.children.slice(0, APPEND_MAX) } };
  });
  const made: Block[] = [];
  let group: Block[] = [];
  let weight = 0;
  const send = async () => { if (group.length) { made.push(...await port.appendBlocks(parentId, group)); group = []; weight = 0; } };
  for (const b of prepared) {
    const w = 1 + (b.type === 'table' ? (b['table'] as { children: Block[] }).children.length : 0);
    if (group.length >= APPEND_MAX || weight + w > APPEND_WEIGHT_MAX) await send();
    group.push(b); weight += w;
  }
  await send();
  for (const { index, rows } of later) {
    const tableId = made[index]?.id;
    if (!tableId) throw new Error('Notion did not return the table it made; its remaining rows were not written.');
    for (let i = 0; i < rows.length; i += APPEND_MAX) await port.appendBlocks(tableId, rows.slice(i, i + APPEND_MAX));
  }
}

/** A page's blocks with their children attached under `<type>.children` (tables' rows, nested lists). */
async function readBlocks(port: NotionPort, id: string, depth = 0): Promise<Block[]> {
  const blocks = await port.listChildren(id);
  if (depth >= 3) return blocks;
  for (const b of blocks) {
    if (!b.has_children || !b.id || b.type === 'child_page' || b.type === 'child_database') continue;
    const p = (b[b.type] ?? {}) as Record<string, unknown>;
    b[b.type] = { ...p, children: await readBlocks(port, b.id, depth + 1) };
  }
  return blocks;
}

function blockPlain(b: Block): string {
  const p = (b[b.type] ?? {}) as { rich_text?: RichText[] };
  return plainText(p.rich_text);
}

/* ---------- who wrote a comment ---------- */

const botIds = new WeakMap<Workplace, string>();
const userTypes = new WeakMap<Workplace, Map<string, string>>();

async function isOwnerComment(wp: Workplace, port: NotionPort, c: NotionComment): Promise<boolean> {
  if (c.created_by.type) return c.created_by.type === 'person';
  let bot = botIds.get(wp);
  if (!bot) { bot = (await port.me()).id; botIds.set(wp, bot); }
  if (c.created_by.id === bot) return false;
  let types = userTypes.get(wp);
  if (!types) { types = new Map(); userTypes.set(wp, types); }
  let type = types.get(c.created_by.id);
  if (!type) { type = (await port.getUser(c.created_by.id)).type ?? 'unknown'; types.set(c.created_by.id, type); }
  return type === 'person';
}

/* ---------- the tools ---------- */

export interface DocWriteSpec { itemId: string; type: DocType; title: string; markdown: string; status?: DocStatus }

/**
 * doc_write: one doc per story. Updates the story's page (its properties, then its content replaced)
 * or creates it (with the type's template headings), links it on the item, records a `doc` activity.
 */
export async function docWrite(wp: Workplace, by: string, spec: DocWriteSpec): Promise<string> {
  const port = notionPort(wp);
  if (!port) return NOT_SET_UP;
  const w = rawGet(wp, spec.itemId);
  if (!w) return `Not written: no item ${spec.itemId}.`;
  if (!DOC_TYPES.includes(spec.type)) return `Not written: type must be one of ${DOC_TYPES.join(', ')}.`;
  if (!spec.markdown.trim()) return 'Not written: the markdown is empty.';
  try {
    const dbId = await ensureDocsDb(wp, port);
    let page: { id: string; url: string } | undefined;
    if (w.docId) {
      try { page = await port.updatePage(w.docId, { properties: properties(wp, w, by, spec, false) }); }
      catch (err) { if (!isGone(err)) throw err; log.warn('docs', `the doc of ${w.id} is gone from Notion; making a new one`); }
    }
    if (!page) {
      const existing = (await port.queryDatabase(dbId, { filter: { property: 'Story id', rich_text: { equals: w.id } } }))[0];
      if (existing) page = await port.updatePage(existing.id, { properties: properties(wp, w, by, spec, false) });
    }
    let created = false;
    if (!page) {
      page = await port.createPage({ parent: { database_id: dbId }, properties: properties(wp, w, by, spec, true) });
      created = true;
    }
    // Link it now: a failure while writing the content leaves the story pointing at its one page.
    const linked: WorkItem = { ...(rawGet(wp, w.id) ?? w), docId: page.id, docUrl: page.url };
    work.saveQuiet(wp, linked);
    putSetting(wp, `notion:owner:${page.id}`, by);
    if (!created) await clearPage(wp, port, page.id);
    const blocks = markdownToBlocks(created ? withTemplate(spec.markdown, spec.type) : spec.markdown);
    await appendAll(port, page.id, blocks);
    trail.record(wp, { itemId: w.id, by, kind: 'doc', text: `${created ? 'Wrote' : 'Rewrote'} the ${spec.type} doc "${spec.title.trim() || w.title}"`, link: page.url });
    return `${created ? 'Doc created' : 'Doc updated'}: ${page.url} (linked on ${w.id}).`;
  } catch (err) {
    log.warn('docs', `doc_write on ${w.id}: ${errText(err)}`);
    return `Not written: ${errText(err)}`;
  }
}

/**
 * Remove a page's content before a rewrite. Owner comments on the blocks about to go are kept
 * first (notion:pending:<docId>), so the next relay sweep still delivers them.
 */
async function clearPage(wp: Workplace, port: NotionPort, pageId: string): Promise<void> {
  const old = await port.listChildren(pageId);
  const seen = seenSet(wp, pageId);
  const pending = pendingOf(wp, pageId);
  for (const b of old) {
    if (!b.id) continue;
    for (const c of await port.listComments(b.id)) {
      if (seen.has(c.id) || pending.some(p => p.comment.id === c.id)) continue;
      if (await isOwnerComment(wp, port, c)) pending.push({ comment: c, on: blockPlain(b) });
    }
  }
  if (pending.length) putSetting(wp, `notion:pending:${pageId}`, JSON.stringify(pending));
  for (const b of old) if (b.id) await port.deleteBlock(b.id);
}

/** doc_read: the story's doc as markdown, at most 30k characters (and it says when it was cut). */
export async function docRead(wp: Workplace, itemId: string): Promise<string> {
  const port = notionPort(wp);
  if (!port) return NOT_SET_UP;
  const w = rawGet(wp, itemId);
  if (!w) return `No item ${itemId}.`;
  if (!w.docId) return `No doc on ${itemId} yet; write it with doc_write.`;
  try {
    const md = blocksToMarkdown(await readBlocks(port, w.docId));
    const head = `Doc of ${w.id}: ${w.docUrl ?? ''}\n\n`;
    if (md.length <= DOC_READ_MAX) return head + md;
    return `${head}${md.slice(0, DOC_READ_MAX)}\n\n[cut at ${DOC_READ_MAX} characters of ${md.length}; read the rest in Notion: ${w.docUrl ?? w.docId}]`;
  } catch (err) {
    return `Not read: ${errText(err)}`;
  }
}

/** doc_comment: a comment under "<Name> (<role>)", on the first block containing `quote`, or on the page. */
export async function docComment(wp: Workplace, by: string, spec: { itemId: string; text: string; quote?: string }): Promise<string> {
  const port = notionPort(wp);
  if (!port) return NOT_SET_UP;
  const w = rawGet(wp, spec.itemId);
  if (!w) return `Not commented: no item ${spec.itemId}.`;
  if (!w.docId) return `Not commented: ${spec.itemId} has no doc yet; write it with doc_write.`;
  if (!spec.text.trim()) return 'Not commented: the comment is empty.';
  const emp = wp.org.employees.find(e => e.id === by);
  const name = emp ? `${emp.name} (${emp.roleId})` : nameOf(wp, by);
  try {
    let parent: { page_id: string } | { block_id: string } = { page_id: w.docId };
    let note = '';
    const quote = spec.quote?.trim();
    if (quote) {
      const blocks = await port.listChildren(w.docId);
      const hit = blocks.find(b => blockPlain(b).includes(quote)) ?? blocks.find(b => blockPlain(b).toLowerCase().includes(quote.toLowerCase()));
      if (hit?.id) parent = { block_id: hit.id };
      else note = ' The quote was not found in the doc, so the comment is on the page.';
    }
    await port.createComment({ parent, rich_text: richText(spec.text.trim()), display_name: { type: 'custom', custom: { name } } });
    return `Commented on the doc of ${w.id} as ${name}.${note}`;
  } catch (err) {
    return `Not commented: ${errText(err)}`;
  }
}

/* ---------- the owner's comments, relayed (LLD W7 §6) ---------- */

export type Deliver = (employeeId: string, text: string, about: { itemId: string; title: string }) => void;

interface Pending { comment: NotionComment; on?: string }

const seenSet = (wp: Workplace, docId: string): Set<string> => {
  try { return new Set(JSON.parse(getSetting(wp, `notion:seen:${docId}`) ?? '[]') as string[]); } catch { return new Set(); }
};
const pendingOf = (wp: Workplace, docId: string): Pending[] => {
  try { return JSON.parse(getSetting(wp, `notion:pending:${docId}`) ?? '[]') as Pending[]; } catch { return []; }
};

const sweeping = new WeakSet<Workplace>();
const blockCursor = new WeakMap<Workplace, Map<string, number>>();

/** Every doc linked on an open item. */
function openDocs(wp: Workplace): WorkItem[] {
  const rows = wp.db.prepare(`select json from work where json like '%"docId":%'`).all() as { json: string }[];
  return rows.map(r => JSON.parse(r.json) as WorkItem).filter(w => w.docId && w.status !== 'done' && !w.mergedInto);
}

/**
 * One relay sweep: each open doc's page comments, plus its blocks' comments within a per-sweep
 * budget (round-robin, so a long doc is covered over a few sweeps). Each new owner comment is
 * recorded on the item as the owner's and delivered to the doc's owner, once (notion:seen:<docId>).
 * A no-op without the key. Returns how many comments were relayed.
 */
export async function relaySweep(wp: Workplace, opts: { deliver: Deliver; blockBudget?: number }): Promise<number> {
  const port = notionPort(wp);
  if (!port || sweeping.has(wp)) return 0;
  sweeping.add(wp);
  let relayed = 0;
  try {
    // Kept before a rewrite deleted their blocks; delivered whether or not the item is still open.
    for (const r of wp.db.prepare("select key from settings where key like 'notion:pending:%'").all() as { key: string }[]) {
      const docId = r.key.slice('notion:pending:'.length);
      const w = openDocs(wp).find(x => x.docId === docId) ?? findByDoc(wp, docId);
      const seen = seenSet(wp, docId);
      for (const p of pendingOf(wp, docId)) {
        if (!w || seen.has(p.comment.id)) continue;
        relay(wp, w, docId, p.comment, p.on, opts.deliver, seen);
        relayed++;
      }
      delSetting(wp, r.key);
    }
    const docs = openDocs(wp);
    const budget = opts.blockBudget ?? BLOCK_BUDGET;
    const perDoc = docs.length ? Math.max(10, Math.floor(budget / docs.length)) : 0;
    let cursors = blockCursor.get(wp);
    if (!cursors) { cursors = new Map(); blockCursor.set(wp, cursors); }
    for (const w of docs) {
      const docId = w.docId!;
      try {
        const seen = seenSet(wp, docId);
        for (const c of await port.listComments(docId)) {
          if (seen.has(c.id) || !(await isOwnerComment(wp, port, c))) continue;
          relay(wp, w, docId, c, undefined, opts.deliver, seen);
          relayed++;
        }
        const blocks = (await port.listChildren(docId)).filter(b => b.id);
        if (!blocks.length) continue;
        let at = (cursors.get(docId) ?? 0) % blocks.length;
        for (let n = 0; n < Math.min(perDoc, blocks.length); n++) {
          const b = blocks[at]!;
          for (const c of await port.listComments(b.id!)) {
            if (seen.has(c.id) || !(await isOwnerComment(wp, port, c))) continue;
            relay(wp, w, docId, c, blockPlain(b), opts.deliver, seen);
            relayed++;
          }
          at = (at + 1) % blocks.length;
        }
        cursors.set(docId, at);
      } catch (err) {
        log.warn('docs', `comment relay on ${w.id}: ${errText(err)}`);
      }
    }
  } finally {
    sweeping.delete(wp);
  }
  return relayed;
}

function findByDoc(wp: Workplace, docId: string): WorkItem | undefined {
  const rows = wp.db.prepare(`select json from work where json like ?`).all(`%"docId":"${docId}"%`) as { json: string }[];
  return rows.map(r => JSON.parse(r.json) as WorkItem).find(w => w.docId === docId);
}

function relay(wp: Workplace, w: WorkItem, docId: string, c: NotionComment, on: string | undefined, deliver: Deliver, seen: Set<string>): void {
  const text = plainText(c.rich_text).trim();
  const snippet = on ? (on.length > 200 ? `${on.slice(0, 200)}…` : on) : undefined;
  // Seen first: the item comment is the durable record, and a failed delivery must not repeat it.
  seen.add(c.id);
  putSetting(wp, `notion:seen:${docId}`, JSON.stringify([...seen]));
  try {
    trail.comment(wp, w.id, { by: 'owner', text: `On the doc${snippet ? ` (at "${snippet}")` : ''}: ${text || '(an empty comment)'}` });
  } catch (err) { log.warn('docs', `owner comment on ${w.id}: ${errText(err)}`); }
  const to = getSetting(wp, `notion:owner:${docId}`) ?? w.employeeId ?? chiefOfStaffId(wp);
  if (!to) return;
  const prompt = [
    `The owner commented on your Notion doc for "${w.title}" (${w.id})${snippet ? `, on the passage "${snippet}"` : ''}:`,
    '',
    `"${text}"`,
    '',
    `Doc: ${w.docUrl ?? docId}`,
    `Answer him in the doc with doc_comment (itemId ${w.id}${snippet ? ', quote the passage' : ''}); change the doc with doc_write (read it first with doc_read) if he asks for a change.`,
  ].join('\n');
  try { deliver(to, prompt, { itemId: w.id, title: w.title }); }
  catch (err) { log.warn('docs', `relay to ${to} on ${w.id}: ${errText(err)}`); }
}
