import { factionMembers, factions, type Database } from "@factions/db";
import { armbandFor } from "@factions/domain";
import { and, eq } from "drizzle-orm";
import type { ArmbandAssignment } from "./init-c.js";

/**
 * Who wears which clan armband on this server, for the init.c lookup.
 *
 * ⚠️ `status = 'full'` only (spec §4.5, §14). A pending member has accepted but
 * has not been seen at the clan's base yet; handing them the colours would
 * publish a membership the game has not confirmed.
 *
 * ⚠️ No filter on `factions.status`. A membership row does not outlive its
 * faction's hold — lapsing and disbanding DELETE the roster — so every row here
 * already belongs to a live faction, and a dormant-but-holding clan keeps its
 * colours exactly as it keeps its map.
 *
 * A texture outside the claimable pool yields no armband rather than a derived
 * name: `armbandFor` returns null, and inventing `Armband_<anything>` would name
 * an item that does not exist, which is a script error at spawn time.
 */
export async function armbandAssignments(db: Database, serverId: number): Promise<ArmbandAssignment[]> {
  const rows = await db
    .select({ dayzId: factionMembers.dayzId, texture: factions.texture })
    .from(factionMembers)
    .innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.serverId, serverId), eq(factionMembers.status, "full")));

  const out: ArmbandAssignment[] = [];
  for (const r of rows) {
    const armband = armbandFor(r.texture);
    if (!armband) {
      console.warn(`armbands: ${r.dayzId} — no armband for texture ${JSON.stringify(r.texture)}`);
      continue;
    }
    out.push({ dayzId: r.dayzId, armband });
  }
  return out;
}
