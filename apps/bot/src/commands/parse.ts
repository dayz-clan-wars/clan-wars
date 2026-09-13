import type { Role } from "@factions/roster";

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

const ROLES: readonly Role[] = ["leader", "officer", "member"];

/**
 * A role name off a slash choice or a custom id's `arg`, or null.
 *
 * ⚠️ Validated rather than cast: `arg` is client-supplied data that has
 * round-tripped through Discord, and it decides which ranks can read a lock.
 */
export function roleOf(raw: string | null): Role | null {
  return ROLES.find((r) => r === raw) ?? null;
}
