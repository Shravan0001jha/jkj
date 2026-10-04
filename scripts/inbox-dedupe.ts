/**
 * One-off: withdraw "Blocked on you" questions that duplicate an open decision (docs/LLD-app-fixes.md
 * §10). Dry run by default; `--apply` writes. Stop the Workplace first or expect the apps to show the
 * change only after a refresh (no socket event is sent from here).
 *
 *   node --import tsx scripts/inbox-dedupe.ts [~/iris-workplace/workplace.db] [--apply]
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem } from '@jkj/shared';
import { duplicateAsks } from '../packages/server/src/services/inbox.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const path = args.find(a => !a.startsWith('--')) ?? join(homedir(), 'iris-workplace', 'workplace.db');
const db = new DatabaseSync(path, { readOnly: !apply });
const items = (db.prepare('select json from inbox').all() as { json: string }[]).map(r => JSON.parse(r.json) as InboxItem);
const pairs = duplicateAsks(items);
const at = new Date().toISOString();
for (const p of pairs) {
  const drop = items.find(i => i.id === p.drop)!;
  const keep = items.find(i => i.id === p.keep)!;
  console.log(`${apply ? 'expire' : 'would expire'} ${drop.id} "${drop.title.slice(0, 60)}" — duplicate of ${keep.id} "${keep.title.slice(0, 60)}"`);
  if (!apply) continue;
  const expired = { ...drop, state: 'expired', answer: { optionId: 'expired', note: `Duplicate of ${keep.id}: one ask per item.`, at, via: 'workplace' } };
  db.prepare("update inbox set state = 'expired', json = ? where id = ? and state = 'open'").run(JSON.stringify(expired), drop.id);
  if (p.itemId && typeof keep.context['itemId'] !== 'string') {
    db.prepare('update inbox set json = ? where id = ?').run(JSON.stringify({ ...keep, context: { ...keep.context, itemId: p.itemId } }), keep.id);
  }
}
console.log(`${pairs.length} duplicate(s)${apply ? ' withdrawn' : '; run with --apply to withdraw them'}.`);
db.close();
