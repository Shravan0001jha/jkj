import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The operational store: work items, inbox, events, sessions, spend.
 *
 * SQLite through node:sqlite (built into Node 22+), one file beside the org
 * data. The org itself is files (docs/HLD-workplace.md D2); this holds what
 * changes many times a minute and is queried by shape.
 */

export type Db = DatabaseSync;

const SCHEMA = `
create table if not exists work (
  id text primary key,
  kind text not null,
  state text not null,
  charter_id text,
  employee_id text,
  feature_id text,
  session_id text,
  created_at text not null,
  updated_at text not null,
  json text not null
);
create index if not exists work_kind_state on work(kind, state);
create index if not exists work_feature on work(feature_id);

create table if not exists inbox (
  id text primary key,
  kind text not null,
  state text not null,
  raised_by text not null,
  created_at text not null,
  json text not null
);
create index if not exists inbox_state on inbox(state);

create table if not exists events (
  seq integer primary key autoincrement,
  at text not null,
  kind text not null,
  subject text,
  json text not null
);

create table if not exists sessions (
  id text primary key,
  employee_id text not null,
  assignment_id text,
  sdk_session_id text,
  started_at text not null,
  ended_at text,
  status text not null,
  context_tokens integer default 0,
  json text not null
);
create index if not exists sessions_employee on sessions(employee_id);

create table if not exists spend (
  seq integer primary key autoincrement,
  at text not null,
  day text not null,
  employee_id text not null,
  session_id text not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read integer not null,
  cache_write integer not null,
  usd real not null,
  inr real not null
);
create index if not exists spend_day on spend(day, employee_id);

create table if not exists usage (
  seq integer primary key autoincrement,
  at text not null,
  day text not null,
  employee_id text not null,
  session_id text not null,
  model text not null,
  turns integer not null default 1,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read integer not null,
  cache_write integer not null,
  equivalent_inr real not null,
  tag text
);
create index if not exists usage_day on usage(day, employee_id);

create table if not exists threads (
  id text primary key,
  title text not null,
  charter_ids text not null,
  created_by text not null,
  created_at text not null,
  state text not null,
  last_at text not null,
  json text not null
);
create table if not exists messages (
  id text primary key,
  thread_id text not null,
  at text not null,
  by text not null,
  text text not null,
  mentions text not null,
  json text not null
);
create index if not exists messages_thread on messages(thread_id, at);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists releases (
  id text primary key,
  shippable text not null,
  version text not null,
  state text not null,
  created_at text not null,
  json text not null
);

create table if not exists proposals (
  id text primary key,
  kind text not null,
  state text not null,
  created_at text not null,
  json text not null
);

create table if not exists coo_items (
  id text primary key,
  kind text not null,
  state text not null,
  created_at text not null,
  json text not null
);
create table if not exists areas (
  id text primary key,
  title text not null,
  state text not null,
  rank real not null,
  created_at text not null,
  json text not null
);
create table if not exists comments (
  id text primary key,
  item_id text not null,
  at text not null,
  by text not null,
  json text not null
);
create index if not exists comments_item on comments(item_id, at);
create table if not exists activity (
  seq integer primary key autoincrement,
  id text not null,
  at text not null,
  item_id text,
  by text not null,
  kind text not null,
  json text not null
);
create index if not exists activity_item on activity(item_id, seq);
create table if not exists updates (
  seq integer primary key autoincrement,
  id text not null,
  at text not null,
  kind text not null,
  item_id text,
  json text not null
);
create table if not exists inbox_messages (
  id text primary key,
  inbox_id text not null,
  at text not null,
  by text not null,
  json text not null
);
create index if not exists inbox_messages_item on inbox_messages(inbox_id, at);
-- One row per owner reply in an Inbox thread: its delivery to whoever must answer it (LLD §19.14).
create table if not exists inbox_deliveries (
  message_id text primary key,
  inbox_id text not null,
  target text not null,
  at text not null,
  acked_at text,
  json text not null
);
create index if not exists inbox_deliveries_open on inbox_deliveries(acked_at, at);
create table if not exists release_posts (
  id text primary key,
  at text not null,
  version text not null,
  json text not null
);

create table if not exists coo_messages (
  id text primary key,
  at text not null,
  from_who text not null,
  json text not null
);
`;

export function openStore(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal');
  db.exec(SCHEMA);
  // Additive migrations: a column that an older database lacks.
  for (const col of ['tag text', 'source text', 'basis text', 'what text', 'detail text']) {
    try { db.exec(`alter table spend add column ${col}`); } catch { /* already there */ }
  }
  // Workplace v2 (LLD §19.1): the item tree lives in `work`; these columns index what its JSON holds.
  for (const col of ['level text', 'status text', 'parent_id text', 'area_id text', 'rank real', 'reviewer_id text']) {
    try { db.exec(`alter table work add column ${col}`); } catch { /* already there */ }
  }
  try { db.exec('alter table threads add column room_id text'); } catch { /* already there */ }
  db.exec('create index if not exists work_parent on work(parent_id)');
  db.exec('create index if not exists work_status on work(status)');
  return db;
}

/** A tiny row helper: every table keeps its full object as JSON in `json`. */
export function rowJson<T>(row: unknown): T | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const json = (row as { json?: unknown }).json;
  return typeof json === 'string' ? (JSON.parse(json) as T) : undefined;
}

export function rowsJson<T>(rows: unknown[]): T[] {
  return rows.map(r => rowJson<T>(r)).filter((x): x is T => x !== undefined);
}

export const now = (): string => new Date().toISOString();

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
