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
 * ⚠️ HALTS over the cap: if MORE than `max` linked users look absent, nobody
 * is removed and `capped` is true. A handful of leavers is plausible after
 * downtime; hundreds is a bad member read, and the removals are irreversible.
 * At or under the cap, each is CONFIRMED before removal, oldest link first.
 *
 * ⚠️ `memberExists` is that confirmation: a REST member fetch per candidate
 * (`GuildGateway.fetchMemberExists`). A cache can be missing a member who is
 * still there; only Discord's Unknown Member (false) removes. True keeps the
 * user, and null (the fetch failed) skips them this pass. The cap still
 * counts cache misses: it is the cheap alarm, the fetch is the proof.
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
    memberExists: (id: string) => Promise<boolean | null>;
    now: Date;
    max: number;
    remove?: RemoveFromGuild;
  },
): Promise<{ removed: { discordId: string; gamertag: string }[]; capped: boolean; missing: number }> {
  if (!opts.ready) return { removed: [], capped: false, missing: 0 };
  const links = await db
    .select({ discordId: identityLinks.discordId, gamertag: identityLinks.gamertag })
    .from(identityLinks)
    .orderBy(asc(identityLinks.id));
  const missing = links.filter((l) => !opts.isMember(l.discordId));
  if (missing.length > opts.max) return { removed: [], capped: true, missing: missing.length };
  const removed: { discordId: string; gamertag: string }[] = [];
  for (const { discordId, gamertag } of missing) {
    let exists: boolean | null;
    try {
      exists = await opts.memberExists(discordId);
    } catch (err) {
      console.error(`guild-sweep: confirming ${discordId} failed`, err);
      exists = null;
    }
    if (exists === null) {
      console.warn(`guild-sweep: could not confirm ${discordId} left; skipped this pass`);
      continue;
    }
    if (exists) continue;   // a cache miss, not a leaver
    try {
      // The guild check is the live handler's concern; the sweep already
      // judged membership against the configured guild's cache.
      const res = await handleGuildMemberRemove(
        db,
        { guildId: "sweep", expectedGuildId: "sweep", userId: discordId, now: opts.now },
        opts.remove,
      );
      // Only a removal that actually dropped a link counts, so a user the
      // live event already removed is not reported twice.
      if (res !== "other-guild" && res.linked) removed.push({ discordId, gamertag });
    } catch (err) {
      console.error(`guild-sweep: removing ${discordId} failed`, err);
    }
  }
  return { removed, capped: false, missing: missing.length };
}
