import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, factionMembers, identityLinks, intruderSightings, clanNotices, declarations, type Database } from "@factions/db";
import { declareSolo } from "@factions/declarations";
import { INTRUDER_ALERT_COOLDOWN_MS, WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { zoneTick } from "../src/zone-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const MEMBER = "M".repeat(40); const STRANGER = "X".repeat(40); const PENDING = "P".repeat(40); const SOLO = "S".repeat(40);
const Q = "8000.00:100.00:8000.00";

describe("zoneTick", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let factionId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table intruder_sightings, clan_notices, declarations, poles, faction_members, factions, identity_links, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    factionId = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: at(-100_000), x: 5000, z: 5000 })).id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: MEMBER, discordId: "1", role: "leader", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: PENDING, discordId: "2", role: "member", joinedAt: now, status: "pending", pendingSince: now },
    ]);
  });
  const fix = (dayzId: string, x: number, z: number, when = now, gamertag = "Sasha") => db.insert(events).values({
    serverId, admFileId, lineIndex: line++, type: "player.position", occurredAt: when, payload: { dayzId, gamertag, pos: { x, y: 100, z } },
  }).returning({ id: events.id });
  const built = (dayzId: string, x: number, z: number, part: string, structure = "Fence", type: "base.built" | "base.dismantled" = "base.built") => db.insert(events).values({
    serverId, admFileId, lineIndex: line++, type, occurredAt: now, payload: { dayzId, gamertag: "Sasha", action: type === "base.built" ? "built" : "dismantled", part, structure, tool: null, pos: { x, y: 100, z } },
  }).returning({ id: events.id });
  const notices = () => db.select({ kind: clanNotices.kind, target: clanNotices.target, payload: clanNotices.payload, to: clanNotices.discordTargetId }).from(clanNotices).orderBy(clanNotices.id);

  it("a stranger inside 100 m: one sighting, one channel notice with distance; a member and a fix outside are nothing", async () => {
    await fix(STRANGER, 5030, 5040);           // 50 m
    await fix(MEMBER, 5001, 5001);
    await fix(STRANGER, 5000 + WATCH_ZONE_RADIUS_M + 1, 5000, at(1000));
    const r = await zoneTick(db);
    expect(r).toMatchObject({ sightings: 1, alerts: 1 });
    const [s] = await db.select().from(intruderSightings);
    expect(s).toMatchObject({ dayzId: STRANGER, distanceM: 50, lastX: "5030.00", lastZ: "5040.00" });
    expect(await notices()).toEqual([{ kind: "intruder", target: "channel", payload: { gamertag: "Sasha", distance: 50 }, to: null }]);
  });

  it("a pending member is an intruder (§7)", async () => {
    await fix(PENDING, 5010, 5010);
    expect((await zoneTick(db)).alerts).toBe(1);
  });

  it("moves the pin on every fix, alerts once per INTRUDER_ALERT_COOLDOWN_MS, and the last in-zone fix survives a fix outside", async () => {
    await fix(STRANGER, 5010, 5010);
    await fix(STRANGER, 5020, 5020, at(5 * 60_000));
    await fix(STRANGER, 5030, 5030, at(INTRUDER_ALERT_COOLDOWN_MS + 1000));
    await fix(STRANGER, 9000, 9000, at(INTRUDER_ALERT_COOLDOWN_MS + 2000));
    const r = await zoneTick(db);
    expect(r).toMatchObject({ sightings: 3, alerts: 2 });
    const [s] = await db.select().from(intruderSightings);
    expect(s).toMatchObject({ lastX: "5030.00", lastZ: "5030.00", lastSeenAt: at(INTRUDER_ALERT_COOLDOWN_MS + 1000), lastAlertAt: at(INTRUDER_ALERT_COOLDOWN_MS + 1000) });
    expect((await notices()).map((n) => n.kind)).toEqual(["intruder", "intruder"]);
  });

  it("a solo declarant gets a DM instead; their own fix is nothing", async () => {
    await db.insert(identityLinks).values({ discordId: "900", dayzId: SOLO, gamertag: "Solo", verifiedAt: now });
    await db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at(-5000), payload: { dayzId: SOLO, gamertag: "Solo", texture: "Flag_White", poleKey: Q, pole: { x: 8000, y: 100, z: 8000 } } });
    expect(await declareSolo(db, { serverId, dayzId: SOLO, poleKey: Q, at: at(-4000) })).toMatchObject({ ok: true });
    await fix(SOLO, 8001, 8001);
    await fix(STRANGER, 8010, 8010);
    expect((await zoneTick(db)).alerts).toBe(1);
    expect(await notices()).toEqual([{ kind: "solo_intruder", target: "dm", payload: { gamertag: "Sasha", distance: 14 }, to: "900" }]);
  });

  it("dismantle and gate-build inside the zone by a non-member alert; by a member they do not; a gate is matched by name", async () => {
    await built(STRANGER, 5010, 5010, "wall_base_down", "Fence", "base.dismantled");
    await built(STRANGER, 5010, 5010, "gate_base", "Fence");
    await built(STRANGER, 5010, 5010, "wall_base_up", "Fence");   // built, not a gate: nothing
    await built(MEMBER, 5010, 5010, "gate_base", "Fence");
    const r = await zoneTick(db);
    expect(r.alerts).toBe(2);
    expect((await notices()).map((n) => [n.kind, n.payload])).toEqual([
      ["dismantle", { gamertag: "Sasha", part: "wall_base_down" }],
      ["gate_built", { gamertag: "Sasha" }],
    ]);
    expect(await db.select().from(intruderSightings)).toHaveLength(0);   // a build is not a sighting
  });

  it("⚠️ never writes a coordinate into a notice, and is replay-safe (cursor per event)", async () => {
    await fix(STRANGER, 5010, 5010);
    await zoneTick(db);
    await db.execute(sql`update consumer_cursors set last_event_id = 0`);
    await zoneTick(db);
    expect(await notices()).toHaveLength(1);
    for (const n of await notices()) expect(Object.keys(n.payload as object)).not.toEqual(expect.arrayContaining(["x", "z", "pos", "poleKey"]));
  });

  it("the Hub is nobody's zone: a fix at (100, 93) alerts no one", async () => {
    await fix(STRANGER, 100, 93);
    expect((await zoneTick(db)).alerts).toBe(0);
  });
});
