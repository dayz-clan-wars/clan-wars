// apps/bot/src/raid-award.ts
import { and, asc, eq, gte } from "drizzle-orm";
import { alphaWeeks, factions, raidAwardWeeks, type Database } from "@factions/db";
import { RAID_AWARD_DAYS, RAID_AWARD_FIRST_WEEK, RAID_AWARD_KEY } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { grantAwardTx } from "@factions/roster/internal";
import { raidAwardText } from "./raid-award-text.js";

const reasonFor = (weekStart: Date) => `Top raiding clan, week of ${weekStart.toISOString().slice(0, 10)}`;

/**
 * Pay the weekly weapon kit to each closed week's top raiding clan, once
 * (spec 2026-11-06-raid-value-scoring §4). Run right after `weekTick`, so the
 * winner is the very `alpha_weeks` rank 1 row the Alpha badge came from.
 *
 * One transaction per week, lock order raid_award_weeks → award_grants →
 * clan_notices. The post goes out after the commit.
 *
 * ⚠️ The ledger insert is the idempotency guard: no row returned means the week
 * is already paid. A refused grant THROWS, rolling the ledger row back so the
 * next tick retries. A prize missing from the catalogue, or a disbanded clan, is
 * NOT a refusal: it records `detail.failure` with no grant, because it would
 * refuse forever.
 *
 * The grant goes to `factions.leader_discord_id` as of now. That column is NOT
 * NULL, so a leader always has a Discord id and the spec's "held until the leader
 * links" path is not needed.
 *
 * ⚠️ Weeks before `RAID_AWARD_FIRST_WEEK` are never paid.
 */
export async function payRaidAwards(
  db: Database,
  opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string; post: (text: string) => Promise<void> },
): Promise<{ paid: number }> {
  const winners = await db.select({ seasonId: alphaWeeks.seasonId, weekStart: alphaWeeks.weekStart, factionId: alphaWeeks.factionId, points: alphaWeeks.points })
    .from(alphaWeeks)
    .where(and(eq(alphaWeeks.rank, 1), gte(alphaWeeks.weekStart, RAID_AWARD_FIRST_WEEK)))
    .orderBy(asc(alphaWeeks.weekStart), asc(alphaWeeks.seasonId));

  let paid = 0;
  for (const w of winners) {
    // A refused grant throws out of here, rolled back: the caller's try/catch logs it and
    // the next tick retries. Weeks go oldest first, so a stuck week blocks later ones, not the reverse.
    const text = await db.transaction(async (tx) => {
        const [faction] = await tx.select({ name: factions.name, status: factions.status, leader: factions.leaderDiscordId, serverId: factions.serverId })
          .from(factions).where(eq(factions.id, w.factionId));
        // The alpha_weeks FK means the row exists; this is a type guard.
        if (!faction) throw new Error(`raid award: faction ${w.factionId} missing`);

        const claimed = await tx.insert(raidAwardWeeks).values({
          seasonId: w.seasonId, weekStart: w.weekStart, factionId: w.factionId,
          leaderDiscordId: faction.leader, closedAt: opts.now,
        }).onConflictDoNothing().returning({ weekStart: raidAwardWeeks.weekStart });
        if (claimed.length === 0) return null;

        const unpaid = async (failure: string) => {
          console.error(`raid award: week ${w.weekStart.toISOString()} season ${w.seasonId} unpaid: ${failure}`);
          await tx.update(raidAwardWeeks).set({ detail: { failure } })
            .where(and(eq(raidAwardWeeks.seasonId, w.seasonId), eq(raidAwardWeeks.weekStart, w.weekStart)));
          return null;
        };
        if (faction.status === "disbanded") return unpaid("winning clan was disbanded before the award was paid");
        if (!awardsCatalogue()[RAID_AWARD_KEY]) {
          return unpaid(`award "${RAID_AWARD_KEY}" is no longer in awards.json; grant it by hand with /award grant to ${faction.leader}`);
        }

        const g = await grantAwardTx(tx, {
          awardKey: RAID_AWARD_KEY, durationDays: RAID_AWARD_DAYS, winnerDiscordId: faction.leader, grantedByDiscordId: opts.grantedByDiscordId,
          reason: reasonFor(w.weekStart), siteBaseUrl: opts.siteBaseUrl, now: opts.now, serverId: faction.serverId,
        });
        if (!g.ok) throw new Error(`raid award: grant refused (${g.reason})`);
        await tx.update(raidAwardWeeks).set({ awardGrantId: g.grantId })
          .where(and(eq(raidAwardWeeks.seasonId, w.seasonId), eq(raidAwardWeeks.weekStart, w.weekStart)));
        return raidAwardText(faction.name, w.points);
    });
    if (text === null) continue;
    paid += 1;
    // ⚠️ After the commit: the grant stands whether or not the post lands, and the
    // ledger row means it is never re-posted. A lost post is logged, not retried.
    try { await opts.post(text); } catch (err) { console.warn("raid award: announcement failed", err); }
  }
  return { paid };
}
