/**
 * What a guild-membership check means, and when to check again.
 *
 * ⚠️ Pure, and separated from the fetch on purpose. This is where spec §2.7
 * actually lives — "a Discord outage does not log anyone out" is one line of
 * policy that is impossible to test through a network call and trivial to test
 * as a table.
 */

export type MembershipOutcome = "member" | "notMember" | "unknown";

/** Fifteen minutes: a kick takes effect within that, and Discord is not hammered. */
export const RECHECK_OK_SECONDS = 900;

/** One minute: quick recovery from an outage without a retry storm. */
export const RECHECK_BACKOFF_SECONDS = 60;

export function outcomeForStatus(status: number | "network-error"): MembershipOutcome {
  if (status === 200) return "member";
  if (status === 404) return "notMember";
  // ⚠️ 401/403 are about OUR bot token, not the player. If the token is revoked
  // or its role loses access, treating that as "not a member" would sign out
  // every player simultaneously and look exactly like a mass ban.
  return "unknown";
}

export function nextCheckAfter(outcome: MembershipOutcome, nowSeconds: number): number {
  return nowSeconds + (outcome === "unknown" ? RECHECK_BACKOFF_SECONDS : RECHECK_OK_SECONDS);
}
