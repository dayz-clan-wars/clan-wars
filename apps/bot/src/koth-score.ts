import { events, identityLinks, kills, kothEvents, players, serverRestarts, type Database, type KothResults } from "@factions/db";
import {
  KOTH_SCORE_SETTLE_MS, RESTART_PERIOD_MS, inKothZone, kothLocation, kothStandings, kothWinner,
  readVec3, type KothKill,
} from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { grantAwardTx, scoringKill } from "@factions/roster/internal";
import { readCursor } from "@factions/event-log";
import { and, eq, gt, gte, lt, max, sql } from "drizzle-orm";
import { KILLS_CONSUMER } from "./kills-tick.js";

type KothRow = typeof kothEvents.$inferSelect;
/** The transaction handle drizzle hands to `db.transaction` — read-only helpers below
 * accept either so they can run inside `scoreAndAward`'s own transaction without a cast. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

/** When the restart for `slot` was actually issued, or undefined if it was not (yet) restarted. */
async function issuedAt(db: Db, serverId: number, slot: Date): Promise<Date | undefined> {
  return (await db.select({ issuedAt: serverRestarts.issuedAt }).from(serverRestarts).where(and(
    eq(serverRestarts.serverId, serverId), eq(serverRestarts.scheduledFor, slot), eq(serverRestarts.outcome, "restarted"),
  )).limit(1))[0]?.issuedAt;
}

/**
 * Where a session's window starts: the opening restart's issue time, else the slot.
 * ⚠️ One statement, used by the final score AND `/koth status`'s live standings —
 * two spellings would let the standings a player saw disagree with the result.
 */
export async function kothOpenedAt(db: Db, row: KothRow): Promise<Date> {
  return (await issuedAt(db, row.serverId, row.slotAt)) ?? row.slotAt;
}

/** The opening and closing restarts' actual issue times (spec §2.9). */
export async function kothWindow(db: Db, row: KothRow): Promise<{ from: Date; to: Date }> {
  const end = new Date(row.slotAt.getTime() + RESTART_PERIOD_MS);
  return { from: await kothOpenedAt(db, row), to: (await issuedAt(db, row.serverId, end)) ?? end };
}

/**
 * ⚠️ Both conditions, never one (spec §6): the settle time covers log lag, and the
 * cursor test covers a bot that is catching up — without it a restart after
 * downtime scores a half-ingested window and crowns the wrong player, for good.
 */
export async function scoringReady(db: Database, row: KothRow, now: Date): Promise<boolean> {
  const { to } = await kothWindow(db, row);
  if (now.getTime() < to.getTime() + KOTH_SCORE_SETTLE_MS) return false;
  const [past] = await db.select({ id: events.id }).from(events)
    .where(and(eq(events.serverId, row.serverId), gt(events.occurredAt, to))).limit(1);
  if (!past) return false;               // ingest has not yet seen anything after the window
  const [last] = await db.select({ id: max(events.id) }).from(events)
    .where(and(eq(events.serverId, row.serverId), lt(events.occurredAt, to)));
  return (last?.id ?? 0) <= await readCursor(db, KILLS_CONSUMER);
}

/** The window's scoring kills whose victim was on the hill, and how many could not be placed. */
export async function kothKills(db: Db, row: KothRow, w: { from: Date; to: Date }): Promise<{ kills: KothKill[]; dropped: number }> {
  const rows = await db.select({
    killer: kills.killerDayzId, occurredAt: kills.occurredAt, payload: events.payload,
    gamertag: sql<string>`coalesce(${players.gamertag}, ${kills.killerDayzId})`,
  }).from(kills)
    .innerJoin(events, eq(events.id, kills.eventId))
    .leftJoin(players, eq(players.dayzId, kills.killerDayzId))
    .where(and(eq(kills.serverId, row.serverId), scoringKill, gte(kills.occurredAt, w.from), lt(kills.occurredAt, w.to)));
  const centre = { x: Number(row.centreX), z: Number(row.centreZ) };
  const out: KothKill[] = [];
  let dropped = 0;
  for (const r of rows) {
    const pos = readVec3((r.payload as Record<string, unknown>)?.victimPos);
    if (pos === null) { dropped += 1; continue; }
    if (inKothZone(pos, centre)) out.push({ killerDayzId: r.killer!, gamertag: r.gamertag, occurredAt: r.occurredAt });
  }
  return { kills: out, dropped };
}

/**
 * Score a live row and grant its prize, in ONE transaction that locks the row
 * first — that lock is the whole idempotency guard: two passes racing after a
 * crash grant exactly one award (lock order koth_events → award_grants →
 * clan_notices). The results are frozen here and never recomputed.
 *
 * No prize (`award_key` null): the top killer wins outright — being linked only
 * matters when there is something to DM — and the row is `finished`.
 */
export async function scoreAndAward(db: Database, rowId: number, opts: { now: Date; siteBaseUrl: string }): Promise<"awarded" | "no_winner" | "finished" | "skipped"> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(kothEvents).where(eq(kothEvents.id, rowId)).for("update");
    if (!row || row.state !== "live") return "skipped";
    const w = await kothWindow(tx, row);
    const { kills: ks, dropped } = await kothKills(tx, row, w);
    const standings = kothStandings(ks);
    const linked = new Map((await tx.select({ dayzId: identityLinks.dayzId, discordId: identityLinks.discordId }).from(identityLinks))
      .map((l) => [l.dayzId, l.discordId]));
    const winner = row.awardKey === null ? standings[0] ?? null : kothWinner(standings, (id) => linked.has(id));
    const slim = (s: { dayzId: string; gamertag: string; kills: number }) => ({ dayzId: s.dayzId, gamertag: s.gamertag, kills: s.kills });
    const results: KothResults = {
      top: standings.slice(0, 5).map(slim), topKiller: standings[0] ? slim(standings[0]) : null,
      winner: winner ? slim(winner) : null, droppedNoPosition: dropped,
    };
    if (!winner) {
      await tx.update(kothEvents).set({ state: "no_winner", results }).where(eq(kothEvents.id, row.id));
      return "no_winner";
    }
    // ⚠️ A prize the catalogue lost after scheduling is `finished` with a failure for
    // ops, never a throw: grantAwardTx would refuse it on every tick forever, and the
    // results post (naming the winner, and that an admin will grant it) would never go out.
    if (row.awardKey === null || !awardsCatalogue()[row.awardKey]) {
      const detail = row.awardKey === null ? row.detail
        : { ...row.detail, failure: `award "${row.awardKey}" is no longer in awards.json — grant it by hand with /award grant` };
      await tx.update(kothEvents).set({ state: "finished", results, winnerDayzId: winner.dayzId, detail }).where(eq(kothEvents.id, row.id));
      return "finished";
    }
    const town = kothLocation(row.location)?.name ?? row.location;
    const g = await grantAwardTx(tx, {
      // ⚠️ Non-null: an `auto` row (the only origin with a null scheduler) never reaches
      // an `awarded` state yet — the trigger that would create one lands in a later task.
      awardKey: row.awardKey, winnerDiscordId: linked.get(winner.dayzId)!, grantedByDiscordId: row.scheduledByDiscordId!,
      reason: `King of the Hill — ${town}, ${row.slotAt.toISOString().slice(0, 10)}`, siteBaseUrl: opts.siteBaseUrl,
      now: opts.now, serverId: row.serverId,
    });
    // ⚠️ Throw, never "succeed" without a grant: the rollback leaves the row live and the next tick retries.
    if (!g.ok) throw new Error(`koth: award grant refused (${g.reason})`);
    await tx.update(kothEvents).set({ state: "awarded", results, winnerDayzId: winner.dayzId, awardGrantId: g.grantId })
      .where(eq(kothEvents.id, row.id));
    return "awarded";
  });
}
