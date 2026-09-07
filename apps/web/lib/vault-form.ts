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
