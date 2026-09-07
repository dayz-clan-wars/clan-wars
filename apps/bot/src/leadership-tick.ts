import type { Database } from "@factions/db";
import { resolveSuccessionClaims, closeExpiredVotes } from "@factions/roster/internal";

export type LeadershipTickResult = { succeeded: number; voided: number; passed: number; failed: number };

/**
 * Spec §7's leadership clock, run every bot tick (ruling 13): the succession
 * half (a silent leader's claim, past its resolves_at, hands over the seat
 * or is voided) and the no-confidence half (a vote past its closes_at is
 * passed or failed) — the two reads `resolveSuccessionClaims` and
 * `closeExpiredVotes` already do inside `@factions/roster/internal`. Kept
 * together in one function because the runner logs them together.
 */
export async function leadershipTick(db: Database, now: Date): Promise<LeadershipTickResult> {
  const claims = await resolveSuccessionClaims(db, now);
  const votes = await closeExpiredVotes(db, now);
  return { succeeded: claims.succeeded, voided: claims.voided, passed: votes.passed, failed: votes.failed };
}
