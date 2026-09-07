import type { Database } from "@factions/db";
import { removeFromGuildDb, type RemovalResult } from "@factions/roster/internal";

/** Postgres' `deadlock_detected`. postgres.js hangs it on the error object as `code`. */
const DEADLOCK = "40P01";

function isDeadlock(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DEADLOCK;
}

/** The store call, injectable so the retry can be tested without mocking the module. */
export type RemoveFromGuild = (db: Database, a: { discordId: string; at: Date }) => Promise<RemovalResult>;

/**
 * The gateway's `guildMemberRemove` handler. Spec §5.4: "being removed from
 * the Discord removes you from everything." Discord dispatches this event
 * for every guild the bot is in, so the FIRST thing this checks is that the
 * removal happened in THIS bot's configured guild — a bot in more than one
 * server must never touch a roster row over an event from somebody else's
 * guild. `"other-guild"` writes nothing at all; only a match reaches the
 * store, which is the one roster write a gateway event (not the log, a
 * clock, or the site) is allowed to start (§5.4).
 *
 * ⚠️ ONE retry on a Postgres deadlock (`40P01`), and only that code. Ruling
 * 10 gives removals no catch-up sweep: an event this handler drops is an
 * identity link and a roster row that nothing ever comes back for. A
 * deadlock aborts only the losing transaction and leaves the database
 * untouched, so the whole store call is safe to replay — it is idempotent by
 * the link either way. Anything else is rethrown: a bug should be loud, not
 * retried.
 */
export async function handleGuildMemberRemove(
  db: Database,
  a: { guildId: string; expectedGuildId: string; userId: string; now: Date },
  remove: RemoveFromGuild = removeFromGuildDb,
): Promise<RemovalResult | "other-guild"> {
  if (a.guildId !== a.expectedGuildId) return "other-guild";
  try {
    return await remove(db, { discordId: a.userId, at: a.now });
  } catch (err) {
    if (!isDeadlock(err)) throw err;
    console.warn(`guild-removal: deadlock (${DEADLOCK}) removing ${a.userId}; retrying once`);
    return remove(db, { discordId: a.userId, at: a.now });
  }
}
