import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { PlayerTexts } from "./registry.js";
import type { ClanWeek } from "./types.js";
import { rows, tsz } from "./sql.js";

/**
 * Every active or dormant clan, under its CURRENT name and tag only (spec §5.2).
 * Week points come from `raids.week_start`, the same key the week close scores on.
 */
export async function clansForWeek(db: Database, a: {
  serverId: number; seasonId: number; weekStart: Date; staffTags: string[]; texts: PlayerTexts;
}): Promise<ClanWeek[]> {
  const w = tsz(a.weekStart);
  const rs = await rows<{
    name: string; tag: string; status: "active" | "dormant"; pitch: string | null; flag_down: boolean; members: number;
    week_points: number; week_raids: number; times_raided: number; season_points: number; season_raids: number;
  }>(db, sql`
    select f.name, f.tag, f.status, f.pitch,
      (f.flag_down_since is not null) as flag_down,
      (select count(*)::int from faction_members m where m.faction_id = f.id and m.status = 'full') as members,
      (select coalesce(sum(r.points), 0)::int from raids r where r.raider_faction_id = f.id and r.week_start = ${w}) as week_points,
      (select count(*)::int from raids r where r.raider_faction_id = f.id and r.week_start = ${w}) as week_raids,
      (select count(*)::int from raids r where r.victim_faction_id = f.id and r.week_start = ${w}) as times_raided,
      coalesce(ss.points, 0)::int as season_points, coalesce(ss.raids, 0)::int as season_raids
    from factions f
    left join season_standings ss on ss.faction_id = f.id and ss.season_id = ${a.seasonId}
    where f.server_id = ${a.serverId} and f.status in ('active', 'dormant')
    order by week_points desc, season_points desc, f.tag asc`);
  const staff = new Set(a.staffTags);
  return rs.map((r) => ({
    ...a.texts.clan(r.name, r.tag),
    status: r.status,
    // ⚠️ By tag from config, never by name: a player can name a clan "The Admins".
    isStaff: staff.has(r.tag),
    pitch: r.pitch === null ? null : a.texts.pitch(r.pitch),
    members: r.members,
    weekPoints: r.week_points,
    weekRaids: r.week_raids,
    timesRaidedThisWeek: r.times_raided,
    seasonPoints: r.season_points,
    seasonRaids: r.season_raids,
    flagDown: r.flag_down,
  }));
}
