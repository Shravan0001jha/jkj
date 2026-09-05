import { useLayoutEffect, useRef } from 'react';

/**
 * A textarea that grows to fit what it holds.
 *
 * Context documents are read as documents, not scrolled in a small box — a
 * clipped last line reads as a rendering fault, not as "there is more".
 */
export function GrowTextarea({
  value, onChange, minHeight = 170, ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  minHeight?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [value, minHeight]);

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
