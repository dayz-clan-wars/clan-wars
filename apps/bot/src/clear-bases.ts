import type { Database } from "@factions/db";
import { declarations, factions } from "@factions/db";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

export type ClearedBase = { owner: string; declaredAt: Date; x: number; z: number };
export type ClearBasesResult = { dryRun: boolean; released: ClearedBase[]; clansCleared: number };

/** Thrown to roll a dry run back after it has done (and counted) everything. */
class DryRun extends Error {
  constructor(readonly result: ClearBasesResult) { super("dry run"); }
}

/**
 * Release every base declared before `before` — the one-off for a map change
 * (Livonia → Chernarus, 2026-10-08), when old coordinates point at nothing on
 * the new map. The wipe keeps bases; this is the tool for when it should not.
 *
 * Each row goes through `releaseTx`, the path disband and unlink use, so this
 * adds no writer of `declarations` and sightings/zone incidents cascade as
 * they always do. A released clan's flag-down state is cleared like the
 * wipe's step (7): its base is gone, so a raid clock on it means nothing.
 * Rosters, statuses and Discord structure are untouched.
 *
 * Lock order §4.12: the server's `factions` rows FOR UPDATE, then
 * `lockDeclarations`, then `releaseTx` (declarations → poles).
 */
export async function clearBasesBefore(db: Database, serverId: number, before: Date, opts: { at: Date; dryRun: boolean }): Promise<ClearBasesResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: factions.id }).from(factions).where(eq(factions.serverId, serverId)).for("update");
      await lockDeclarations(tx, serverId);
      const rows = await tx.select({
        ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId, tag: factions.tag,
        declaredAt: declarations.declaredAt, x: declarations.x, z: declarations.z,
      }).from(declarations)
        .leftJoin(factions, eq(factions.id, declarations.ownerFactionId))
        .where(and(eq(declarations.serverId, serverId), lt(declarations.declaredAt, before)))
        .orderBy(asc(declarations.declaredAt));

      for (const r of rows) {
        await releaseTx(tx, r.ownerFactionId !== null ? { factionId: r.ownerFactionId } : { dayzId: r.ownerDayzId!, serverId }, opts.at);
      }
      const clanIds = rows.flatMap((r) => (r.ownerFactionId === null ? [] : [r.ownerFactionId]));
      const cleared = clanIds.length === 0 ? [] : await tx.update(factions)
        .set({ flagDownSince: null, flagDownByDayzId: null, disbandWarnedAt: null })
        .where(inArray(factions.id, clanIds))
        .returning({ id: factions.id });

      const result: ClearBasesResult = {
        dryRun: opts.dryRun,
        released: rows.map((r) => ({ owner: r.tag ?? r.ownerDayzId!, declaredAt: r.declaredAt, x: Number(r.x), z: Number(r.z) })),
        clansCleared: cleared.length,
      };
      if (opts.dryRun) throw new DryRun(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.result;
    throw err;
  }
}
