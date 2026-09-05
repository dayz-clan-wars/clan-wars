import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { and, asc, eq, inArray } from "drizzle-orm";

export type Role = "leader" | "officer" | "member";

export type Viewer = {
  link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
  clan: { id: number; name: string; tag: string; texture: string; status: string; role: Role } | null;
};

/**
 * Who is looking (target spec §10.1). Everything the site renders for a
 * signed-in player hangs off this: `link` decides "linked", `clan` decides
 * "clan-level".
 *
 * ⚠️ Increment 2c adds `faction_members.status`; when it does, `clan` must
 * require `status = 'full'` — a pending member is not a clan-level viewer
 * (spec §10.1). Until then every roster row is a full member.
 */
export async function viewerForDb(db: Database, discordId: string): Promise<Viewer> {
  const [link] = await db.select({
    dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag, verifiedAt: identityLinks.verifiedAt,
  }).from(identityLinks).where(eq(identityLinks.discordId, discordId));

  // One clan per player per server; this deployment has one server. Ordered
  // so a second server would still give a deterministic answer.
  const [clan] = await db.select({
    id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture,
    status: factions.status, role: factionMembers.role,
  }).from(factionMembers)
    .innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES])))
    .orderBy(asc(factions.id))
    .limit(1);

  return {
    link: link ?? null,
    clan: clan ? { ...clan, role: clan.role as Role } : null,
  };
}
