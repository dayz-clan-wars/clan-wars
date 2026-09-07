import type { Database } from "@factions/db";
import { factions } from "@factions/db";
import { and, eq, inArray } from "drizzle-orm";
import { HOLDING_STATUSES } from "@factions/domain";
import { grantGuestPassDb } from "@factions/roster/internal";
import type { Reply } from "./commands.js";

// Widened for drizzle's inArray(), the same way the roster store does it.
const HOLDING: string[] = [...HOLDING_STATUSES];

/**
 * `/guest`, the one live slash command (spec §9.1/increment 7): give
 * someone a 24h voice guest pass. The command itself resolves only WHICH
 * clan the channel it ran in belongs to — `grantGuestPassDb` re-derives the
 * actor's role from `faction_members` itself under the clan's row lock, so
 * nothing here is trusted stale by the time the write lands.
 */
export async function handleGuestCommand(
  db: Database,
  a: { channelId: string; actorDiscordId: string; targetUserId: string; now: Date },
): Promise<Reply> {
  const [clan] = await db.select({ id: factions.id }).from(factions)
    .where(and(eq(factions.discordTextChannelId, a.channelId), inArray(factions.status, HOLDING)));
  if (!clan) return { content: "Run this in your clan's channel.", ephemeral: true };

  const { outcome } = await grantGuestPassDb(db, {
    factionId: clan.id, actorDiscordId: a.actorDiscordId, userDiscordId: a.targetUserId, at: a.now,
  });

  switch (outcome) {
    case "ok":
      return { content: `Guest pass given: <@${a.targetUserId}> can see and join the voice channel for 24h.`, ephemeral: true };
    case "not-permitted":
      return { content: "Only an officer or the leader can give a guest pass.", ephemeral: true };
    case "already-active":
      return { content: "They already have an active pass.", ephemeral: true };
    case "is-member":
      return { content: "They are a full member already — no pass needed.", ephemeral: true };
    case "self":
      return { content: "You can't grant yourself a guest pass.", ephemeral: true };
  }
}
