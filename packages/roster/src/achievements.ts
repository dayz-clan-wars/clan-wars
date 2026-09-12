import type { Database } from "@factions/db";
import { achievementProgress, achievementUnlocks, factions, identityLinks, membershipHistory, players } from "@factions/db";
import { ACHIEVEMENTS, type AchievementGroup, type AchievementKey, type AchievementOwner, type AchievementUnit } from "@factions/domain";
import { and, eq, sql } from "drizzle-orm";

export type AchievementTile = {
  key: AchievementKey; name: string; description: string; group: AchievementGroup; owner: AchievementOwner; target: number; unit: AchievementUnit;
  earnedAt: Date | null; count: number;
  /** On a player's wall, the clan a team tile was earned with. */
  clanTag: string | null;
};
export type AchievementWall = { tiles: AchievementTile[]; earned: number; closest: AchievementTile[] };
export type AchievementSubject = { gamertag: string } | { clanTag: string };

/**
 * The wall (spec 2026-09-11 §8). A player's wall carries every player tile plus the team
 * tiles of clans they were a FULL member of at the moment the clan earned them — resolved
 * through membership_history, so later joins and leaves cannot edit the record. A clan's
 * wall is the 12 team tiles. Progress comes from the tick's cache, never recomputed here.
 */
export async function achievementsForDb(db: Database, subject: AchievementSubject, now: Date): Promise<AchievementWall | null> {
  if ("clanTag" in subject) {
    const [f] = await db.select({ id: factions.id, tag: factions.tag }).from(factions).where(sql`lower(${factions.tag}) = lower(${subject.clanTag})`);
    if (!f) return null;
    return wallFor(db, { kind: "clan", id: String(f.id) }, [], now);
  }
  const [p] = await db.select({ dayzId: players.dayzId }).from(players).where(sql`lower(${players.gamertag}) = lower(${subject.gamertag})`);
  const [l] = p ? [] : await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(sql`lower(${identityLinks.gamertag}) = lower(${subject.gamertag})`);
  const dayzId = p?.dayzId ?? l?.dayzId;
  if (!dayzId) return null;
  // Team unlocks the player shared: clan unlock rows whose earned_at falls inside one of the player's spans in that clan.
  const shared = await db.select({ key: achievementUnlocks.key, earnedAt: achievementUnlocks.earnedAt, tag: factions.tag })
    .from(achievementUnlocks)
    .innerJoin(membershipHistory, and(eq(membershipHistory.dayzId, dayzId), sql`${membershipHistory.factionId}::text = ${achievementUnlocks.ownerId}`,
      sql`${membershipHistory.joinedAt} <= ${achievementUnlocks.earnedAt}`, sql`(${membershipHistory.leftAt} is null or ${achievementUnlocks.earnedAt} < ${membershipHistory.leftAt})`))
    .innerJoin(factions, eq(factions.id, membershipHistory.factionId))
    .where(eq(achievementUnlocks.ownerKind, "clan"));
  return wallFor(db, { kind: "player", id: dayzId }, shared, now);
}

async function wallFor(db: Database, owner: { kind: AchievementOwner; id: string }, shared: { key: string; earnedAt: Date; tag: string }[], _now: Date): Promise<AchievementWall> {
  const own = await db.select({ key: achievementUnlocks.key, earnedAt: achievementUnlocks.earnedAt }).from(achievementUnlocks)
    .where(and(eq(achievementUnlocks.ownerKind, owner.kind), eq(achievementUnlocks.ownerId, owner.id)));
  const progress = await db.select({ key: achievementProgress.key, count: achievementProgress.count }).from(achievementProgress)
    .where(and(eq(achievementProgress.ownerKind, owner.kind), eq(achievementProgress.ownerId, owner.id)));
  const earnedBy = new Map(own.map((u) => [u.key, { at: u.earnedAt, tag: null as string | null }]));
  for (const s of shared) { const cur = earnedBy.get(s.key); if (!cur || s.earnedAt < cur.at) earnedBy.set(s.key, { at: s.earnedAt, tag: s.tag }); }
  const countBy = new Map(progress.map((p) => [p.key, p.count]));
  const tiles: AchievementTile[] = ACHIEVEMENTS
    .filter((a) => owner.kind === "player" || a.owner === "clan")
    .map((a) => {
      const e = earnedBy.get(a.key);
      // The tick's cached progress count is capped at the target once earned (nth()'s
      // ruling) — set it here too so an earned tile never shows a stale under-target count.
      return { key: a.key, name: a.name, description: a.description, group: a.group, owner: a.owner, target: a.target, unit: a.unit,
        earnedAt: e?.at ?? null, count: e ? a.target : (countBy.get(a.key) ?? 0), clanTag: e?.tag ?? null };
    });
  const closest = owner.kind === "player"
    ? tiles.filter((t) => !t.earnedAt && t.target > 1 && t.count > 0).sort((x, y) => y.count / y.target - x.count / x.target).slice(0, 3)
    : [];
  return { tiles, earned: tiles.filter((t) => t.earnedAt).length, closest };
}
