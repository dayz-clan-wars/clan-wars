import { identityLinks, kothEvents, playerSessions, raidWindowSkips, type Database, type KothState } from "@factions/db";
import { kothBlockedByRaid } from "@factions/domain";
import { and, desc, eq, inArray, isNull, lt, max } from "drizzle-orm";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Q = Database | Tx;

/**
 * The states that hold a slot — `koth_events_slot_uq`'s predicate.
 * ⚠️ Two statements of one fact with that index; a `cancelled`/`failed` row frees
 * its slot (migration 0050), so it must not count here either.
 */
export const SLOT_HOLDING_STATES: readonly KothState[] = ["scheduled", "live", "awarded", "no_winner", "finished"];

/** What holds `slot`, if anything (spec §2.5: any KotH row in a slot-holding state). */
export async function slotTakenBy(db: Q, serverId: number, slot: Date): Promise<"koth" | null> {
  const [k] = await db.select({ id: kothEvents.id }).from(kothEvents).where(and(
    eq(kothEvents.serverId, serverId), eq(kothEvents.slotAt, slot), inArray(kothEvents.state, [...SLOT_HOLDING_STATES]),
  )).limit(1);
  return k ? "koth" : null;
}

export async function kothOpen(db: Q, serverId: number): Promise<boolean> {
  const [r] = await db.select({ id: kothEvents.id }).from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), inArray(kothEvents.state, ["scheduled", "live"]))).limit(1);
  return r !== undefined;
}

/** The last KotH that ran or will run, any origin (§2.2's gap). */
export async function lastKothSlot(db: Q, serverId: number, before: Date): Promise<Date | null> {
  const [r] = await db.select({ at: max(kothEvents.slotAt) }).from(kothEvents).where(and(
    eq(kothEvents.serverId, serverId), lt(kothEvents.slotAt, before), inArray(kothEvents.state, [...SLOT_HOLDING_STATES]),
  ));
  // ⚠️ drizzle's max() over a timestamp column can come back as a string — the
  // gap test (koth-decide-tick.test.ts, "holds the 24 h gap") catches a mismatch.
  return r?.at ? new Date(r.at) : null;
}

/**
 * Whether base damage is on for `slot`, skipped weekends read fresh every call.
 * ⚠️ Read from `raid_window_skips` whether or not RAID_WINDOW_TICK is set: the window
 * is the rule, and a KotH must never be the reason a weekend's bases are left alone.
 */
export async function raidOpenAt(db: Q, slot: Date): Promise<boolean> {
  const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason }).from(raidWindowSkips);
  return kothBlockedByRaid(slot, skips);
}

export async function recentTowns(db: Database, serverId: number): Promise<string[]> {
  const rs = await db.select({ location: kothEvents.location }).from(kothEvents)
    .where(eq(kothEvents.serverId, serverId)).orderBy(desc(kothEvents.createdAt)).limit(10);
  return rs.map((r) => r.location);
}

/**
 * Every linked player with an open session on the server — the electorate (§6.1).
 * ⚠️ `selectDistinct`: a player can hold two open session rows after a crash the
 * sessions tick has not closed yet, and a duplicate would count them twice.
 */
export async function linkedOnline(db: Database, serverId: number) {
  return db.selectDistinct({ discordId: identityLinks.discordId, dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag })
    .from(identityLinks).innerJoin(playerSessions, eq(playerSessions.dayzId, identityLinks.dayzId))
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)));
}
