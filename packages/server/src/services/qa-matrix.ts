/**
 * The user-matrix dimensions (handbook §1 "Think in every user"). Every QA doc's "## Users affected"
 * section carries one line per dimension: "- <label>: Affected: <rows> — case(s): <which>" or
 * "- <label>: Not affected: <why>". templates/qa-doc.md lists the same labels; a test keeps them equal.
 * This is the ONLY place the list lives.
 */
export const QA_MATRIX_DIMENSIONS = [
  'Platform',
  'Mac state',
  'Account age',
  'Plan',
  'Permissions',
  'Region/time/language',
  'Network',
] as const;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The dimensions the "## Users affected" body does not answer with "Affected: <text>" / "Not affected: <text>". */
export function missingDimensions(section: string): string[] {
  return QA_MATRIX_DIMENSIONS.filter(d =>
    !new RegExp(`^\\s*[-*]\\s*${esc(d)}\\s*:\\s*(?:Not\\s+affected|Affected)\\s*:\\s*[^\\s<]`, 'im').test(section));
}
