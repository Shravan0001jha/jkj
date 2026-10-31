/** LLD-dashboard §2: a story's status segments, rebuilt from the Workplace's own status rows. */

export interface Transition { itemId: string; at: number; from: string | null; to: string }
export interface Segment { status: string; from: number; to: number }

const END = new Set(['done', 'rejected', 'cancelled']);

export function storyTimeline(transitions: Transition[], now: number): Segment[] {
  const rows = [...transitions].sort((a, b) => a.at - b.at);
  const out: Segment[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (END.has(r.to)) break;
    const next = rows[i + 1];
    out.push({ status: r.to, from: r.at, to: next ? next.at : now });
  }
  return out;
}
