import type { Database } from "@factions/db";
import { kothVoteVoters } from "@factions/db";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A departed user's KotH ballots (spec 2026-09-24 §7). The frozen electorate size
 * and turnout floor do not move — the vote's bar was fixed when it opened; only
 * this user's own row(s) across every open (or closed) vote are dropped.
 * ⚠️ Lock order: `koth_vote_voters` sits after `guest_passes` and before
 * `award_grants`, which is why every call site sits immediately before its
 * `revokeAwardsForTx(tx, a.discordId, a.at)` in `removal-store.ts`.
 */
export async function dropKothBallotsTx(tx: Tx, discordId: string): Promise<number> {
  const gone = await tx.delete(kothVoteVoters).where(eq(kothVoteVoters.discordId, discordId)).returning({ v: kothVoteVoters.voteId });
  return gone.length;
}
