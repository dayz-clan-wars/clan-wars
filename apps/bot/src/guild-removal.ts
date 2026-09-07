import type { Database } from "@factions/db";
import { removeFromGuildDb, type RemovalResult } from "@factions/roster/internal";

/**
 * The gateway's `guildMemberRemove` handler. Spec §5.4: "being removed from
 * the Discord removes you from everything." Discord dispatches this event
 * for every guild the bot is in, so the FIRST thing this checks is that the
 * removal happened in THIS bot's configured guild — a bot in more than one
 * server must never touch a roster row over an event from somebody else's
 * guild. `"other-guild"` writes nothing at all; only a match reaches the
 * store, which is the one roster write a gateway event (not the log, a
 * clock, or the site) is allowed to start (§5.4).
 */
export async function handleGuildMemberRemove(
  db: Database,
  a: { guildId: string; expectedGuildId: string; userId: string; now: Date },
): Promise<RemovalResult | "other-guild"> {
  if (a.guildId !== a.expectedGuildId) return "other-guild";
  return removeFromGuildDb(db, { discordId: a.userId, at: a.now });
}
