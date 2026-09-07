import type { Database } from "@factions/db";
import { defenses, factions, raids, seasonStandings } from "@factions/db";
import { ALPHAS_PER_WEEK } from "@factions/domain";
import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type StandingRow = {
  factionId: number; name: string; tag: string; texture: string; status: string; activatedAt: Date | null;
  points: number; raids: number; timesRaided: number; defenses: number;
};

/**
 * Every standings row of the season, in spec §8.1 order (points desc,
 * times_raided asc, activated_at asc), with `factions.id asc` appended as the
 * final tie-break so two clans equal on all three read back in the same order
 * every time. Not filtered by status or points — callers slice what they need.
 */
export async function seasonTable(db: Database | Tx, seasonId: number): Promise<StandingRow[]> {
  return db.select({
    factionId: seasonStandings.factionId,
    name: factions.name,
    tag: factions.tag,
    texture: factions.texture,
    status: factions.status,
    activatedAt: factions.activatedAt,
    points: seasonStandings.points,
    raids: seasonStandings.raids,
    timesRaided: seasonStandings.timesRaided,
    defenses: seasonStandings.defenses,
  }).from(seasonStandings)
    .innerJoin(factions, eq(factions.id, seasonStandings.factionId))
    .where(eq(seasonStandings.seasonId, seasonId))
    .orderBy(desc(seasonStandings.points), asc(seasonStandings.timesRaided), asc(factions.activatedAt), asc(factions.id));
}

/**
 * Spec §8.1's "ranked": active clans with points > 0 this season, in order.
 * `rankOf` is 1-based, or null when the faction is not in `ranked` (dormant,
 * lapsed, disbanded, reserved, or active with no points yet).
 */
export async function rankedStandings(db: Database | Tx, seasonId: number): Promise<{ ranked: StandingRow[]; rankOf: (factionId: number) => number | null }> {
  const all = await seasonTable(db, seasonId);
  const ranked = all.filter((r) => r.status === "active" && r.points > 0);
  const rankOf = (factionId: number): number | null => {
    const idx = ranked.findIndex((r) => r.factionId === factionId);
    return idx === -1 ? null : idx + 1;
  };
  return { ranked, rankOf };
}

/**
 * The top `ALPHAS_PER_WEEK` clans by `sum(raids.points)` for the given week
 * (spec §4.8, §7), ties broken by §8.1 order (using each clan's season
 * `times_raided` and `activated_at`, then `factions.id` as the final
 * deterministic tie-break, not anything week-scoped). Only sums
 * greater than zero count — a week of solo raids (0 points each) or no raids
 * at all crowns nobody.
 */
export async function weekTopThree(db: Database | Tx, seasonId: number, weekStart: Date): Promise<{ factionId: number; name: string; tag: string; texture: string; points: number }[]> {
  const weekPoints = sql<number>`sum(${raids.points})`;
  const timesRaided = sql<number>`coalesce(${seasonStandings.timesRaided}, 0)`;
  const rows = await db.select({
    factionId: raids.raiderFactionId,
    name: factions.name,
    tag: factions.tag,
    texture: factions.texture,
    points: weekPoints.mapWith(Number),
  }).from(raids)
    .innerJoin(factions, eq(factions.id, raids.raiderFactionId))
    .leftJoin(seasonStandings, and(eq(seasonStandings.seasonId, raids.seasonId), eq(seasonStandings.factionId, raids.raiderFactionId)))
    .where(and(eq(raids.seasonId, seasonId), eq(raids.weekStart, weekStart)))
    .groupBy(raids.raiderFactionId, factions.id, factions.name, factions.tag, factions.texture, factions.activatedAt, seasonStandings.timesRaided)
    .having(sql`${weekPoints} > 0`)
    .orderBy(desc(weekPoints), asc(timesRaided), asc(factions.activatedAt), asc(factions.id))
    .limit(ALPHAS_PER_WEEK);
  return rows.map((r) => ({ factionId: r.factionId!, name: r.name, tag: r.tag, texture: r.texture, points: r.points }));
}

/**
 * Recompute `season_standings` from `raids` + `defenses` — the drift check
 * spec §13 requires between the incrementally-maintained table and its
 * source of truth. Runs in one transaction: locks the season's existing rows
 * FOR UPDATE first (so a rebuild can't race a raid/defense tick's own
 * `season_standings` writes), computes the whole aggregate in one statement
 * (a full outer join of the raiders' aggregate, the victims' aggregate, and
 * the defenses aggregate, on faction_id), upserts every computed row, then
 * deletes any of the season's rows not backed by the computed set — a
 * faction with no raid or defense on record has no reason to have a row.
 * Returns the rebuilt row count.
 */
export async function rebuildStandings(db: Database, seasonId: number): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock first, per §4.12's documented order — a rebuild takes the same
    // lock a raid/defense tick takes before it touches `season_standings`.
    await tx.select({ id: seasonStandings.id }).from(seasonStandings)
      .where(eq(seasonStandings.seasonId, seasonId))
      .for("update", { of: seasonStandings });

    const computed = await tx.execute(sql`
      with raider as (
        select raider_faction_id as faction_id, sum(points)::int as points, count(*)::int as raids
        from raids where season_id = ${seasonId} and raider_faction_id is not null
        group by raider_faction_id
      ),
      victim as (
        select victim_faction_id as faction_id, count(*)::int as times_raided
        from raids where season_id = ${seasonId}
        group by victim_faction_id
      ),
      defense as (
        select faction_id, count(*)::int as defenses
        from defenses where season_id = ${seasonId}
        group by faction_id
      )
      select
        coalesce(raider.faction_id, victim.faction_id, defense.faction_id)::int as faction_id,
        coalesce(raider.points, 0) as points,
        coalesce(raider.raids, 0) as raids,
        coalesce(victim.times_raided, 0) as times_raided,
        coalesce(defense.defenses, 0) as defenses
      from raider
      full outer join victim on victim.faction_id = raider.faction_id
      full outer join defense on defense.faction_id = coalesce(raider.faction_id, victim.faction_id)
    `);
    const rows = computed as unknown as { faction_id: number; points: number; raids: number; times_raided: number; defenses: number }[];

    for (const r of rows) {
      await tx.insert(seasonStandings).values({
        seasonId, factionId: r.faction_id, points: r.points, raids: r.raids, timesRaided: r.times_raided, defenses: r.defenses,
      }).onConflictDoUpdate({
        target: [seasonStandings.seasonId, seasonStandings.factionId],
        set: { points: r.points, raids: r.raids, timesRaided: r.times_raided, defenses: r.defenses },
      });
    }

    const keep = rows.map((r) => r.faction_id);
    await tx.delete(seasonStandings).where(
      keep.length > 0
        ? and(eq(seasonStandings.seasonId, seasonId), notInArray(seasonStandings.factionId, keep))
        : eq(seasonStandings.seasonId, seasonId),
    );

    return rows.length;
  });
}
