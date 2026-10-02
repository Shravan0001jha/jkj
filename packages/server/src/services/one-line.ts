import { OWNER_LINE_MAX, type OwnerLine } from '@jkj/shared';
import type { LogEntry } from '@jkj/shared';

/**
 * One line to the owner (HLD D16, owner rule of 28 Sep). Every message that reaches him in the
 * Workplace or on Telegram is a `summary` (one line, ≤ 120 chars: the outcome) with the rest
 * behind `details`. Employees are asked to write it that way (handbook); this is the guard for
 * when they don't: deterministic, no model, the first plain sentence trimmed at a word.
 */

export function oneLine(text: string, max = OWNER_LINE_MAX): OwnerLine {
  const original = text.trim();
  const lines = original
    .replace(/```[\s\S]*?```/g, ' ')                 // code blocks say nothing to the owner
    .split('\n')
    .map(plain)
    .filter(Boolean);
  const first = lines[0] ?? '';
  const sentence = firstSentence(first);
  const summary = trimAtWord(sentence, max);
  const isOneLine = lines.length <= 1 && summary === first;
  return isOneLine ? { summary } : { summary, details: original };
}

/** Assistant prose to the owner carries its one line; every other entry is unchanged. */
export function withOwnerLine(entry: LogEntry): LogEntry {
  if (entry.kind !== 'assistant' || !entry.text.trim()) return entry;
  const line = oneLine(entry.text);
  return { ...entry, summary: line.summary, ...(line.details ? { details: line.details } : {}) };
}

/** Markdown furniture off a line: headings, bullets, numbering, emphasis, inline code. */
function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(line: string): string {
  const m = /^(.+?[.!?])(?:\s+[A-Z(]|\s*$)/.exec(line);
  const s = m?.[1]?.trim() ?? line;
  // A very short first sentence ("Done." / "Yes.") says less than the line; keep the line.
  return s.length >= 16 ? s : line;
}

function trimAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}

/** How much of a chat message stays in `text` (HLD D22): a few short lines. */
export const SHORT_LINES = 4;
export const SHORT_CHARS = 400;

/**
 * Messages stay small (owner, 2 Oct): an agent's Room post, comment or Inbox reply keeps at most
 * four lines and 400 characters in `text`; anything longer is cut at a word with " …" and the whole
 * original goes to `details` (shown on "more"). Never applied to the owner's own words.
 */
export function short(text: string): { text: string; details?: string } {
  const whole = text.trim();
  const lines = whole.split('\n');
  if (lines.length <= SHORT_LINES && whole.length <= SHORT_CHARS) return { text: whole };
  let kept = lines.slice(0, SHORT_LINES).join('\n');
  if (kept.length > SHORT_CHARS) {
    const cut = kept.slice(0, SHORT_CHARS);
    const space = cut.lastIndexOf(' ');
    kept = space > SHORT_CHARS / 2 ? cut.slice(0, space) : cut;
  }
  return { text: `${kept.trimEnd()} …`, details: whole };
}
