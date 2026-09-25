import type { ClanRole } from "@factions/domain";

/**
 * Shared between `/clan/vault`'s Add/Edit forms and their routes, so the
 * three places that parse or render `minRole` cannot drift from one
 * another — see `lib/form.ts` for the equivalent for plain text fields.
 */
export const VAULT_ROLES: readonly ClanRole[] = ["leader", "officer", "member"];

/** `null` unless `form`'s `minRole` field is exactly one of `VAULT_ROLES`. */
export function minRoleFrom(form: FormData): ClanRole | null {
  const v = form.get("minRole");
  return typeof v === "string" && (VAULT_ROLES as readonly string[]).includes(v) ? (v as ClanRole) : null;
}

/** The longest `minRole` a refused form may send back — the longest rank name. */
export const MIN_ROLE_MAX = Math.max(...VAULT_ROLES.map((r) => r.length));

/** A kept rank, but only if it is one; anything else falls back. The query is attacker-suppliable. */
export function roleOr(v: string | undefined, fallback: string): string {
  return v !== undefined && (VAULT_ROLES as readonly string[]).includes(v) ? v : fallback;
}

/**
 * Which lock's editor a refused edit should open inside, or `null` if the page's
 * top notice should carry the refusal instead.
 *
 * ⚠️ Review fix (M11, round 1): `LockEditor` only renders under `officer` — so
 * without the `officer` check, an officer demoted between page load and submit
 * (or a crafted `?result=edit.gone&kept.lock=<visible id>` from a non-officer)
 * would route the refusal to an editor that never renders, and the top notice
 * (suppressed whenever an id is chosen here) would vanish with nothing on
 * screen. `officer` must gate this decision, not just the JSX that reads it.
 */
export function editingIdFor(officer: boolean, editRefused: boolean, lockParam: string | undefined, locks: readonly { id: number }[]): number | null {
  if (!officer || !editRefused || lockParam === undefined) return null;
  const id = Number(lockParam);
  return locks.some((l) => l.id === id) ? id : null;
}
