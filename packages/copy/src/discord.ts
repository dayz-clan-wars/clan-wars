import { TABLES, type Action } from "./clan";
import { VAULT_TABLES, type VaultAction } from "./vault";
import { LEADERSHIP_TABLES, type LeadershipAction } from "./leadership";

/**
 * Where Discord's wording must differ from the site's.
 *
 * ⚠️ Wording only. There is one table per action and both surfaces read it,
 * so an outcome can never be covered on one surface and blank on the other —
 * which is the failure this arrangement exists to make impossible. Entries
 * here exist because a string names something that is only on the site: a
 * checkbox the player ticks, a form they submit, a page they visit.
 *
 * Compile-time keyed: an outcome that no longer exists stops typechecking,
 * and test/overrides.test.ts catches the same thing at runtime for anything
 * reached dynamically.
 */
export const DISCORD_OVERRIDES: {
  [A in Action]?: Partial<Record<keyof (typeof TABLES)[A] & string, string>>
} = {
  disband: { unconfirmed: "Press Confirm to disband — this cannot be undone." },
  transfer: { unconfirmed: "Press Confirm to hand over leadership." },
  input: { "bad-input": "Something in that was missing or too long. Try again." },
};

export function discordCopy<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  const over = (DISCORD_OVERRIDES[action] as Record<string, string> | undefined)?.[outcome];
  return over ?? (TABLES[action][outcome] as string);
}

export const DISCORD_VAULT_OVERRIDES: {
  [A in VaultAction]?: Partial<Record<keyof (typeof VAULT_TABLES)[A] & string, string>>
} = {};

export function discordVaultCopy<A extends VaultAction>(action: A, outcome: keyof (typeof VAULT_TABLES)[A] & string): string {
  const over = (DISCORD_VAULT_OVERRIDES[action] as Record<string, string> | undefined)?.[outcome];
  return over ?? (VAULT_TABLES[action][outcome] as string);
}

export const DISCORD_LEADERSHIP_OVERRIDES: {
  [A in LeadershipAction]?: Partial<Record<keyof (typeof LEADERSHIP_TABLES)[A] & string, string>>
} = {
  "claim-succession": { unconfirmed: "Press Confirm to claim the leader's seat." },
  "open-vote": { unconfirmed: "Press Confirm to open the vote." },
};

export function discordLeadershipCopy<A extends LeadershipAction>(action: A, outcome: keyof (typeof LEADERSHIP_TABLES)[A] & string): string {
  const over = (DISCORD_LEADERSHIP_OVERRIDES[action] as Record<string, string> | undefined)?.[outcome];
  return over ?? (LEADERSHIP_TABLES[action][outcome] as string);
}
