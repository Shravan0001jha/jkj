/** A status chip. The dot pulses only while something is actually running. */
export function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      <i />
      {children}
    </span>
  );
}
