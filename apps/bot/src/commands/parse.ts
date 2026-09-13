/**
 * Slash command options only carry strings (autocomplete choices are
 * strings even for a row that is really a number), but every roster call
 * that takes a row id wants a number. `idOf` is the one place that bridges
 * the two: null for missing/blank input, null for anything that is not a
 * positive integer, otherwise the parsed number.
 */
export function idOf(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
