import type { Database } from "@factions/db";
import { declarations, factionMembers } from "@factions/db";
import { distance2d, WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { and, eq, inArray } from "drizzle-orm";

/** The transaction handle drizzle hands to `db.transaction`. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Zone = {
  declarationId: number; x: number; z: number;
  ownerFactionId: number | null; ownerDayzId: string | null;
  /** Full members of the owning clan; empty for a solo base. */
  fullMemberIds: Set<string>;
};

/** Every declaration on the server with its full roster — one read per batch, like presence-tick. */
export async function zonesFor(db: Database | Tx, serverId: number): Promise<Zone[]> {
  const decls = await db.select({ id: declarations.id, x: declarations.x, z: declarations.z, ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId })
    .from(declarations).where(eq(declarations.serverId, serverId));
  const factionIds = decls.map((d) => d.ownerFactionId).filter((v): v is number => v !== null);
  const members = factionIds.length === 0 ? [] : await db.select({ factionId: factionMembers.factionId, dayzId: factionMembers.dayzId })
    .from(factionMembers).where(and(inArray(factionMembers.factionId, factionIds), eq(factionMembers.status, "full")));
  const byFaction = new Map<number, Set<string>>();
  for (const m of members) (byFaction.get(m.factionId) ?? byFaction.set(m.factionId, new Set()).get(m.factionId)!).add(m.dayzId);
  return decls.map((d) => ({
    declarationId: d.id, x: Number(d.x), z: Number(d.z), ownerFactionId: d.ownerFactionId, ownerDayzId: d.ownerDayzId,
    fullMemberIds: d.ownerFactionId === null ? new Set() : (byFaction.get(d.ownerFactionId) ?? new Set()),
  }));
}

/** The zone a fix falls inside (declarations are ≥ 200 m apart, so at most one), with the whole-metre distance. */
export function zoneContaining(zones: readonly Zone[], fix: { x: number; z: number }): { zone: Zone; distanceM: number } | null {
  for (const zone of zones) {
    const d = distance2d(fix, zone);
    if (d <= WATCH_ZONE_RADIUS_M) return { zone, distanceM: Math.round(d) };
  }
  return null;
}

/** A full member of the owning clan, or the solo owner. Everyone else — pending, guest, stranger — is a non-member. */
export function isMemberOf(zone: Zone, dayzId: string): boolean {
  return zone.ownerDayzId === dayzId || zone.fullMemberIds.has(dayzId);
}
