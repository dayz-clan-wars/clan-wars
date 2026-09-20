import { discordBoosters, boosterKits, type Database } from "@factions/db";
import { and, eq, isNull, notExists, notInArray, sql } from "drizzle-orm";
import { appendClanNoticeTx } from "@factions/roster/internal";
import type { Guild } from "discord.js";

/** What the tick needs from Discord, so a test can hand it a fake. */
export type BoosterSource = {
  fetchBoosters(): Promise<{ discordId: string; premiumSince: Date }[]>;
};

export type BoosterTickResult = { boosters: number; added: number; removed: number; prompted: number };

/**
 * Mirror the guild's current boosters into `discord_boosters`, the table the
 * booster-kit spawner reads (it has no Discord client and should not grow
 * one).
 *
 * ⚠️ Level-triggered: every run recomputes the whole set from Discord rather
 * than reacting to gateway events, so a missed GuildMemberUpdate or a
 * skipped run heals on the next pass instead of leaving a phantom booster
 * holding a kit forever.
 *
 * ⚠️ The fetch is awaited FIRST, before anything is written or deleted, and
 * a throw propagates untouched — nothing below this line runs. A Discord
 * outage that resolved to an empty member list would otherwise read as
 * "nobody is boosting" and revoke every kit on the server at the next
 * restart.
 */
export async function boosterTick(db: Database, deps: {
  source: BoosterSource;
  now: Date;
  serverId: number;
  kitUrl: string;
}): Promise<BoosterTickResult> {
  const current = await deps.source.fetchBoosters();
  const ids = current.map((b) => b.discordId);

  const before = await db.select({ discordId: discordBoosters.discordId }).from(discordBoosters);
  const had = new Set(before.map((r) => r.discordId));

  for (const b of current) {
    await db.insert(discordBoosters)
      .values({ discordId: b.discordId, premiumSince: b.premiumSince, observedAt: deps.now })
      .onConflictDoUpdate({
        target: discordBoosters.discordId,
        set: { premiumSince: b.premiumSince, observedAt: deps.now },
      });
  }

  // ⚠️ An empty `ids` is a legitimate state (nobody is boosting) and must
  // clear the table, but `notInArray` with an empty array does not reliably
  // do that — some drivers translate it to a predicate that matches
  // nothing, leaving every stale row in place. Spelled out explicitly.
  const removed = ids.length === 0
    ? (await db.delete(discordBoosters).returning({ id: discordBoosters.discordId })).length
    : (await db.delete(discordBoosters).where(notInArray(discordBoosters.discordId, ids))
        .returning({ id: discordBoosters.discordId })).length;

  // ⚠️ AFTER the writes and deletes above, never before. The tick's own
  // warning about a Discord outage resolving to an empty member list applies
  // here one step worse: a kit projection can be recomputed next run, a DM
  // cannot be unsent.
  //
  // ⚠️ The kit_prompted_at check is the whole defence against re-prompting.
  // "Boosting with no kit" stays true until they choose, and this tick is
  // level-triggered, so without it every run DMs every kitless booster again.
  const unprompted = await db.select({ discordId: discordBoosters.discordId })
    .from(discordBoosters)
    .where(and(
      isNull(discordBoosters.kitPromptedAt),
      notExists(db.select({ one: sql`1` }).from(boosterKits)
        .where(eq(boosterKits.discordId, discordBoosters.discordId))),
    ));

  let prompted = 0;
  for (const b of unprompted) {
    await db.transaction(async (tx) => {
      await tx.update(discordBoosters)
        .set({ kitPromptedAt: deps.now })
        .where(eq(discordBoosters.discordId, b.discordId));
      await appendClanNoticeTx(tx, {
        serverId: deps.serverId,
        factionId: null,
        target: "dm",
        discordTargetId: b.discordId,
        kind: "booster_kit_unchosen",
        occurredAt: deps.now,
        payload: { kitUrl: deps.kitUrl },
      });
    });
    prompted++;
  }

  return {
    boosters: current.length,
    added: current.filter((b) => !had.has(b.discordId)).length,
    removed,
    prompted,
  };
}

/**
 * Adapts a real discord.js `Guild` to `BoosterSource`. `guild.members.fetch()`
 * is a heavy full-cache call, which is why this is scheduled on its own
 * throttle (see discord.ts) rather than every tick.
 */
export function guildBoosterSource(guild: Guild): BoosterSource {
  return {
    async fetchBoosters() {
      const members = await guild.members.fetch();
      return [...members.values()]
        .filter((m) => m.premiumSince !== null)
        .map((m) => ({ discordId: m.id, premiumSince: m.premiumSince! }));
    },
  };
}
