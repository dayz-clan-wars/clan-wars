import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { DeathCauseWord } from "@factions/domain";
import { scoringKill } from "@factions/roster/internal";
import type { PlayerTexts } from "./registry.js";
import type { ClanVsClan, FfPair, PlayerLine, StoryContext } from "./types.js";
import { rows, tsz, iso, whenLabel, UNKNOWN_PLAYER } from "./sql.js";

export type WeekRead = { serverId: number; from: Date; to: Date; texts: PlayerTexts };

/** Deaths worth a joke. `died` (cause unknown) and `bled_out` are not. */
const ODD_CAUSES = ["wolf", "bear", "animal", "mauled", "drowned", "fall", "dehydration", "starvation", "vehicle", "explosion"] satisfies readonly DeathCauseWord[];

/**
 * Each player's clan DURING the week, for the tag beside their name: the latest
 * `membership_history` span (full membership only) that overlaps the week.
 *
 * ⚠️ Never today's `faction_members`: a past week's episode would pin players to clans
 * that did not exist yet (week 1 showed SNA and ADM tags before either was founded).
 */
const weekClan = (a: WeekRead): SQL => sql`
  select distinct on (mh.dayz_id) mh.dayz_id, f.name, f.tag
  from membership_history mh join factions f on f.id = mh.faction_id
  where mh.server_id = ${a.serverId} and mh.joined_at < ${tsz(a.to)} and (mh.left_at is null or mh.left_at > ${tsz(a.from)})
  order by mh.dayz_id, mh.joined_at desc`;

// ⚠️ `scoringKill` renders against the unaliased `kills` table. Every query that uses
// it reads `from kills` with no alias, or the predicate names a table that is not there.
const inWeek = (a: WeekRead): SQL =>
  sql`kills.server_id = ${a.serverId} and kills.occurred_at >= ${tsz(a.from)} and kills.occurred_at < ${tsz(a.to)}`;

type LineRow = { gamertag: string; clan_name: string | null; clan_tag: string | null; value: number };
const line = (texts: PlayerTexts, r: LineRow): PlayerLine => ({
  gamertag: texts.gamertag(r.gamertag),
  clan: r.clan_name !== null && r.clan_tag !== null ? texts.clan(r.clan_name, r.clan_tag) : null,
  value: r.value,
});

export async function peopleForWeek(db: Database, a: WeekRead): Promise<StoryContext["players"]> {
  const board = (col: SQL) => rows<LineRow>(db, sql`
    with cur as (${weekClan(a)})
    select coalesce(p.gamertag, ${UNKNOWN_PLAYER}) as gamertag, cur.name as clan_name, cur.tag as clan_tag, count(*)::int as value
    from kills
    left join players p on p.dayz_id = ${col}
    left join cur on cur.dayz_id = ${col}
    where ${inWeek(a)} and ${scoringKill}
    group by 1, 2, 3 order by value desc, gamertag asc limit 5`);
  const [killers, deaths, shots, odd] = await Promise.all([
    board(sql`kills.killer_dayz_id`),
    board(sql`kills.victim_dayz_id`),
    rows<{ gamertag: string; clan_name: string | null; clan_tag: string | null; victim: string; metres: number; weapon: string | null }>(db, sql`
      with cur as (${weekClan(a)})
      select coalesce(pk.gamertag, ${UNKNOWN_PLAYER}) as gamertag, cur.name as clan_name, cur.tag as clan_tag,
        coalesce(pv.gamertag, ${UNKNOWN_PLAYER}) as victim, kills.distance_m::float8 as metres, kills.weapon
      from kills
      left join players pk on pk.dayz_id = kills.killer_dayz_id
      left join players pv on pv.dayz_id = kills.victim_dayz_id
      left join cur on cur.dayz_id = kills.killer_dayz_id
      where ${inWeek(a)} and ${scoringKill} and kills.distance_m is not null
      order by kills.distance_m desc limit 3`),
    rows<{ gamertag: string; cause: string; at: string | Date }>(db, sql`
      select coalesce(p.gamertag, ${UNKNOWN_PLAYER}) as gamertag, kills.cause, kills.occurred_at as at
      from kills left join players p on p.dayz_id = kills.victim_dayz_id
      where ${inWeek(a)} and kills.cause in (${sql.join(ODD_CAUSES.map((c) => sql`${c}`), sql`, `)})
      order by kills.occurred_at asc limit 10`),
  ]);
  return {
    topKillers: killers.map((r) => line(a.texts, r)),
    mostDeaths: deaths.map((r) => line(a.texts, r)),
    longestShots: shots.map((r) => ({
      gamertag: a.texts.gamertag(r.gamertag),
      clan: r.clan_name !== null && r.clan_tag !== null ? a.texts.clan(r.clan_name, r.clan_tag) : null,
      victim: a.texts.gamertag(r.victim),
      metres: Math.round(r.metres),
      weapon: r.weapon,
    })),
    oddDeaths: odd.map((r) => ({ gamertag: a.texts.gamertag(r.gamertag), cause: r.cause, at: iso(r.at), when: whenLabel(r.at) })),
  };
}

/**
 * Clan-mates killing clan-mates. Reads `friendly_fire` directly because it counts
 * exactly what `scoringKill` excludes (the friendly-fire board does the same). Hub
 * kills are left out here too: they are not fights.
 */
export async function friendlyFireForWeek(db: Database, a: WeekRead): Promise<FfPair[]> {
  const rs = await rows<{ clan_name: string; clan_tag: string; killer: string; victim: string; n: number; weapons: string[] | null; first: string | Date; last: string | Date }>(db, sql`
    select f.name as clan_name, f.tag as clan_tag,
      coalesce(pk.gamertag, ${UNKNOWN_PLAYER}) as killer, coalesce(pv.gamertag, ${UNKNOWN_PLAYER}) as victim,
      count(*)::int as n,
      array_agg(distinct kills.weapon) filter (where kills.weapon is not null) as weapons,
      min(kills.occurred_at) as first, max(kills.occurred_at) as last
    from kills
    join factions f on f.id = kills.killer_faction_id
    left join players pk on pk.dayz_id = kills.killer_dayz_id
    left join players pv on pv.dayz_id = kills.victim_dayz_id
    where ${inWeek(a)} and kills.friendly_fire and not kills.at_hub and kills.killer_dayz_id <> kills.victim_dayz_id
    group by 1, 2, 3, 4 order by n desc, killer asc limit 12`);
  return rs.map((r) => ({
    clan: a.texts.clan(r.clan_name, r.clan_tag),
    killer: a.texts.gamertag(r.killer),
    victim: a.texts.gamertag(r.victim),
    count: r.n,
    weapons: [...(r.weapons ?? [])].sort(),
    first: iso(r.first),
    firstWhen: whenLabel(r.first),
    last: iso(r.last),
    lastWhen: whenLabel(r.last),
  }));
}

export async function clanBeefsForWeek(db: Database, a: WeekRead): Promise<ClanVsClan[]> {
  const rs = await rows<{ kn: string; kt: string; vn: string; vt: string; n: number }>(db, sql`
    select kf.name as kn, kf.tag as kt, vf.name as vn, vf.tag as vt, count(*)::int as n
    from kills
    join factions kf on kf.id = kills.killer_faction_id
    join factions vf on vf.id = kills.victim_faction_id
    where ${inWeek(a)} and ${scoringKill} and kills.killer_faction_id <> kills.victim_faction_id
    group by 1, 2, 3, 4 order by n desc, kt asc limit 6`);
  return rs.map((r) => ({ killerClan: a.texts.clan(r.kn, r.kt), victimClan: a.texts.clan(r.vn, r.vt), kills: r.n }));
}
