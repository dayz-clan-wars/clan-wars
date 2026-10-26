import { CLASS_TILE_KEYS, RUIN_RUBBLE_RE, WELL_BRICK_PART } from "@factions/domain";
import {
  achievementCounters, achievementUnlocks, alphaWeeks, clanPins, consumerCursors, ceremonyParticipants, defenses, events, factions, identityLinks, kills,
  membershipHistory, playerPositions, playerSessions, raids, seasonResults, type Database,
} from "@factions/db";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Owner } from "./types.js";
import { withinWellRadius } from "../wells.js";

export const SOURCES = [
  "kills", "sessions", "events", "raids", "defenses", "alphaWeeks", "seasonResults", "membership", "membershipClosed",
  "ceremonies", "links", "pins", "positions", "activations", "classUnlocks",
] as const;
export type Source = (typeof SOURCES)[number];
export type Watermarks = Record<Source, number>;
export const CURSOR_PREFIX = "achievements:";
/** The event types any rule reads; other types never touch an owner. */
const RULE_EVENT_TYPES = ["base.built", "emote.performed", "player.unconscious", "player.hit", "item.placed", "item.packed", "player.conscious"] as const;

export type PositionRow = { id: number; dayzId: string; x: number; z: number; at: Date };
export type PinRow = { id: number; dayzId: string; at: Date };

/** Watermarks ride the event-log cursor table under `achievements:<source>`; ids for id-keyed tables, epoch ms for time-keyed ones. */
export async function readWatermarks(db: Database): Promise<Watermarks> {
  const rows = await db.select().from(consumerCursors).where(sql`${consumerCursors.consumerName} like ${CURSOR_PREFIX + "%"}`);
  const wm = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Watermarks;
  for (const r of rows) {
    const s = r.consumerName.slice(CURSOR_PREFIX.length) as Source;
    if (SOURCES.includes(s)) wm[s] = r.lastEventId;
  }
  return wm;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function writeWatermarks(tx: Tx, wm: Watermarks): Promise<void> {
  for (const s of SOURCES) {
    await tx.insert(consumerCursors).values({ consumerName: CURSOR_PREFIX + s, lastEventId: wm[s], updatedAt: new Date() })
      .onConflictDoUpdate({ target: consumerCursors.consumerName, set: { lastEventId: wm[s], updatedAt: new Date() } });
  }
}

/**
 * Where a capped drain got to: the LAST OWNER KEY it processed, plus the watermarks the
 * drain started from.
 *
 * ⚠️ Two things are wrong without it, both silent. (1) A positional offset skips an owner
 * for good as soon as a new owner sorts ahead of it — the list shifts under the index.
 * (2) Advancing to the LAST pass's watermarks at the end of a drain consumes the rows that
 * arrived DURING the drain, whose owners were never evaluated; freezing the drain-start
 * watermarks here leaves those rows unread, so the next pass collects them normally.
 *
 * ⚠️ It lives in `achievement_counters` (owner_kind 'clan', owner_id '0') because that
 * table already IS "the durable state this consumer keeps", and `consumer_cursors` has
 * only a bigint column — a key and a watermark set do not fit in it. Owner id '0' is not a
 * faction id (`factions.id` is a bigserial starting at 1), so it can never collide.
 */
export const RESUME_KEY = "achievements:after";
const RESUME_WHERE = and(eq(achievementCounters.ownerKind, "clan"), eq(achievementCounters.ownerId, "0"), eq(achievementCounters.key, RESUME_KEY));
export type Resume = { afterKey: string; wm: Watermarks };

export async function readResume(db: Database): Promise<Resume | null> {
  const [r] = await db.select().from(achievementCounters).where(RESUME_WHERE);
  const afterKey = r?.detail.afterKey;
  const wm = r?.detail.wm;
  return typeof afterKey === "string" && wm ? { afterKey, wm: wm as Watermarks } : null;
}

export async function writeResume(tx: Tx, resume: Resume): Promise<void> {
  await tx.insert(achievementCounters)
    .values({ ownerKind: "clan", ownerId: "0", key: RESUME_KEY, value: 0, detail: { ...resume }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [achievementCounters.ownerKind, achievementCounters.ownerId, achievementCounters.key],
      set: { detail: { ...resume }, updatedAt: new Date() },
    });
}

/** Called in the same transaction as the watermark advance: a drain is over, start clean. */
export async function clearResume(tx: Tx): Promise<void> {
  await tx.delete(achievementCounters).where(RESUME_WHERE);
}

const player = (id: string): Owner => ({ kind: "player", id });
const clan = (id: number): Owner => ({ kind: "clan", id: String(id) });
export const ownerKey = (o: Owner) => `${o.kind}:${o.id}`;
const key = ownerKey;

/** Position fixes past `afterId`, in id order. Shared with the backfill, which walks the whole table in chunks. */
export async function positionsAfter(db: Database, afterId: number, limit: number): Promise<PositionRow[]> {
  const rows = await db.select({ id: playerPositions.id, dayzId: playerPositions.dayzId, x: playerPositions.x, z: playerPositions.z, at: playerPositions.occurredAt })
    .from(playerPositions).where(gt(playerPositions.id, afterId)).orderBy(asc(playerPositions.id)).limit(limit);
  return rows.map((p) => ({ id: p.id, dayzId: p.dayzId, x: Number(p.x), z: Number(p.z), at: p.at }));
}

/** Pins past `afterId`, in id order. Same use as positionsAfter. */
export async function pinsAfter(db: Database, afterId: number, limit: number): Promise<PinRow[]> {
  return db.select({ id: clanPins.id, dayzId: clanPins.dayzId, at: clanPins.createdAt })
    .from(clanPins).where(gt(clanPins.id, afterId)).orderBy(asc(clanPins.id)).limit(limit);
}

/**
 * Owners with rows past each watermark, and the new watermarks. `limit` caps rows read
 * per source per pass; a source that hit the cap sets `carried`, and the tick then holds
 * every watermark back so the next pass re-collects from the same place.
 */
export async function collectTouched(db: Database, wm: Watermarks, limit: number): Promise<{ owners: Owner[]; next: Watermarks; positions: PositionRow[]; pins: PinRow[]; carried: boolean }> {
  const owners = new Map<string, Owner>();
  const add = (o: Owner) => owners.set(key(o), o);
  const next = { ...wm };
  let carried = false;
  const advance = <T extends { id: number }>(s: Source, rows: T[]) => {
    if (rows.length) next[s] = rows[rows.length - 1]!.id;
    if (rows.length === limit) carried = true;
    return rows;
  };

  for (const k of advance("kills", await db.select({ id: kills.id, killer: kills.killerDayzId, victim: kills.victimDayzId, clan: kills.killerFactionId }).from(kills).where(gt(kills.id, wm.kills)).orderBy(asc(kills.id)).limit(limit))) {
    // The killer's clan as resolved at the kill: Warband and Armory credit exactly that column.
    add(player(k.victim)); if (k.killer) add(player(k.killer)); if (k.clan) add(clan(k.clan));
  }
  // Sessions are touched when they CLOSE, which is later than their insert: watermark on disconnected_at (epoch ms).
  const closed = await db.select({ id: playerSessions.id, dayzId: playerSessions.dayzId, at: playerSessions.disconnectedAt }).from(playerSessions)
    .where(and(isNotNull(playerSessions.disconnectedAt), sql`${playerSessions.disconnectedAt} > to_timestamp(${wm.sessions / 1000})`)).orderBy(asc(playerSessions.disconnectedAt), asc(playerSessions.id)).limit(limit);
  for (const s of closed) add(player(s.dayzId));
  if (closed.length) next.sessions = closed[closed.length - 1]!.at!.getTime();
  if (closed.length === limit) carried = true;

  for (const e of advance("events", await db.select({
    id: events.id, dayzId: sql<string | null>`${events.payload}->>'dayzId'`, victim: sql<string | null>`${events.payload}->>'victimDayzId'`, attacker: sql<string | null>`${events.payload}->>'attackerDayzId'`,
    // A build or repair also touches the clan the builder was a full member of at that moment
    // (Renovators): the same span reading, on the same server, as the rule itself (rules-team.ts).
    clans: sql<string[] | null>`case when ${events.type} = 'base.built' then (select array_agg(mh.faction_id::text) from ${membershipHistory} mh
      where mh.dayz_id = ${events.payload}->>'dayzId' and mh.server_id = ${events.serverId}
        and mh.joined_at <= ${events.occurredAt} and (mh.left_at is null or mh.left_at > ${events.occurredAt})) end`,
    // ⚠️ Community Service is earned by someone with NO new event of their own: A cleared rubble
    // yesterday, B lays the brick today, and A earns it from B's event. Without this column A is
    // never re-evaluated and the award is silently never given. Same server, same radius rule as
    // the rule itself (withinWellRadius), so the two cannot name different wells.
    // ⚠️ The outer columns are written qualified (`events.…`): drizzle renders a column in a
    // single-table select UNQUALIFIED, and inside this subquery `server_id`/`payload` would then
    // bind to the inner `r` row, comparing it with itself (every server, every distance matches).
    rubbleNear: sql<string[] | null>`case when "events"."payload"->>'part' = ${WELL_BRICK_PART} then (select array_agg(distinct r.payload->>'dayzId') from ${events} r
      where r.server_id = "events"."server_id" and r.type = 'base.built' and r.payload->>'part' ~ ${RUIN_RUBBLE_RE.source}
        and ${withinWellRadius(sql`(r.payload->'pos'->>'x')::float`, sql`(r.payload->'pos'->>'z')::float`, sql`("events"."payload"->'pos'->>'x')::float`, sql`("events"."payload"->'pos'->>'z')::float`)}) end`,
  }).from(events)
    .where(and(gt(events.id, wm.events), inArray(events.type, [...RULE_EVENT_TYPES] as never[]))).orderBy(asc(events.id)).limit(limit))) {
    // Most types carry `dayzId`; a hit carries `victimDayzId` and, for a player attacker, `attackerDayzId`.
    for (const id of new Set([e.dayzId, e.victim, e.attacker])) if (id) add(player(id));
    for (const c of e.clans ?? []) add(clan(Number(c)));
    for (const id of e.rubbleNear ?? []) if (id) add(player(id));
  }
  for (const r of advance("raids", await db.select({ id: raids.id, raider: raids.raiderDayzId, clan: raids.raiderFactionId }).from(raids).where(gt(raids.id, wm.raids)).orderBy(asc(raids.id)).limit(limit))) {
    add(player(r.raider)); if (r.clan) add(clan(r.clan));
  }
  for (const d of advance("defenses", await db.select({ id: defenses.id, by: defenses.raisedByDayzId, clan: defenses.factionId }).from(defenses).where(gt(defenses.id, wm.defenses)).orderBy(asc(defenses.id)).limit(limit))) {
    add(player(d.by)); add(clan(d.clan));
  }
  for (const w of advance("alphaWeeks", await db.select({ id: alphaWeeks.id, clan: alphaWeeks.factionId }).from(alphaWeeks).where(gt(alphaWeeks.id, wm.alphaWeeks)).orderBy(asc(alphaWeeks.id)).limit(limit))) add(clan(w.clan));
  for (const s of advance("seasonResults", await db.select({ id: seasonResults.id, clan: seasonResults.factionId }).from(seasonResults).where(gt(seasonResults.id, wm.seasonResults)).orderBy(asc(seasonResults.id)).limit(limit))) add(clan(s.clan));
  // Membership: new spans by id, AND spans closed since — both matter to full_strength/loyalist.
  // ⚠️ The "closed since" half has its OWN time watermark (`membershipClosed`). Sharing the
  // sessions watermark would make a clan's membership changes visible or invisible depending on
  // when someone last disconnected — two unrelated facts, one number, silently wrong either way.
  const spans = await db.select({ id: membershipHistory.id, dayzId: membershipHistory.dayzId, clan: membershipHistory.factionId, leftAt: membershipHistory.leftAt }).from(membershipHistory)
    .where(sql`${membershipHistory.id} > ${wm.membership} or ${membershipHistory.leftAt} > to_timestamp(${wm.membershipClosed / 1000})`).orderBy(asc(membershipHistory.id)).limit(limit);
  // ⚠️ NOT `advance()`: the OR clause returns old, low-id spans whose left_at was just set,
  // so taking the last row's id would move the membership watermark BACKWARDS and make the
  // next pass re-collect most of the server. Both halves only ever move forward.
  for (const s of spans) {
    add(player(s.dayzId)); add(clan(s.clan));
    if (s.id > next.membership) next.membership = s.id;
    // The closed watermark takes the LATEST left_at seen, not the last row's: the rows come
    // back in id order, so the last row's left_at is not the greatest one.
    if (s.leftAt && s.leftAt.getTime() > next.membershipClosed) next.membershipClosed = s.leftAt.getTime();
  }
  if (spans.length === limit) carried = true;

  for (const c of advance("ceremonies", await db.select({ id: ceremonyParticipants.id, dayzId: ceremonyParticipants.dayzId }).from(ceremonyParticipants).where(gt(ceremonyParticipants.id, wm.ceremonies)).orderBy(asc(ceremonyParticipants.id)).limit(limit))) add(player(c.dayzId));
  for (const l of advance("links", await db.select({ id: identityLinks.id, dayzId: identityLinks.dayzId }).from(identityLinks).where(gt(identityLinks.id, wm.links)).orderBy(asc(identityLinks.id)).limit(limit))) add(player(l.dayzId));
  const pins = advance("pins", await pinsAfter(db, wm.pins, limit));
  for (const p of pins) add(player(p.dayzId));
  const positions = advance("positions", await positionsAfter(db, wm.positions, limit));
  for (const p of positions) add(player(p.dayzId));
  // Activation happens after the row is inserted: watermark on activated_at.
  const activated = await db.select({ id: factions.id, at: factions.activatedAt }).from(factions)
    .where(sql`${factions.activatedAt} > to_timestamp(${wm.activations / 1000})`).orderBy(asc(factions.activatedAt)).limit(limit);
  for (const f of activated) add(clan(f.id));
  if (activated.length) next.activations = activated[activated.length - 1]!.at!.getTime();
  if (activated.length === limit) carried = true;

  // A member's class tile re-evaluates the clan they were in when they earned it (Every Class
  // Covered reads those unlocks). Watermarked on `noticed_at`, the insert time: the unlock is
  // written by THIS tick, after the clan — which sorts before every player — was already
  // evaluated in that pass, so only the next pass can see it.
  // ⚠️ Compared at millisecond precision: `noticed_at` is `now()` with microseconds, the
  // watermark is epoch ms, and a raw `>` would re-collect the newest row on every pass forever.
  const unlocked = await db.select({
    at: sql<number>`floor(extract(epoch from ${achievementUnlocks.noticedAt}) * 1000)::bigint`.mapWith(Number),
    clans: sql<string[] | null>`(select array_agg(mh.faction_id::text) from ${membershipHistory} mh
      where mh.dayz_id = ${achievementUnlocks.ownerId} and mh.joined_at <= ${achievementUnlocks.earnedAt} and (mh.left_at is null or mh.left_at > ${achievementUnlocks.earnedAt}))`,
  }).from(achievementUnlocks)
    .where(and(eq(achievementUnlocks.ownerKind, "player"), inArray(achievementUnlocks.key, [...CLASS_TILE_KEYS]),
      sql`floor(extract(epoch from ${achievementUnlocks.noticedAt}) * 1000) > ${wm.classUnlocks}`))
    .orderBy(asc(achievementUnlocks.noticedAt)).limit(limit);
  for (const u of unlocked) for (const c of u.clans ?? []) add(clan(Number(c)));
  if (unlocked.length) next.classUnlocks = unlocked[unlocked.length - 1]!.at;
  if (unlocked.length === limit) carried = true;

  return {
    // Sorted, not insertion-ordered: the carried-owner offset above is only meaningful
    // against an order that does not depend on which source happened to touch whom.
    // Sorted, not insertion-ordered: the resume key above is only meaningful against an
    // order that does not depend on which source happened to touch whom.
    owners: [...owners.values()].sort((a, b) => key(a).localeCompare(key(b))), next, carried, positions, pins,
  };
}

/** Every owner there is — the backfill's set. */
export async function collectEveryone(db: Database): Promise<Owner[]> {
  const ids = new Set<string>();
  // ⚠️ `select distinct`, and the kills table read ONCE as a union of its two id columns.
  // The obvious form — four plain selects, killer and victim separately — materialises every
  // kill row twice just to build a set of a few hundred ids. A backfill is exactly when that
  // table is largest, which is exactly when it OOMs the bot (same hazard as `headWatermarks`).
  const rows = await db.execute(sql`
    select dayz_id from identity_links
    union select victim_dayz_id from kills
    union select killer_dayz_id from kills where killer_dayz_id is not null
    union select dayz_id from player_sessions`);
  for (const r of rows as unknown as { dayz_id: string }[]) if (r.dayz_id) ids.add(r.dayz_id);
  const clans = await db.select({ id: factions.id }).from(factions);
  return [...[...ids].map(player), ...clans.map((c) => clan(c.id))];
}

/**
 * The current head of every source, as aggregates — one round trip, no rows loaded.
 *
 * ⚠️ Never `collectTouched(db, …, MAX_SAFE_INTEGER)`: that reads every kill, position and
 * event ever logged into memory just to learn their last ids. A backfill is exactly when
 * those tables are largest, which is exactly when that OOMs the bot.
 */
export async function headWatermarks(db: Database): Promise<Watermarks> {
  const id = (table: string, where = "") => sql.raw(`coalesce((select max(id) from ${table} ${where}), 0)`);
  const ms = (table: string, col: string) => sql.raw(`coalesce((select extract(epoch from max(${col})) * 1000 from ${table}), 0)`);
  const types = RULE_EVENT_TYPES.map((t) => `'${t}'`).join(",");
  const rows = await db.execute(sql`select
    ${id("kills")} as kills, ${ms("player_sessions", "disconnected_at")} as sessions,
    ${id("events", `where type in (${types})`)} as events, ${id("raids")} as raids, ${id("defenses")} as defenses,
    ${id("alpha_weeks")} as "alphaWeeks", ${id("season_results")} as "seasonResults",
    ${id("membership_history")} as membership, ${ms("membership_history", "left_at")} as "membershipClosed",
    ${id("ceremony_participants")} as ceremonies, ${id("identity_links")} as links, ${id("clan_pins")} as pins,
    ${id("player_positions")} as positions, ${ms("factions", "activated_at")} as activations,
    coalesce((select floor(extract(epoch from max(noticed_at)) * 1000) from achievement_unlocks
      where owner_kind = 'player' and key in (${sql.raw(CLASS_TILE_KEYS.map((k) => `'${k}'`).join(","))})), 0) as "classUnlocks"`);
  const row = (rows as unknown as Record<string, unknown>[])[0] ?? {};
  // ⚠️ `Math.floor`, not a bare `Number`: `extract(epoch from …) * 1000` carries microsecond
  // precision, so a time-keyed head can come back fractional (…957.123). These go straight into
  // `consumer_cursors.last_event_id`, a BIGINT, in the same transaction that clears the backfill's
  // resume marker — postgres rejects a fractional bigint, the transaction aborts, and the backfill
  // ends with its watermarks never headed and its resume marker still set.
  return Object.fromEntries(SOURCES.map((src) => [src, Math.floor(Number(row[src] ?? 0))])) as Watermarks;
}
