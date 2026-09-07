/**
 * Leadership succession, vote thresholds, nickname formatting and vault
 * codes (spec §13). Pure rules only — no DB, no Discord.
 *
 * `packages/roster` defines its own `Role` union (`"leader" | "officer" |
 * "member"`) but domain cannot import roster (the dependency runs the other
 * way), so `ROLE_RANK` is keyed on the same string union restated here as
 * `ClanRole`.
 */
import { VOTE_THRESHOLD, VAULT_CODE_DIGITS } from "./rules";

/** Mirrors `packages/roster`'s `Role` union — domain cannot import it. */
export type ClanRole = "leader" | "officer" | "member";

export const ROLE_RANK = { leader: 3, officer: 2, member: 1 } as const;

/** Minimum electorate votes needed to pass, from VOTE_THRESHOLD (spec §13). */
export function voteThreshold(electorateSize: number): number {
  return Math.ceil((VOTE_THRESHOLD.num / VOTE_THRESHOLD.den) * electorateSize);
}

/** True iff `role`'s rank is at least `minRole`'s. */
export function canSeeLock(role: ClanRole, minRole: ClanRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** Discord nickname length cap (platform limit). */
export const NICKNAME_MAX = 32;

/**
 * `[TAG] gamertag`, tag upper-cased, gamertag sliced so the whole string
 * fits NICKNAME_MAX. With no tag, the bare gamertag (untouched).
 */
export function nicknameFor(gamertag: string, tag: string | null): string {
  if (tag === null) return gamertag;
  const prefix = `[${tag.toUpperCase()}] `;
  const maxGamertag = NICKNAME_MAX - prefix.length;
  return prefix + gamertag.slice(0, maxGamertag);
}

/** `VAULT_CODE_DIGITS`-digit zero-padded numeric code. */
export function randomVaultCode(rng: () => number = Math.random): string {
  const max = 10 ** VAULT_CODE_DIGITS;
  const n = Math.floor(rng() * max);
  return String(Math.min(n, max - 1)).padStart(VAULT_CODE_DIGITS, "0");
}

/** `vault_history.action` (spec §4, vault_locks/vault_history). */
export const VAULT_ACTIONS = ["added", "edited", "rotated", "revealed", "confirmed", "deleted"] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];
