import { useLayoutEffect, useRef } from 'react';

/**
 * A textarea that grows to fit what it holds.
 *
 * Context documents are read as documents, not scrolled in a small box — a
 * clipped last line reads as a rendering fault, not as "there is more".
 */
export function GrowTextarea({
  value, onChange, minHeight = 170, maxHeight = 420, ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  minHeight?: number;
  /** Past this it scrolls: a page-tall textarea is worse than a short one. */
  maxHeight?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.style.height = 'auto';
    // scrollHeight measures the content box, but the element is sized with
    // border-box, so the border has to be added back or the last line is
    // clipped by exactly the border width.
    const chrome = el.offsetHeight - el.clientHeight;
    const wanted = el.scrollHeight + chrome;

    el.style.height = `${Math.min(maxHeight, Math.max(minHeight, wanted))}px`;
  }, [value, minHeight, maxHeight]);

  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck={false}
      onChange={e => onChange(e.target.value)}
      {...rest}
    />
  );
}
