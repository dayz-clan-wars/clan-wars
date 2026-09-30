import { and, asc, eq, gt, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { bounties, identityLinks, kills, playerSessions, players, type Database } from "@factions/db";
import { bountyOutcome } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { appendClanNoticeTx, grantAwardTx, scoringKill } from "@factions/roster/internal";

/**
 * Close open bounties: claimed by a scoring kill, or expired once the target has
 * served their online time (spec 2026-09-23-bounties §2.4–§2.8).
 *
 * ⚠️ No cursor over `kills`. `rebuild:kills` reinserts every kill with a new id, so a
 * cursor would stall or re-claim. Each open bounty asks the question fresh: "the first
 * scoring kill of this target at or after placed_at". There are only ever a handful.
 *
 * ⚠️ Runs AFTER sessionsTick and killsTick in discord.ts, so a kill and a disconnect
 * ingested this tick are seen by it.
 *
 * ⚠️ Every close is guarded by `status = 'open'` in its UPDATE, so a revoke that won
 * the race is never overwritten by a claim.
 */
export async function bountyTick(db: Database, opts: { now: Date; siteBaseUrl: string }): Promise<{ claimed: number; expired: number; paid: number }> {
  const out = { claimed: 0, expired: 0, paid: 0 };
  const open = await db.select().from(bounties).where(eq(bounties.status, "open")).orderBy(asc(bounties.id));

  for (const b of open) {
    const [first] = await db.select({ eventId: kills.eventId, occurredAt: kills.occurredAt, killer: kills.killerDayzId })
      .from(kills)
      .where(and(eq(kills.serverId, b.serverId), eq(kills.victimDayzId, b.targetDayzId), gte(kills.occurredAt, b.placedAt), scoringKill))
      .orderBy(asc(kills.occurredAt), asc(kills.eventId)).limit(1);
    const spans = (await db.select({ from: playerSessions.connectedAt, to: playerSessions.disconnectedAt }).from(playerSessions)
      .where(and(
        eq(playerSessions.serverId, b.serverId), eq(playerSessions.dayzId, b.targetDayzId),
        lt(playerSessions.connectedAt, opts.now),
        or(isNull(playerSessions.disconnectedAt), gt(playerSessions.disconnectedAt, b.placedAt)),
      )));

    const outcome = bountyOutcome(b, spans, first?.occurredAt ?? null, opts.now);
    if (outcome.kind === "open") continue;

    await db.transaction(async (tx) => {
      if (outcome.kind === "claimed") {
        const done = await tx.update(bounties).set({
          status: "claimed", closedAt: opts.now, claimedByDayzId: first!.killer!, claimEventId: first!.eventId, claimedAt: first!.occurredAt,
        }).where(and(eq(bounties.id, b.id), eq(bounties.status, "open"))).returning({ id: bounties.id });
        // A claim DMs nobody: the channel post is the notice, and the target already knows.
        if (done.length) out.claimed++;
        return;
      }
      const done = await tx.update(bounties).set({ status: "expired", closedAt: opts.now })
        .where(and(eq(bounties.id, b.id), eq(bounties.status, "open"))).returning({ id: bounties.id });
      if (!done.length) return;
      out.expired++;
      const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, b.targetDayzId));
      if (link) {
        await appendClanNoticeTx(tx, {
          serverId: b.serverId, factionId: null, target: "dm", discordTargetId: link.discordId,
          kind: "bounty_expired", occurredAt: opts.now, payload: { bountyId: b.id },
        });
      }
    });
  }
  // After the claims, so a linked killer is paid in the same tick as their kill.
  out.paid = await payBountyAwards(db, opts);
  return out;
}

/**
 * Grant every owed bounty prize whose killer is now linked (the "held until they
 * link" rule). A killer linked at the kill is paid the same tick; one who links a
 * week later is paid the tick after they do.
 *
 * ⚠️ Level-triggered and idempotent: the bounty row is locked FOR UPDATE and
 * `award_grant_id` rechecked before granting, then set in the SAME transaction
 * (lock order bounties → award_grants → clan_notices). A retry after a crash, or
 * two passes racing, grants exactly once.
 */
export async function payBountyAwards(db: Database, opts: { now: Date; siteBaseUrl: string }): Promise<number> {
  // ⚠️ INNER join: an unlinked killer's prize simply is not in this list yet. It
  // is not refused and not dropped; it waits for the link.
  const owed = await db.select({ id: bounties.id }).from(bounties)
    .innerJoin(identityLinks, eq(identityLinks.dayzId, bounties.claimedByDayzId))
    .where(and(
      eq(bounties.status, "claimed"), isNotNull(bounties.awardKey),
      isNull(bounties.awardGrantId), isNull(bounties.awardFailure),
    ))
    .orderBy(asc(bounties.id));
  let paid = 0;
  for (const { id } of owed) {
    // ⚠️ One bounty's failure is its own: a prize that keeps failing must not stop
    // every prize owed after it from being paid.
    try {
      if (await payOne(id)) paid++;
    } catch (err) {
      console.error(`bounty #${id}: prize payout failed; it stays owed and retries next tick`, err);
    }
  }
  return paid;

  function payOne(id: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [b] = await tx.select().from(bounties).where(eq(bounties.id, id)).for("update");
      if (!b || b.status !== "claimed" || b.awardKey === null || b.awardDays === null
        || b.awardGrantId !== null || b.awardFailure !== null) return false;
      // ⚠️ FOR SHARE: a guild removal deletes the link and then revokes that player's
      // open grants. Without this lock it could do both between our read and our
      // commit, never see our grant, and leave a departed player holding a live prize.
      // Safe to take here: removal locks the link before grants and never touches bounties.
      const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks)
        .where(eq(identityLinks.dayzId, b.claimedByDayzId!)).for("share");
      if (!link) return false;
      // ⚠️ A prize that left the catalogue after placement is recorded, never
      // thrown: grantAwardTx would refuse it every tick forever. KotH's rule.
      if (!awardsCatalogue()[b.awardKey]) {
        const failure = `award "${b.awardKey}" is no longer in awards.json; grant it by hand with /award grant`;
        await tx.update(bounties).set({ awardFailure: failure }).where(eq(bounties.id, b.id));
        console.error(`bounty #${b.id}: ${failure}`);
        return false;
      }
      const [target] = await tx.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, b.targetDayzId));
      const g = await grantAwardTx(tx, {
        awardKey: b.awardKey, winnerDiscordId: link.discordId, grantedByDiscordId: b.placedByDiscordId,
        reason: `Collected the bounty on ${target?.gamertag ?? "a wanted player"}`,
        siteBaseUrl: opts.siteBaseUrl, now: opts.now, serverId: b.serverId, durationDays: b.awardDays,
      });
      // ⚠️ Throw, never "succeed" without a grant: the rollback leaves it owed and the next tick retries.
      if (!g.ok) throw new Error(`bounty #${b.id}: award grant refused (${g.reason})`);
      await tx.update(bounties).set({ awardGrantId: g.grantId }).where(eq(bounties.id, b.id));
      return true;
    });
  }
}
