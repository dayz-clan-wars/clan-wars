import type { Database } from "@factions/db";
import { bans, consumerCursors, events } from "@factions/db";
import { readEventBatch, writeCursor } from "@factions/event-log";
import { HUB_BAN_MS, HUB_OFFENCE_MAX_AGE_MS, HUB_RETALIATION_WINDOW_MS, hubOffence, type BanStatus } from "@factions/domain";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const HUB_CONSUMER = "hub-watch";

export type HubTickResult = { seeded: boolean; scanned: number; banned: { dayzId: string; gamertag: string }[] };

const WATCHED = ["player.hit", "player.killed", "item.placed"];
/** A Hub ban still to serve. `expired`/`lifted` do not block a new offence. */
const ACTIVE: BanStatus[] = ["pending", "applied"];

/**
 * No combat at the Fast Travel Hub (spec 2026-09-22-hub-combat): a hit, kill
 * or trap there writes a one-hour `hub_combat` ban.
 *
 * ⚠️ This tick NEVER calls Nitrado. It writes `bans` rows; `banTick` applies,
 * expires and announces them, and its reference counting is what stops a Hub
 * ban's expiry from freeing an account that also holds another ban.
 *
 * ⚠️ The hour runs from NOW, when the bot processes the offence — an offence
 * can reach the ADM log long after it happened, and an hour measured from the
 * event would be spent before the ban ever reached the server.
 */
export async function hubTick(db: Database, opts: { now?: Date; batchSize?: number } = {}): Promise<HubTickResult> {
  const now = opts.now ?? new Date();
  const out: HubTickResult = { seeded: false, scanned: 0, banned: [] };

  // ⚠️ Forward-only. With no cursor row, start at the head: the log already
  // holds a week of Hub fighting from before the rule existed, and replaying it
  // would ban everyone in it. HUB_OFFENCE_MAX_AGE_MS is the backstop if the
  // row is ever lost after that; this is the primary defence.
  const [row] = await db.select({ n: consumerCursors.lastEventId }).from(consumerCursors).where(eq(consumerCursors.consumerName, HUB_CONSUMER));
  if (!row) {
    const [head] = await db.select({ n: sql<number>`coalesce(max(${events.id}), 0)::bigint` }).from(events);
    await writeCursor(db, HUB_CONSUMER, Number(head?.n ?? 0));
    return { ...out, seeded: true };
  }

  let cursor = row.n;
  const staleBefore = now.getTime() - HUB_OFFENCE_MAX_AGE_MS;
  for (;;) {
    const batch = await readEventBatch(db, cursor, opts.batchSize ?? 500);
    if (batch.length === 0) break;
    await db.transaction(async (tx) => {
      for (const ev of batch) {
        if (!WATCHED.includes(ev.type) || ev.occurredAt.getTime() < staleBefore) continue;
        const o = hubOffence(ev.type, ev.payload);
        if (!o) continue;
        out.scanned++;

        if (o.victim !== null) {
          // Self-defence: did the victim hit or kill the offender first? "First"
          // is (occurred_at, id): ⚠️ without the id tie-break a same-second
          // exchange makes each side the other's provocation and bans nobody.
          const [first] = await tx.select({ id: events.id }).from(events).where(and(
            eq(events.serverId, ev.serverId),
            inArray(events.type, ["player.hit", "player.killed"]),
            gte(events.occurredAt, new Date(ev.occurredAt.getTime() - HUB_RETALIATION_WINDOW_MS)),
            lte(events.occurredAt, ev.occurredAt),
            sql`(${events.occurredAt} < ${ev.occurredAt.toISOString()}::timestamptz or ${events.id} < ${ev.id})`,
            sql`${events.payload}->>'victimDayzId' = ${o.offender}`,
            sql`coalesce(${events.payload}->>'attackerDayzId', ${events.payload}->>'killerDayzId') = ${o.victim}`,
          )).limit(1);
          if (first) continue;
        }

        const [serving] = await tx.select({ id: bans.id }).from(bans).where(and(
          eq(bans.serverId, ev.serverId), eq(bans.dayzId, o.offender), eq(bans.reason, "hub_combat"), inArray(bans.status, ACTIVE),
        )).limit(1);
        if (serving) continue;

        await tx.insert(bans).values({
          serverId: ev.serverId, dayzId: o.offender, gamertag: o.gamertag,
          bannedAt: now, expiresAt: new Date(now.getTime() + HUB_BAN_MS),
          status: "pending", reason: "hub_combat",
        });
        out.banned.push({ dayzId: o.offender, gamertag: o.gamertag });
      }
      // ⚠️ Same transaction as the inserts: a crash re-reads the whole batch,
      // and the `serving` check above makes that re-read write nothing twice.
      await writeCursor(tx, HUB_CONSUMER, batch[batch.length - 1]!.id);
    });
    cursor = batch[batch.length - 1]!.id;
  }
  return out;
}
