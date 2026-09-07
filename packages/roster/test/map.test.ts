import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, factionMembers, identityLinks, players, playerPositions, poles, intruderSightings, declarations, clanPins, type Database } from "@factions/db";
import { HUB_POSITION, PIN_TTL_MS, TRAVEL_POINTS, WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { mapStateDb, dropPinDb, deletePinDb } from "../src/map";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const A = "A".repeat(40), B = "B".repeat(40), P = "P".repeat(40), X = "X".repeat(40), R = "R".repeat(40);

describe("mapState / dropPin / deletePin", () => {
  let db: Database; let serverId = 0; let bear = 0; let wolf = 0; let bearDecl = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table clan_pins, intruder_sightings, player_positions, declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    // The stranger is unlinked in the common case; the map names them from `players`, the log's own record.
    await db.insert(players).values({ dayzId: X, gamertag: "Xed", firstSeenAt: now, lastSeenAt: now });
    serverId = s!.id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: ago(1000), x: 5000, z: 5000 })).id;
    wolf = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", createdAt: ago(1000), poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000 })).id;
    bearDecl = (await db.select({ id: declarations.id }).from(declarations).where(eq(declarations.ownerFactionId, bear)))[0]!.id;
    await db.insert(factionMembers).values([
      { factionId: bear, serverId, dayzId: A, discordId: "1", role: "leader", joinedAt: now, status: "full" },
      { factionId: bear, serverId, dayzId: B, discordId: "2", role: "member", joinedAt: now, status: "full" },
      { factionId: bear, serverId, dayzId: P, discordId: "3", role: "member", joinedAt: now, status: "pending", pendingSince: now },
      { factionId: wolf, serverId, dayzId: R, discordId: "4", role: "leader", joinedAt: now, status: "full" },
    ]);
    await db.insert(identityLinks).values([
      { discordId: "1", dayzId: A, gamertag: "Ann", verifiedAt: now }, { discordId: "2", dayzId: B, gamertag: "Ben", verifiedAt: now },
      { discordId: "3", dayzId: P, gamertag: "Pat", verifiedAt: now }, { discordId: "4", dayzId: R, gamertag: "Rex", verifiedAt: now },
      { discordId: "5", dayzId: "L".repeat(40), gamertag: "Lone", verifiedAt: now },   // linked, in no clan
    ]);
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    // ⚠️ player_positions_event_uniq is one row per event: each fix needs its own event, not a shared one.
    let line = 0;
    const fix = async (dayzId: string, x: number, z: number, at: Date) => {
      const [e] = await db.insert(events).values({ serverId, admFileId: f!.id, lineIndex: line++, type: "player.position", occurredAt: at, payload: {} }).returning();
      return { serverId, dayzId, x: String(x), z: String(z), alt: "100", occurredAt: at, eventId: e!.id };
    };
    await db.insert(playerPositions).values([
      await fix(A, 5100, 5100, ago(3600_000)), await fix(A, 5200, 5200, ago(60_000)),   // newest wins
      await fix(B, 6000, 6000, ago(25 * 3600_000)),                               // a day old: still shown, page dims it
      await fix(R, 9100, 9100, ago(60_000)),                                       // another clan's member: never shown
      await fix(X, 7000, 7000, ago(60_000)),                                       // a stranger: never shown
    ]);
    await db.insert(intruderSightings).values([
      { declarationId: bearDecl, dayzId: X, firstSeenAt: ago(600_000), lastSeenAt: ago(300_000), lastAlertAt: ago(300_000), distanceM: 40, lastX: "5030", lastZ: "5030" },
    ]);
    await db.insert(poles).values({ serverId, map: "livonia", poleKey: "2000.00:100.00:2000.00", x: "2000", y: "100", z: "2000", currentTexture: "Flag_Pirates", flagRaised: true, firstSeenAt: ago(10 * 86_400_000), lastSeenAt: now, graceUntil: ago(1) });
  });

  it("a clan member sees themself, the base, full clanmates, intruders in their zone, public bases, pins, travel points", async () => {
    const s = await mapStateDb(db, "1", now);
    if (s === "not-linked") throw new Error("linked");
    expect(s.you).toEqual({ gamertag: "Ann", fix: { x: 5200, z: 5200, at: ago(60_000) } });
    expect(s.base).toEqual({ x: 5000, z: 5000, radiusM: WATCH_ZONE_RADIUS_M, kind: "clan" });
    expect(s.clanmates.map((m) => [m.gamertag, m.fix.x])).toEqual([["Ben", 6000]]);      // not Ann (that is `you`), not Pat (pending), not Rex, not Xed
    expect(s.intruders).toEqual([{ gamertag: "Xed", x: 5030, z: 5030, lastSeenAt: ago(300_000), distanceM: 40 }]);
    expect(s.publicBases).toEqual([{ x: 2000, z: 2000, texture: "Flag_Pirates" }]);
    expect(s.travelPoints).toHaveLength(TRAVEL_POINTS);
    expect(s.hub).toEqual(HUB_POSITION);
    expect(s.layers).toEqual({ base: true, clanmates: true, intruders: true, pins: true });
  });

  it("⚠️ another clan's member sees none of Bear's things: ownership is the WHERE clause", async () => {
    const s = await mapStateDb(db, "4", now);
    if (s === "not-linked") throw new Error("linked");
    expect(s.base).toMatchObject({ x: 9000 });
    expect(s.clanmates).toEqual([]);
    expect(s.intruders).toEqual([]);
    expect(s.pins).toEqual([]);
  });

  it("a linked player outside any clan sees only themself, public bases and travel points; a pending member the same", async () => {
    for (const id of ["5", "3"]) {
      const s = await mapStateDb(db, id, now);
      if (s === "not-linked") throw new Error("linked");
      expect(s.base).toBeNull();
      expect(s.clanmates).toEqual([]); expect(s.intruders).toEqual([]); expect(s.pins).toEqual([]);
      expect(s.layers).toEqual({ base: false, clanmates: false, intruders: false, pins: false });
      expect(s.publicBases).toHaveLength(1);
    }
    expect(await mapStateDb(db, "nobody", now)).toBe("not-linked");
  });

  it("a stranger's sighting that dropped off (older than 60 min) is not shown, and a dormant clan keeps its map", async () => {
    await db.update(intruderSightings).set({ lastSeenAt: ago(61 * 60_000) });
    await db.execute(sql`update factions set status = 'dormant', dormant_since = now() where id = ${bear}`);
    const s = await mapStateDb(db, "1", now);
    if (s === "not-linked") throw new Error("linked");
    expect(s.intruders).toEqual([]);
    expect(s.base).not.toBeNull();
  });

  it("dropPin: a full member drops one with a valid icon and note, expiring in PIN_TTL_MS; refusals by reason", async () => {
    const ok = await dropPinDb(db, "1", { x: 5050, z: 5050, icon: "loot", note: "  ammo  " }, now);
    expect(ok).toMatchObject({ ok: true });
    const [pin] = await db.select().from(clanPins);
    expect(pin).toMatchObject({ factionId: bear, dayzId: A, icon: "loot", note: "ammo", expiresAt: new Date(now.getTime() + PIN_TTL_MS) });
    expect(await dropPinDb(db, "3", { x: 1, z: 1, icon: "loot", note: null }, now)).toEqual({ ok: false, reason: "pending" });
    expect(await dropPinDb(db, "5", { x: 1, z: 1, icon: "loot", note: null }, now)).toEqual({ ok: false, reason: "not-in-clan" });
    expect(await dropPinDb(db, "1", { x: 1, z: 1, icon: "treasure", note: null }, now)).toEqual({ ok: false, reason: "bad-icon" });
    expect(await dropPinDb(db, "1", { x: 1, z: 1, icon: "note", note: "x".repeat(141) }, now)).toEqual({ ok: false, reason: "bad-note" });
    expect(await dropPinDb(db, "1", { x: -1, z: 1, icon: "note", note: null }, now)).toEqual({ ok: false, reason: "off-map" });
    expect(await dropPinDb(db, "1", { x: 12801, z: 1, icon: "note", note: null }, now)).toEqual({ ok: false, reason: "off-map" });
    const s = await mapStateDb(db, "2", now);
    if (s === "not-linked") throw new Error("linked");
    expect(s.pins).toEqual([{ id: (ok as { id: number }).id, x: 5050, z: 5050, icon: "loot", note: "ammo", by: "Ann", at: now, expiresAt: new Date(now.getTime() + PIN_TTL_MS) }]);
  });

  it("deletePin: any full member of the clan may delete; another clan's member cannot (WHERE, not post-filter)", async () => {
    const ok = await dropPinDb(db, "1", { x: 1, z: 1, icon: "danger", note: null }, now) as { ok: true; id: number };
    expect(await deletePinDb(db, "4", ok.id)).toEqual({ deleted: false });
    expect(await deletePinDb(db, "2", ok.id)).toEqual({ deleted: true });
    expect(await db.select().from(clanPins)).toEqual([]);
  });
});
