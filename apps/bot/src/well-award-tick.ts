import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { consumerCursors, events, identityLinks, wellAwards, type Database } from "@factions/db";
import { WELL_ROOF_PART } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { writeCursor } from "@factions/event-log";
import { grantAwardTx } from "@factions/roster/internal";
import { brickUnderRoof, bricksNear, wellAnchor } from "./wells.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const WELL_AWARD_CONSUMER = "well-award-consumer";

const AWARD_KEY = "plate-carrier";
const AWARD_DAYS = 7;
const REASON = "Rebuilt a well";
const BATCH = 500;

/**
 * One plate carrier per well a player roofs, once per player per well, for good
 * (spec 2026-10-26-water-works, "The plate carrier award"). Two halves:
 * record what is owed from the log, then pay whatever is owed to a linked player.
 */
export async function wellAwardTick(db: Database, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string }): Promise<{ recorded: number; paid: number }> {
  const recorded = await recordWellAwards(db);
  // After the record, so a linked player is paid in the same tick as their roof.
  const paid = await payWellAwards(db, opts);
  return { recorded, paid };
}

/**
 * Read every well roof past the cursor and record one owed award per (player, well).
 *
 * ⚠️ No seed: with no cursor row this starts at 0 and scans the whole log. That is
 * deliberate — past builds are paid (spec, "Past builds count"). A rewound cursor is
 * harmless for the same reason a replay is: `well_awards_player_well_uq` turns every
 * repeat into a no-op.
 */
async function recordWellAwards(db: Database): Promise<number> {
  const [row] = await db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
    .where(eq(consumerCursors.consumerName, WELL_AWARD_CONSUMER));
  let cursor = row?.n ?? 0;
  let recorded = 0;
  for (;;) {
    const roofs = await db.select({
      id: events.id, at: events.occurredAt, serverId: events.serverId,
      dayzId: sql<string | null>`${events.payload}->>'dayzId'`,
      x: sql<number>`(${events.payload}->'pos'->>'x')::float`,
      z: sql<number>`(${events.payload}->'pos'->>'z')::float`,
    }).from(events)
      .where(and(
        gt(events.id, cursor), eq(events.type, "base.built"),
        sql`${events.payload}->>'part' = ${WELL_ROOF_PART}`,
      ))
      .orderBy(asc(events.id)).limit(BATCH);
    if (roofs.length === 0) break;
    // ⚠️ The inserts and the cursor commit together: a crash can never advance past a
    // roof it did not record (which would lose an award for good), and a crash before
    // the commit only replays into the unique index.
    recorded += await db.transaction(async (tx) => {
      let n = 0;
      for (const r of roofs) {
        // A roof line with no position cannot be placed against a well; nor can one with no builder.
        if (r.dayzId === null || r.x === null || r.z === null) continue;
        const brick = await brickUnderRoof(tx, r.serverId, Number(r.x), Number(r.z), r.at);
        if (!brick) continue;
        // ⚠️ The anchor is taken around the MATCHED BRICK, not the roof: a rebuild after
        // decay lays a new brick ~2 m from the old, and the earliest brick within reach
        // of it is the original — the same well, so the same key, so no second payment.
        const near = await bricksNear(tx, r.serverId, brick.x, brick.z);
        // ⚠️ The anchor is not transitive: a rebuild brick laid between two wells can
        // bring a NEIGHBOURING well's earlier brick within reach, move this well's anchor
        // to it, and dodge the unique index — paying the same well twice. So any award
        // this player already holds on a brick in reach means this roof is not paid.
        // Errs toward under-paying (two genuinely distinct wells within 5 m of one brick
        // pay once), never toward paying twice; the unique index stays the replay guard.
        const ids = near.map((b) => b.id);
        const [held] = await tx.select({ id: wellAwards.id }).from(wellAwards)
          .where(and(eq(wellAwards.dayzId, r.dayzId), inArray(wellAwards.wellBrickEventId, ids))).limit(1);
        if (held) continue;
        const anchor = wellAnchor(near);
        const ins = await tx.insert(wellAwards).values({
          serverId: r.serverId, dayzId: r.dayzId, wellBrickEventId: anchor, roofEventId: r.id, roofedAt: r.at,
        }).onConflictDoNothing({ target: [wellAwards.dayzId, wellAwards.wellBrickEventId] }).returning({ id: wellAwards.id });
        n += ins.length;
      }
      await writeCursor(tx, WELL_AWARD_CONSUMER, roofs[roofs.length - 1]!.id);
      return n;
    });
    cursor = roofs[roofs.length - 1]!.id;
    if (roofs.length < BATCH) break;
  }
  return recorded;
}

/**
 * Grant every owed plate carrier whose builder is now linked (the "held until they
 * link" rule, `payBountyAwards`'s shape line for line).
 *
 * ⚠️ Level-triggered and idempotent: the row is locked FOR UPDATE and
 * `award_grant_id` rechecked before granting, then set in the SAME transaction
 * (lock order well_awards → award_grants → clan_notices). A retry after a crash,
 * or two passes racing, grants exactly once.
 */
export async function payWellAwards(db: Database, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string }): Promise<number> {
  // ⚠️ INNER join: an unlinked builder's award simply is not in this list yet. It
  // is not refused and not dropped; it waits for the link.
  const owed = await db.select({ id: wellAwards.id }).from(wellAwards)
    .innerJoin(identityLinks, eq(identityLinks.dayzId, wellAwards.dayzId))
    .where(and(isNull(wellAwards.awardGrantId), isNull(wellAwards.awardFailure)))
    .orderBy(asc(wellAwards.id));
  let paid = 0;
  for (const { id } of owed) {
    // ⚠️ One row's failure is its own: an award that keeps failing must not stop
    // every award owed after it from being paid.
    try {
      if (await payOne(id)) paid++;
    } catch (err) {
      console.error(`well award #${id}: payout failed; it stays owed and retries next tick`, err);
    }
  }
  return paid;

  function payOne(id: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [w] = await tx.select().from(wellAwards).where(eq(wellAwards.id, id)).for("update");
      if (!w || w.awardGrantId !== null || w.awardFailure !== null) return false;
      // ⚠️ FOR SHARE: a guild removal deletes the link and then revokes that player's
      // open grants. Without this lock it could do both between our read and our
      // commit, never see our grant, and leave a departed player holding a live award.
      // Safe to take here: removal locks the link before grants and never touches well_awards.
      const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks)
        .where(eq(identityLinks.dayzId, w.dayzId)).for("share");
      if (!link) return false;
      // ⚠️ An award that left the catalogue is recorded, never thrown: grantAwardTx
      // would refuse it every tick forever. KotH's and the bounties' rule.
      if (!awardsCatalogue()[AWARD_KEY]) {
        const failure = `award "${AWARD_KEY}" is no longer in awards.json; grant it by hand with /award grant`;
        await tx.update(wellAwards).set({ awardFailure: failure }).where(eq(wellAwards.id, w.id));
        console.error(`well award #${w.id}: ${failure}`);
        return false;
      }
      const g = await grantAwardTx(tx, {
        awardKey: AWARD_KEY, winnerDiscordId: link.discordId, grantedByDiscordId: opts.grantedByDiscordId,
        // ⚠️ Never a coordinate: the reason reaches a DM and the site.
        reason: REASON, siteBaseUrl: opts.siteBaseUrl, now: opts.now, serverId: w.serverId, durationDays: AWARD_DAYS,
      });
      // ⚠️ Throw, never "succeed" without a grant: the rollback leaves it owed and the next tick retries.
      if (!g.ok) throw new Error(`well award #${w.id}: award grant refused (${g.reason})`);
      await tx.update(wellAwards).set({ awardGrantId: g.grantId }).where(eq(wellAwards.id, w.id));
      return true;
    });
  }
}
