import { identityLinks, type Database } from "@factions/db";
import { asc } from "drizzle-orm";
import { handleGuildMemberRemove, type RemoveFromGuild } from "./guild-removal.js";

/**
 * Catches linked users who left the Discord while the bot was down. Spec §9:
 * this REVERSES ruling 10 (no catch-up sweep) — with link-to-play a stale link
 * keeps a gamertag playing for free, so a missed `guildMemberRemove` now
 * matters.
 *
 * ⚠️ `ready` must be "one full member fetch has resolved". A cold member cache
 * reads as "everyone left", and the removals this runs are irreversible
 * (link, roster row, ban). Never run it without that.
 *
 * ⚠️ Capped per pass, oldest link first so repeated passes converge. More
 * non-members than the cap in one read is more likely a bad cache read than a
 * real exodus; `capped` lets the caller shout about it while still bounding
 * the damage to `max` removals per pass.
 *
 * Each removal goes through `handleGuildMemberRemove` (same-guild sentinel
 * below), so it gets the live handler's one deadlock retry and the same
 * store call. One failure is logged and does not stop the rest.
 */
export async function sweepMissedRemovals(
  db: Database,
  opts: {
    ready: boolean;
    isMember: (id: string) => boolean;
    now: Date;
    max: number;
    remove?: RemoveFromGuild;
  },
): Promise<{ removed: string[]; capped: boolean }> {
  if (!opts.ready) return { removed: [], capped: false };
  const links = await db
    .select({ discordId: identityLinks.discordId })
    .from(identityLinks)
    .orderBy(asc(identityLinks.id));
  const missing = links.map((l) => l.discordId).filter((id) => !opts.isMember(id));
  const capped = missing.length > opts.max;
  const removed: string[] = [];
  for (const discordId of missing.slice(0, opts.max)) {
    try {
      // The guild check is the live handler's concern; the sweep already
      // judged membership against the configured guild's cache.
      await handleGuildMemberRemove(
        db,
        { guildId: "sweep", expectedGuildId: "sweep", userId: discordId, now: opts.now },
        opts.remove,
      );
      removed.push(discordId);
    } catch (err) {
      console.error(`guild-sweep: removing ${discordId} failed`, err);
    }
  }
  return { removed, capped };
}
