import type { Database } from "@factions/db";
import { clanPins, declarations, factionMembers, factions, identityLinks, intruderSightings, playerPositions, players } from "@factions/db";
import { publicPoles } from "@factions/declarations";
import {
  FAST_TRAVEL_POINTS, HOLDING_STATUSES, HUB_POSITION, INTRUDER_PIN_TTL_MS, PIN_ICONS, PIN_NOTE_MAX, PIN_TTL_MS, WATCH_ZONE_RADIUS_M, type PinIcon,
} from "@factions/domain";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { activeServerId } from "./server";
import { actorFor, isRefusal } from "./actor";

/** Livonia. The one map this deployment runs; `servers.map` says "livonia". */
export const WORLD_SIZE_M = 12800;

export type MapFix = { x: number; z: number; at: Date };
export type MapState = {
  /** Livonia, metres. */
  world: { size: number };
  you: { gamertag: string; fix: MapFix | null };
  base: { x: number; z: number; radiusM: number; kind: "clan" | "solo" } | null;
  clanmates: { dayzId: string; gamertag: string; fix: MapFix }[];
  intruders: { gamertag: string; x: number; z: number; lastSeenAt: Date; distanceM: number }[];
  publicBases: { x: number; z: number; texture: string | null }[];
  pins: { id: number; x: number; z: number; icon: PinIcon; note: string | null; by: string; at: Date; expiresAt: Date }[];
  travelPoints: readonly { x: number; z: number }[];
  hub: { x: number; z: number };
  layers: { base: boolean; clanmates: boolean; intruders: boolean; pins: boolean };
};
export type DropPinOutcome = { ok: true; id: number } | { ok: false; reason: "not-linked" | "not-in-clan" | "pending" | "bad-icon" | "bad-note" | "off-map" };

const n = (v: string | number) => Number(v);

/** Newest fix per player among `dayzIds`, one query (DISTINCT ON over the (server, player, occurred_at desc) index). */
async function lastFixes(db: Database, serverId: number, dayzIds: string[]): Promise<Map<string, MapFix>> {
  if (dayzIds.length === 0) return new Map();
  const rows = await db.selectDistinctOn([playerPositions.dayzId], { dayzId: playerPositions.dayzId, x: playerPositions.x, z: playerPositions.z, at: playerPositions.occurredAt })
    .from(playerPositions)
    .where(and(eq(playerPositions.serverId, serverId), inArray(playerPositions.dayzId, dayzIds)))
    .orderBy(asc(playerPositions.dayzId), desc(playerPositions.occurredAt));
  return new Map(rows.map((r) => [r.dayzId, { x: n(r.x), z: n(r.z), at: r.at }]));
}

/**
 * The map, scoped to the viewer (spec §10.3). Every clan-level query names
 * the viewer's own clan or own declaration in its WHERE clause; nothing is
 * fetched wider and filtered after. A pending member is not clan-level
 * (§10.1) and gets the linked layers only. Dormant clans keep their map.
 */
export async function mapStateDb(db: Database, discordId: string, now: Date): Promise<MapState | "not-linked"> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  const serverId = await activeServerId(db);

  const [clan] = await db.select({ id: factions.id }).from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.serverId, serverId), eq(factionMembers.dayzId, link.dayzId), eq(factionMembers.status, "full"), inArray(factions.status, [...HOLDING_STATUSES])))
    .orderBy(asc(factions.id)).limit(1);

  // The viewer's own declaration: the clan's, or their solo one. One row or none.
  const [decl] = await db.select({ id: declarations.id, x: declarations.x, z: declarations.z, ownerFactionId: declarations.ownerFactionId })
    .from(declarations)
    .where(and(eq(declarations.serverId, serverId), clan ? eq(declarations.ownerFactionId, clan.id) : eq(declarations.ownerDayzId, link.dayzId)));

  const mates = clan ? await db.select({ dayzId: factionMembers.dayzId, gamertag: identityLinks.gamertag }).from(factionMembers)
    .innerJoin(identityLinks, eq(identityLinks.dayzId, factionMembers.dayzId))
    .where(and(eq(factionMembers.factionId, clan.id), eq(factionMembers.status, "full"), sql`${factionMembers.dayzId} <> ${link.dayzId}`)) : [];

  const fixes = await lastFixes(db, serverId, [link.dayzId, ...mates.map((m) => m.dayzId)]);

  // `players`, not `identity_links`: a stranger is rarely linked, but the log named them.
  const intruders = decl ? await db.select({ gamertag: players.gamertag, dayzId: intruderSightings.dayzId, x: intruderSightings.lastX, z: intruderSightings.lastZ, lastSeenAt: intruderSightings.lastSeenAt, distanceM: intruderSightings.distanceM })
    .from(intruderSightings).leftJoin(players, eq(players.dayzId, intruderSightings.dayzId))
    .where(and(eq(intruderSightings.declarationId, decl.id), gt(intruderSightings.lastSeenAt, new Date(now.getTime() - INTRUDER_PIN_TTL_MS))))
    .orderBy(desc(intruderSightings.lastSeenAt)) : [];

  const pins = clan ? await db.select({ id: clanPins.id, x: clanPins.x, z: clanPins.z, icon: clanPins.icon, note: clanPins.note, by: identityLinks.gamertag, at: clanPins.createdAt, expiresAt: clanPins.expiresAt })
    .from(clanPins).leftJoin(identityLinks, eq(identityLinks.dayzId, clanPins.dayzId))
    .where(and(eq(clanPins.factionId, clan.id), gt(clanPins.expiresAt, now))).orderBy(desc(clanPins.createdAt)) : [];

  const publicBases = (await publicPoles(db, serverId, now)).map((p) => ({ x: n(p.x), z: n(p.z), texture: p.texture }));

  return {
    world: { size: WORLD_SIZE_M },
    you: { gamertag: link.gamertag, fix: fixes.get(link.dayzId) ?? null },
    base: decl ? { x: n(decl.x), z: n(decl.z), radiusM: WATCH_ZONE_RADIUS_M, kind: decl.ownerFactionId === null ? "solo" : "clan" } : null,
    clanmates: mates.flatMap((m) => { const f = fixes.get(m.dayzId); return f ? [{ dayzId: m.dayzId, gamertag: m.gamertag, fix: f }] : []; }),
    intruders: intruders.map((i) => ({ gamertag: i.gamertag ?? "someone", x: n(i.x), z: n(i.z), lastSeenAt: i.lastSeenAt, distanceM: i.distanceM })),
    publicBases,
    pins: pins.map((p) => ({ id: p.id, x: n(p.x), z: n(p.z), icon: p.icon as PinIcon, note: p.note, by: p.by ?? "a member", at: p.at, expiresAt: p.expiresAt })),
    travelPoints: FAST_TRAVEL_POINTS,
    hub: HUB_POSITION,
    layers: { base: decl !== undefined, clanmates: clan !== undefined, intruders: decl !== undefined, pins: clan !== undefined },
  };
}

const inWorld = (v: number) => Number.isFinite(v) && v >= 0 && v <= WORLD_SIZE_M;

export async function dropPinDb(db: Database, discordId: string, pin: { x: number; z: number; icon: string; note: string | null }, now: Date): Promise<DropPinOutcome> {
  const a = await actorFor(db, discordId);
  if (isRefusal(a)) return { ok: false, reason: a };
  if (!(PIN_ICONS as readonly string[]).includes(pin.icon)) return { ok: false, reason: "bad-icon" };
  const note = pin.note?.trim() || null;
  if (note !== null && note.length > PIN_NOTE_MAX) return { ok: false, reason: "bad-note" };
  if (!inWorld(pin.x) || !inWorld(pin.z)) return { ok: false, reason: "off-map" };
  const [row] = await db.insert(clanPins).values({
    factionId: a.factionId, dayzId: a.dayzId, x: pin.x.toFixed(2), z: pin.z.toFixed(2), icon: pin.icon, note,
    createdAt: now, expiresAt: new Date(now.getTime() + PIN_TTL_MS),
  }).returning({ id: clanPins.id });
  return { ok: true, id: row!.id };
}

/** Any full member of the pin's clan. The clan is in the WHERE clause, so another clan's id deletes nothing. */
export async function deletePinDb(db: Database, discordId: string, pinId: number): Promise<{ deleted: boolean }> {
  const a = await actorFor(db, discordId);
  if (isRefusal(a)) return { deleted: false };
  const rows = await db.delete(clanPins).where(and(eq(clanPins.id, pinId), eq(clanPins.factionId, a.factionId))).returning({ id: clanPins.id });
  return { deleted: rows.length === 1 };
}
