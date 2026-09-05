import type { ReactNode } from 'react';

/**
 * Renders the two bits of markup the activity feed actually uses: **bold**
 * and `code`. A markdown library for this would be 40 kB for two rules.
 */
export function Markdownish({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const token = match[0];
    parts.push(
      token.startsWith('**')
        ? <b key={index}>{token.slice(2, -2)}</b>
        : <code key={index}>{token.slice(1, -1)}</code>,
    );
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return <>{parts}</>;
}
