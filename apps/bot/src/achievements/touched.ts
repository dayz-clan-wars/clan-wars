import {
  alphaWeeks, clanPins, consumerCursors, ceremonyParticipants, defenses, events, factions, identityLinks, kills, membershipHistory, playerPositions,
  playerSessions, raids, seasonResults, type Database,
} from "@factions/db";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Owner } from "./types.js";

export const SOURCES = [
  "kills", "sessions", "events", "raids", "defenses", "alphaWeeks", "seasonResults", "membership", "membershipClosed",
  "ceremonies", "links", "pins", "positions", "activations",
] as const;
export type Source = (typeof SOURCES)[number];
export type Watermarks = Record<Source, number>;
export const CURSOR_PREFIX = "achievements:";
/** The event types any rule reads; other types never touch an owner. */
const RULE_EVENT_TYPES = ["base.built", "player.teleported", "emote.performed", "player.unconscious"] as const;

export type PositionRow = { dayzId: string; x: number; z: number; at: Date };
export type PinRow = { dayzId: string; at: Date };

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
 * How many of the (stable, sorted) touched owners the previous capped pass already
 * evaluated. It rides the same cursor table under a name that is NOT a source, so
 * `readWatermarks` ignores it.
 *
 * ⚠️ Without it a capped pass is a livelock: the watermarks are held back, the next
 * pass re-collects the identical owner list and re-evaluates the same first `batch`
 * owners forever, and everyone behind them is never evaluated again.
 */
export const OFFSET_CURSOR = CURSOR_PREFIX + "offset";

export async function readOffset(db: Database): Promise<number> {
  const [r] = await db.select().from(consumerCursors).where(eq(consumerCursors.consumerName, OFFSET_CURSOR));
  return r?.lastEventId ?? 0;
}

export async function writeOffset(tx: Tx, offset: number): Promise<void> {
  await tx.insert(consumerCursors).values({ consumerName: OFFSET_CURSOR, lastEventId: offset, updatedAt: new Date() })
    .onConflictDoUpdate({ target: consumerCursors.consumerName, set: { lastEventId: offset, updatedAt: new Date() } });
}

const player = (id: string): Owner => ({ kind: "player", id });
const clan = (id: number): Owner => ({ kind: "clan", id: String(id) });
const key = (o: Owner) => `${o.kind}:${o.id}`;

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

  for (const k of advance("kills", await db.select({ id: kills.id, killer: kills.killerDayzId, victim: kills.victimDayzId }).from(kills).where(gt(kills.id, wm.kills)).orderBy(asc(kills.id)).limit(limit))) {
    add(player(k.victim)); if (k.killer) add(player(k.killer));
  }
  // Sessions are touched when they CLOSE, which is later than their insert: watermark on disconnected_at (epoch ms).
  const closed = await db.select({ id: playerSessions.id, dayzId: playerSessions.dayzId, at: playerSessions.disconnectedAt }).from(playerSessions)
    .where(and(isNotNull(playerSessions.disconnectedAt), sql`${playerSessions.disconnectedAt} > to_timestamp(${wm.sessions / 1000})`)).orderBy(asc(playerSessions.disconnectedAt), asc(playerSessions.id)).limit(limit);
  for (const s of closed) add(player(s.dayzId));
  if (closed.length) next.sessions = closed[closed.length - 1]!.at!.getTime();
  if (closed.length === limit) carried = true;

  for (const e of advance("events", await db.select({ id: events.id, dayzId: sql<string>`${events.payload}->>'dayzId'` }).from(events)
    .where(and(gt(events.id, wm.events), inArray(events.type, [...RULE_EVENT_TYPES] as never[]))).orderBy(asc(events.id)).limit(limit))) {
    if (e.dayzId) add(player(e.dayzId));
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
  for (const s of advance("membership", spans)) { add(player(s.dayzId)); add(clan(s.clan)); }
  // The closed watermark advances to the LATEST leftAt seen, not the last row's: the rows come
  // back in id order, so the last row's leftAt is not the greatest one.
  for (const s of spans) if (s.leftAt && s.leftAt.getTime() > next.membershipClosed) next.membershipClosed = s.leftAt.getTime();

  for (const c of advance("ceremonies", await db.select({ id: ceremonyParticipants.id, dayzId: ceremonyParticipants.dayzId }).from(ceremonyParticipants).where(gt(ceremonyParticipants.id, wm.ceremonies)).orderBy(asc(ceremonyParticipants.id)).limit(limit))) add(player(c.dayzId));
  for (const l of advance("links", await db.select({ id: identityLinks.id, dayzId: identityLinks.dayzId }).from(identityLinks).where(gt(identityLinks.id, wm.links)).orderBy(asc(identityLinks.id)).limit(limit))) add(player(l.dayzId));
  const pins = advance("pins", await db.select({ id: clanPins.id, dayzId: clanPins.dayzId, at: clanPins.createdAt }).from(clanPins).where(gt(clanPins.id, wm.pins)).orderBy(asc(clanPins.id)).limit(limit));
  for (const p of pins) add(player(p.dayzId));
  const positions = advance("positions", await db.select({ id: playerPositions.id, dayzId: playerPositions.dayzId, x: playerPositions.x, z: playerPositions.z, at: playerPositions.occurredAt }).from(playerPositions).where(gt(playerPositions.id, wm.positions)).orderBy(asc(playerPositions.id)).limit(limit));
  for (const p of positions) add(player(p.dayzId));
  // Activation happens after the row is inserted: watermark on activated_at.
  const activated = await db.select({ id: factions.id, at: factions.activatedAt }).from(factions)
    .where(sql`${factions.activatedAt} > to_timestamp(${wm.activations / 1000})`).orderBy(asc(factions.activatedAt)).limit(limit);
  for (const f of activated) add(clan(f.id));
  if (activated.length) next.activations = activated[activated.length - 1]!.at!.getTime();
  if (activated.length === limit) carried = true;

  return {
    // Sorted, not insertion-ordered: the carried-owner offset above is only meaningful
    // against an order that does not depend on which source happened to touch whom.
    owners: [...owners.values()].sort((a, b) => key(a).localeCompare(key(b))), next, carried,
    positions: positions.map((p) => ({ dayzId: p.dayzId, x: Number(p.x), z: Number(p.z), at: p.at })),
    pins: pins.map((p) => ({ dayzId: p.dayzId, at: p.at })),
  };
}

/** Every owner there is — the backfill's set. */
export async function collectEveryone(db: Database): Promise<Owner[]> {
  const ids = new Set<string>();
  for (const r of await db.select({ id: identityLinks.dayzId }).from(identityLinks)) ids.add(r.id);
  for (const r of await db.select({ id: kills.victimDayzId }).from(kills)) ids.add(r.id);
  for (const r of await db.select({ id: kills.killerDayzId }).from(kills).where(isNotNull(kills.killerDayzId))) ids.add(r.id!);
  for (const r of await db.select({ id: playerSessions.dayzId }).from(playerSessions)) ids.add(r.id);
  const clans = await db.select({ id: factions.id }).from(factions);
  return [...[...ids].map(player), ...clans.map((c) => clan(c.id))];
}
