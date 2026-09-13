import { VAULT_TABLES, type VaultAction } from "@factions/copy";
export { VAULT_TABLES, type VaultAction } from "@factions/copy";

/** Read once by /clan/vault above the lock list. Site-only: the bot has no lock list page. */
export const VAULT_INTRO =
  "You see only the locks your rank unlocks. Codes are hidden behind a tap so they are not on screen in a stream. Rotating a code here does not change the lock in the game.";

export function vaultCode<A extends VaultAction>(action: A, outcome: keyof (typeof VAULT_TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a vault route can redirect (or, for `reveal`, respond) with, flattened to "<action>.<outcome>". A null-prototype object, same reasoning as `RESULT_COPY`. */
export const VAULT_RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(VAULT_TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
