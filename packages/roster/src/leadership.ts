import type { Database } from "@factions/db";
import {
  claimSuccessionDb, openVoteDb, castVoteDb, siteBaseUrl,
  type ClaimOutcome, type OpenVoteOutcome, type CastOutcome,
} from "./internal";
import { actorFor, isRefusal, type ActorRefusal } from "./actor";

export type { ClaimOutcome, OpenVoteOutcome, CastOutcome };
export type { OpenVote, OpenClaim } from "./internal";

/** Claim a silent leader's seat. Every eligibility rule (spec §5.1, ruling 1) lives in `claimSuccessionDb`; this only resolves the actor. */
export async function claimSuccessionDbFor(db: Database, now: Date, actorDiscordId: string): Promise<ClaimOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return claimSuccessionDb(db, { factionId: a.factionId, claimantDiscordId: actorDiscordId, at: now });
}

/** Open a no-confidence vote, nominating a replacement (yourself included). The leader may not open one (ruling 4). */
export async function openVoteDbFor(
  db: Database, now: Date, actorDiscordId: string, nomineeDiscordId: string,
): Promise<{ outcome: OpenVoteOutcome | ActorRefusal; voteId: number | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, voteId: null };
  return openVoteDb(db, {
    factionId: a.factionId, openerDiscordId: actorDiscordId, nomineeDiscordId, at: now, siteBaseUrl: siteBaseUrl(),
  });
}

/** Cast your one ballot in your clan's open vote. */
export async function castVoteDbFor(db: Database, now: Date, actorDiscordId: string): Promise<CastOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return castVoteDb(db, { factionId: a.factionId, voterDiscordId: actorDiscordId, at: now });
}
