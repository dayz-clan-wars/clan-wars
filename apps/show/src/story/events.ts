import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { WeekRead } from "./people.js";
import type { AirdropStory, BountyStory, FlagEvent, FlagEventKind, KothStory } from "./types.js";
import { rows, tsz, iso, UNKNOWN_PLAYER } from "./sql.js";

const FLAG_KINDS: FlagEventKind[] = ["founded", "activated", "dormant", "revived", "disbanded"];
const between = (col: string, a: WeekRead) =>
  sql`${sql.raw(col)} >= ${tsz(a.from)} and ${sql.raw(col)} < ${tsz(a.to)}`;

/**
 * ⚠️ Reads ONLY `kind` and `occurred_at` from `faction_events`, and names the clan by
 * its CURRENT `factions` row. The payloads keep every name a clan ever had, including
 * one an admin made a clan change (spec §5.2). Never select `payload` here, and never
 * add `renamed` or `rebound` to FLAG_KINDS: a rename is a story about the old name.
 */
export async function flagEventsForWeek(db: Database, a: WeekRead): Promise<FlagEvent[]> {
  const rs = await rows<{ kind: FlagEventKind; at: string | Date; name: string; tag: string }>(db, sql`
    select fe.kind, fe.occurred_at as at, f.name, f.tag
    from faction_events fe join factions f on f.id = fe.faction_id
    where fe.server_id = ${a.serverId} and ${between("fe.occurred_at", a)}
      and fe.kind in (${sql.join(FLAG_KINDS.map((k) => sql`${k}`), sql`, `)})
    order by fe.occurred_at asc, fe.id asc`);
  return rs.map((r) => ({ clan: a.texts.clan(r.name, r.tag), kind: r.kind, at: iso(r.at) }));
}

export async function bountiesForWeek(db: Database, a: WeekRead): Promise<BountyStory[]> {
  const rs = await rows<{
    target: string; reason: string; placed_at: string | Date; status: BountyStory["status"];
    claimer: string | null; hours: number | null; metres: number | null;
  }>(db, sql`
    select coalesce(pt.gamertag, ${UNKNOWN_PLAYER}) as target, b.reason, b.placed_at, b.status,
      case when b.claimed_by_dayz_id is null then null else coalesce(pc.gamertag, ${UNKNOWN_PLAYER}) end as claimer,
      case when b.claimed_at is null then null
        else round((extract(epoch from (b.claimed_at - b.placed_at)) / 3600)::numeric, 1)::float8 end as hours,
      (select round(k.distance_m)::int from kills k where k.event_id = b.claim_event_id limit 1) as metres
    from bounties b
    left join players pt on pt.dayz_id = b.target_dayz_id
    left join players pc on pc.dayz_id = b.claimed_by_dayz_id
    where b.server_id = ${a.serverId} and (${between("b.placed_at", a)} or (b.closed_at is not null and ${between("b.closed_at", a)}))
    order by b.placed_at asc`);
  return rs.map((r) => ({
    target: a.texts.gamertag(r.target),
    reason: a.texts.bountyReason(r.reason),
    placedAt: iso(r.placed_at),
    status: r.status,
    claimer: r.claimer === null ? null : a.texts.gamertag(r.claimer),
    hoursToClaim: r.hours,
    claimMetres: r.metres,
  }));
}

type KothRow = { gamertag: string; kills: number };
type KothResultsJson = { top?: KothRow[]; winner?: KothRow | null; topKiller?: KothRow | null } | null;

export async function kothForWeek(db: Database, a: WeekRead): Promise<KothStory[]> {
  const rs = await rows<{ location: string; at: string | Date; results: KothResultsJson | string }>(db, sql`
    select location, slot_at as at, results from koth_events
    where server_id = ${a.serverId} and ${between("slot_at", a)} and state in ('awarded', 'finished', 'no_winner')
    order by slot_at asc`);
  return rs.map((r) => {
    const res = (typeof r.results === "string" ? JSON.parse(r.results) : r.results) as KothResultsJson;
    const winner = res?.winner?.gamertag ?? res?.topKiller?.gamertag ?? null;
    return {
      location: r.location,
      at: iso(r.at),
      winner: winner === null ? null : a.texts.gamertag(winner),
      top: (res?.top ?? []).slice(0, 5).map((t) => ({ gamertag: a.texts.gamertag(t.gamertag), kills: t.kills })),
    };
  });
}

export async function airdropsForWeek(db: Database, a: WeekRead): Promise<AirdropStory[]> {
  const rs = await rows<{ location: string; at: string | Date; state: string }>(db, sql`
    select location, slot_at as at, state from airdrop_events
    where server_id = ${a.serverId} and ${between("slot_at", a)} and state in ('live', 'ended')
    order by slot_at asc`);
  return rs.map((r) => ({ location: r.location, at: iso(r.at), state: r.state }));
}
