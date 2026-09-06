import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks } from "@factions/db";
import { HOLDING_STATUSES, type MemberStatus } from "@factions/domain";
import type { Role } from "./internal";
import { and, asc, eq, inArray } from "drizzle-orm";

export type Actor = { discordId: string; dayzId: string; gamertag: string; factionId: number; serverId: number; role: Role; status: MemberStatus };
export type ActorRefusal = "not-linked" | "not-in-clan" | "pending";

/**
 * Who is acting, and on which clan. The site never names a faction id for a
 * write on the actor's own clan — it is derived here from their link and
 * roster row, so a forged id in a form cannot act on someone else's clan.
 * A pending member is "pending": they may leave or decline, nothing else.
 */
export async function actorFor(db: Database, discordId: string): Promise<Actor | ActorRefusal> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  const [m] = await db.select({ factionId: factionMembers.factionId, serverId: factionMembers.serverId, role: factionMembers.role, status: factionMembers.status })
    .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES]))).orderBy(asc(factions.id)).limit(1);
  if (!m) return "not-in-clan";
  if (m.status === "pending") return "pending";
  return { discordId, ...link, factionId: m.factionId, serverId: m.serverId, role: m.role as Role, status: m.status as MemberStatus };
}
export const isRefusal = (a: Actor | ActorRefusal): a is ActorRefusal => typeof a === "string";
