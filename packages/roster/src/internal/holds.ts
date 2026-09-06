import type { Tx } from "@factions/declarations";
import { factions, identityHolds } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

export type HoldReason = "renamed" | "disbanded";

/**
 * The identity namespace's own advisory lock (spec §4.4). Clan names have no
 * unique index — only the tag does (`factions_holding_tag_uniq`) — so two
 * concurrent renames or foundings racing for the same free NAME cannot be
 * serialised by a row lock the way two writers to one faction row can be.
 * Every writer that calls `identityTakenTx` takes this first, in the same
 * transaction, so the check-then-act is one unit against every other such
 * writer on the server.
 *
 * Advisory *xact* locks are re-entrant within a transaction and released
 * automatically at commit/rollback — nothing here ever unlocks by hand.
 *
 * Lock order (spec §4.12): this sits with `factions` at the head of the
 * order — taken right after the `factions` row lock in `rename`, and in
 * `reserve` right after the ceremony claim, before the `factions` insert.
 * Nothing takes it after any later table.
 */
export async function lockIdentity(tx: Tx, serverId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('identity'), ${serverId})`);
}

/**
 * Hold a clan's name and tag until season end (spec §4.4; guide ch. 8).
 *
 * `held_until` is `'infinity'` until the wipe script rewrites it to the
 * season's end (spec §8.5). Upsert: a value can be held again later by
 * another clan, and the newer hold wins. Written inside the transaction that
 * renames or disbands — right after the `factions` write, before anything
 * else (lock order §4.12: nothing references this table, so it needs no
 * place in the order beyond "after factions").
 */
export async function writeHoldsTx(tx: Tx, a: { serverId: number; factionId: number; name: string; tag: string; reason: HoldReason }): Promise<void> {
  const rows = [
    { serverId: a.serverId, kind: "name", valueLower: a.name.toLowerCase(), factionId: a.factionId, reason: a.reason, heldUntil: sql`'infinity'::timestamptz` },
    { serverId: a.serverId, kind: "tag", valueLower: a.tag.toLowerCase(), factionId: a.factionId, reason: a.reason, heldUntil: sql`'infinity'::timestamptz` },
  ];
  await tx.insert(identityHolds).values(rows).onConflictDoUpdate({
    target: [identityHolds.serverId, identityHolds.kind, identityHolds.valueLower],
    set: { factionId: sql`excluded.faction_id`, reason: sql`excluded.reason`, heldUntil: sql`excluded.held_until` },
  });
}

/**
 * Is this name or tag free on the server? Consults holding clans AND
 * unexpired holds (spec §4.4), case-insensitively. `exceptFactionId` lets a
 * clan keep or reclaim its own identity (a rename back to a name it held).
 *
 * ⚠️ Advisory for the tag: `factions_holding_tag_uniq` is the binding check
 * and the caller still maps its violation. Binding for the name and for
 * holds, which have no index of their own — which is why callers run this
 * INSIDE the writing transaction, after taking whatever row lock they take.
 */
export async function identityTakenTx(tx: Tx, a: { serverId: number; name: string; tag: string; exceptFactionId?: number }):
  Promise<"name-taken" | "tag-taken" | "name-held" | "tag-held" | null> {
  const others = a.exceptFactionId === undefined ? sql`true` : ne(factions.id, a.exceptFactionId);
  const [clan] = await tx.select({
    name: sql<boolean>`bool_or(lower(${factions.name}) = ${a.name.toLowerCase()})`,
    tag: sql<boolean>`bool_or(lower(${factions.tag}) = ${a.tag.toLowerCase()})`,
  }).from(factions).where(and(eq(factions.serverId, a.serverId), inArray(factions.status, [...HOLDING_STATUSES]), others));
  if (clan?.name) return "name-taken";
  if (clan?.tag) return "tag-taken";
  const heldBy = a.exceptFactionId === undefined ? sql`true` : ne(identityHolds.factionId, a.exceptFactionId);
  const [hold] = await tx.select({
    name: sql<boolean>`bool_or(${identityHolds.kind} = 'name' and ${identityHolds.valueLower} = ${a.name.toLowerCase()})`,
    tag: sql<boolean>`bool_or(${identityHolds.kind} = 'tag' and ${identityHolds.valueLower} = ${a.tag.toLowerCase()})`,
  }).from(identityHolds).where(and(eq(identityHolds.serverId, a.serverId), sql`${identityHolds.heldUntil} > now()`, heldBy));
  if (hold?.name) return "name-held";
  if (hold?.tag) return "tag-held";
  return null;
}
