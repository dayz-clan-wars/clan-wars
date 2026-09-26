import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { PlayerTexts } from "./registry.js";
import type { ClanWeek } from "./types.js";
import { rows, tsz } from "./sql.js";

/**
 * Every clan that was active or dormant AT WEEK END, under its CURRENT name and tag
 * only (spec §5.2) — so a clan that disbanded after the week ended still appears, and
 * a clan founded after the week ended does not. Week points come from
 * `raids.week_start`, the same key the week close scores on.
 *
 * ⚠️ `status`, `flagDown` and `members` are all as-of `weekEnd`, never today's row in
 * `factions`/`faction_members`. A run that is late — a re-generated past week, or a
 * script that simply runs a few hours after the week closed — must not describe a clan
 * using state that only became true after the week it is narrating ended.
 *
 * - `status` comes ONLY from `faction_events.kind`/`occurred_at`/`faction_id` — never
 *   `payload` (old clan names live there and must never leak, spec §5.2) and never
 *   `factions.status`, which is today's value. The latest status-changing event at or
 *   before `weekEnd` wins: `activated`/`revived` → active, `dormant` → dormant,
 *   `lapsed`/`disbanded` → those statuses. `founded` deliberately does not change status
 *   (a founded-but-not-yet-activated clan is `reserved`) and `renamed`/`rebound` don't
 *   either, so a clan with no such event by `weekEnd` resolves to no status and is
 *   dropped by the `active`/`dormant` filter below — the founded-after-week-end case.
 * - `flagDown` is true iff the clan's most recent raid at or before `weekEnd` (by
 *   `raids.first_lower_at`) has no `defenses.defended_at` and no `revived` event after
 *   that raid and at or before `weekEnd`. (No better source of flag-state history was
 *   found in the schema; `defenses` and the `revived` event are the two ways a
 *   flag-down clock is cleared per `factions.flag_down_since`'s own comment.)
 * - `members` counts `membership_history` spans open at `weekEnd`
 *   (`joined_at <= weekEnd and (left_at is null or left_at > weekEnd)`). That table is
 *   documented as full-membership spans only (written by the bot's membership
 *   reconciler, never for a pending member), so this already matches the current
 *   'full' semantics `faction_members.status = 'full'` used to enforce directly.
 */
export async function clansForWeek(db: Database, a: {
  serverId: number; seasonId: number; weekStart: Date; weekEnd: Date; staffTags: string[]; texts: PlayerTexts;
}): Promise<ClanWeek[]> {
  const w = tsz(a.weekStart);
  const we = tsz(a.weekEnd);
  const rs = await rows<{
    name: string; tag: string; status: "active" | "dormant" | "lapsed" | "disbanded" | null;
    pitch: string | null; flag_down: boolean; members: number;
    week_points: number; week_raids: number; times_raided: number; season_points: number; season_raids: number;
  }>(db, sql`
    select f.name, f.tag, f.pitch,
      (select case fe.kind
          when 'activated' then 'active'
          when 'revived' then 'active'
          when 'dormant' then 'dormant'
          when 'lapsed' then 'lapsed'
          when 'disbanded' then 'disbanded'
        end
       from faction_events fe
       where fe.faction_id = f.id and fe.occurred_at <= ${we}
         and fe.kind in ('activated', 'revived', 'dormant', 'lapsed', 'disbanded')
       order by fe.occurred_at desc, fe.id desc
       limit 1) as status,
      exists (
        select 1 from raids r3
        where r3.victim_faction_id = f.id and r3.first_lower_at <= ${we}
          and r3.first_lower_at = (
            select max(r4.first_lower_at) from raids r4
            where r4.victim_faction_id = f.id and r4.first_lower_at <= ${we})
          and not exists (
            select 1 from defenses d
            where d.faction_id = f.id and d.defended_at > r3.first_lower_at and d.defended_at <= ${we})
          and not exists (
            select 1 from faction_events fe2
            where fe2.faction_id = f.id and fe2.kind = 'revived'
              and fe2.occurred_at > r3.first_lower_at and fe2.occurred_at <= ${we})
      ) as flag_down,
      (select count(*)::int from membership_history mh
       where mh.faction_id = f.id and mh.joined_at <= ${we} and (mh.left_at is null or mh.left_at > ${we})) as members,
      (select coalesce(sum(r.points), 0)::int from raids r where r.raider_faction_id = f.id and r.week_start = ${w}) as week_points,
      (select count(*)::int from raids r where r.raider_faction_id = f.id and r.week_start = ${w}) as week_raids,
      (select count(*)::int from raids r where r.victim_faction_id = f.id and r.week_start = ${w}) as times_raided,
      coalesce(ss.points, 0)::int as season_points, coalesce(ss.raids, 0)::int as season_raids
    from factions f
    left join season_standings ss on ss.faction_id = f.id and ss.season_id = ${a.seasonId}
    where f.server_id = ${a.serverId}
    order by week_points desc, season_points desc, f.tag asc`);
  const staff = new Set(a.staffTags);
  return rs
    .filter((r): r is typeof r & { status: "active" | "dormant" } => r.status === "active" || r.status === "dormant")
    .map((r) => ({
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
