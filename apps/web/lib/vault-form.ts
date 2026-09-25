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
