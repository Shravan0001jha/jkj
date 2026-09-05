import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Renders assistant messages.
 *
 * Claude writes markdown, so a transcript that shows the raw source is
 * showing you the model's punctuation instead of its answer. Parsing is
 * `marked`, and everything it produces goes through DOMPurify before it
 * reaches the DOM — transcripts contain tool output, and tool output contains
 * whatever was on disk.
 */

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const parsed = marked.parse(text, { async: false });
    return DOMPurify.sanitize(parsed, {
      // No scripts, no styles, no embedded documents — this is prose.
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
    });
  }, [text]);

  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
