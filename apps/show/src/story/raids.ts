import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { PlayerTexts } from "./registry.js";
import type { RaidStory } from "./types.js";
import { rows, tsz, iso, whenLabel, UNKNOWN_PLAYER } from "./sql.js";

/**
 * Each raid this week, tagged online or offline (spec §5.3).
 *
 * ⚠️ Membership is read from `membership_history` AT THE INSTANT of the lower, never
 * from today's roster: a player who left the clan an hour earlier and was online is
 * not "the clan was home". The same holds for the first login after the raid.
 *
 * ⚠️ A defense counts for a raid only when it lands before the NEXT raid on the same
 * clan. Otherwise one late re-raise would be credited to every raid before it, and the
 * hosts would say a clan "got back in ten minutes" from a raid it never answered.
 *
 * ⚠️ "Re-raised" also means a revival: when a raided clan goes dormant and later comes
 * back, that instant is a `faction_events` row of kind 'revived', written when they
 * raised their flag again — no `defenses` row is ever written for it (spec §5.2
 * amendment). reraise_min is the EARLIEST of a matching defense or revival, subject to
 * the same next-raid bound above. Only `kind`, `occurred_at` and `faction_id` are read
 * from `faction_events`, never `payload` (spec §5.2).
 */
export async function raidsForWeek(db: Database, a: { serverId: number; weekStart: Date; texts: PlayerTexts }): Promise<RaidStory[]> {
  const w = tsz(a.weekStart);
  const rs = await rows<{
    at: string | Date; points: number; raider: string; raider_name: string | null; raider_tag: string | null;
    victim_name: string; victim_tag: string; victims_online: number; login_min: number | null; reraise_min: number | null;
  }>(db, sql`
    select r.first_lower_at as at, r.points,
      coalesce(p.gamertag, ${UNKNOWN_PLAYER}) as raider,
      rf.name as raider_name, rf.tag as raider_tag, vf.name as victim_name, vf.tag as victim_tag,
      (select count(distinct s.dayz_id)::int
         from player_sessions s
         join membership_history mh on mh.dayz_id = s.dayz_id and mh.faction_id = r.victim_faction_id
           and mh.joined_at <= r.first_lower_at and (mh.left_at is null or mh.left_at > r.first_lower_at)
        where s.server_id = r.server_id and s.connected_at <= r.first_lower_at
          and (s.disconnected_at is null or s.disconnected_at > r.first_lower_at)) as victims_online,
      (select round(extract(epoch from (min(s.connected_at) - r.first_lower_at)) / 60)::int
         from player_sessions s
         join membership_history mh on mh.dayz_id = s.dayz_id and mh.faction_id = r.victim_faction_id
           and mh.joined_at <= r.first_lower_at and (mh.left_at is null or mh.left_at > r.first_lower_at)
        where s.server_id = r.server_id and s.connected_at > r.first_lower_at) as login_min,
      (select case when back.at < coalesce(
            (select min(r2.first_lower_at) from raids r2
              where r2.victim_faction_id = r.victim_faction_id and r2.first_lower_at > r.first_lower_at),
            'infinity'::timestamptz)
          then round(extract(epoch from (back.at - r.first_lower_at)) / 60)::int end
         from (select least(
            (select min(d.defended_at) from defenses d
              where d.faction_id = r.victim_faction_id and d.defended_at > r.first_lower_at),
            (select min(fe.occurred_at) from faction_events fe
              where fe.faction_id = r.victim_faction_id and fe.kind = 'revived' and fe.occurred_at > r.first_lower_at)
          ) as at) as back) as reraise_min
    from raids r
    join factions vf on vf.id = r.victim_faction_id
    left join factions rf on rf.id = r.raider_faction_id
    left join players p on p.dayz_id = r.raider_dayz_id
    where r.server_id = ${a.serverId} and r.week_start = ${w}
    order by r.first_lower_at asc`);
  return rs.map((r) => {
    const online = r.victims_online > 0;
    return {
      at: iso(r.at),
      when: whenLabel(r.at),
      raider: a.texts.gamertag(r.raider),
      raiderClan: r.raider_name !== null && r.raider_tag !== null ? a.texts.clan(r.raider_name, r.raider_tag) : null,
      victimClan: a.texts.clan(r.victim_name, r.victim_tag),
      points: r.points,
      kind: online ? "online" : "offline",
      victimsOnline: r.victims_online,
      minutesUntilVictimLogin: online ? null : r.login_min,
      reRaisedAfterMinutes: r.reraise_min,
    };
  });
}
