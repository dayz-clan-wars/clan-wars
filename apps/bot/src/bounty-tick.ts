import { and, asc, eq, gt, gte, isNull, lt, or } from "drizzle-orm";
import { bounties, identityLinks, kills, playerSessions, type Database } from "@factions/db";
import { bountyOutcome } from "@factions/domain";
import { appendClanNoticeTx, scoringKill } from "@factions/roster/internal";

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
export async function bountyTick(db: Database, opts: { now: Date }): Promise<{ claimed: number; expired: number }> {
  const out = { claimed: 0, expired: 0 };
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
  return out;
}
