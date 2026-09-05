import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, poles, events, admFiles, ceremonies, type Database,
} from "@factions/db";
import { RELEASED_POLE_GRACE_MS, HUB_POSITION } from "@factions/domain";
import { sql, eq, and } from "drizzle-orm";
import { declareTx, releaseTx, declarationForFaction, declarationForPlayer, publicPoles } from "../src/declaration-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;

describe("declaration store", () => {
  let db: Database;
  let serverId = 0;
  let eventId = 0;
  let factionId = 0;
  let ceremonyId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, poles, factions, ceremonies, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({
      serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
      payload: { dayzId: "A", gamertag: "G", texture: "Flag_White", poleKey: key(5000, 5000) },
    }).returning();
    eventId = e!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: key(5000, 5000), x: "5000.00", y: "100.00", z: "5000.00",
      windowStart: now, windowEnd: now, status: "claimed", detectedAt: now, expiresAt: now,
    }).returning();
    ceremonyId = c!.id;
  });

  const seedPole = (x: number, z: number, o: { texture?: string; raised?: boolean; graceUntil?: Date } = {}) =>
    db.insert(poles).values({
      serverId, map: "livonia", poleKey: key(x, z), x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
      currentTexture: o.texture ?? "Flag_White", flagRaised: o.raised ?? true,
      firstSeenAt: now, lastSeenAt: now, graceUntil: o.graceUntil ?? new Date(now.getTime() - 1),
    });

  const solo = (x: number, z: number, dayzId = "A") => db.transaction((tx) => declareTx(tx, {
    serverId, poleKey: key(x, z), x, y: 100, z, owner: { dayzId }, evidence: { eventId }, at: now,
  }));

  const clan = (x: number, z: number, fId: number, cId: number) => db.transaction((tx) => declareTx(tx, {
    serverId, poleKey: key(x, z), x, y: 100, z, owner: { factionId: fId }, evidence: { ceremonyId: cId }, at: now,
  }));

  it("declares a pole with nothing near it", async () => {
    expect(await solo(5000, 5000)).toEqual({ ok: true, id: expect.any(Number) });
    expect(await declarationForPlayer(db, serverId, "A")).toMatchObject({ poleKey: key(5000, 5000) });
  });

  it("refuses a pole within 200 m of another declaration", async () => {
    await solo(5000, 5000, "A");
    expect(await solo(5150, 5000, "B")).toEqual({ ok: false, reason: "too-close" });
  });

  it("⚠️ refuses a pole within 200 m of the Hub even with no declarations", async () => {
    expect(await solo(HUB_POSITION.x + 10, HUB_POSITION.z)).toEqual({ ok: false, reason: "too-close" });
  });

  it("refuses a second base for the same owner", async () => {
    await solo(5000, 5000, "A");
    expect(await solo(9000, 9000, "A")).toEqual({ ok: false, reason: "owner-has-base" });
  });

  it("refuses a pole somebody already declared", async () => {
    await solo(5000, 5000, "A");
    expect(await solo(5000, 5000, "B")).toEqual({ ok: false, reason: "pole-taken" });
  });

  it("⚠️ two concurrent claims 150 m apart produce one declaration", async () => {
    const a = solo(5000, 5000, "A");
    const b = solo(5150, 5000, "B");
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "too-close")).toHaveLength(1);
  });

  it("release deletes the row and gives the pole its 3-day grace", async () => {
    await seedPole(5000, 5000);
    await solo(5000, 5000, "A");
    const at = new Date(now.getTime() + 60_000);
    expect(await db.transaction((tx) => releaseTx(tx, { dayzId: "A", serverId }, at))).toBe(true);
    expect(await declarationForPlayer(db, serverId, "A")).toBeNull();
    const [p] = await db.select().from(poles).where(and(eq(poles.serverId, serverId), eq(poles.poleKey, key(5000, 5000))));
    expect(p!.graceUntil.getTime()).toBe(at.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("release of an owner with no declaration is false, not an error", async () => {
    expect(await db.transaction((tx) => releaseTx(tx, { factionId }, now))).toBe(false);
  });

  it("declares a pole for a clan, citing its ceremony", async () => {
    expect(await clan(5000, 5000, factionId, ceremonyId)).toEqual({ ok: true, id: expect.any(Number) });
    expect(await declarationForFaction(db, factionId)).toMatchObject({ poleKey: key(5000, 5000) });
  });

  it("refuses a second base for the same clan", async () => {
    await clan(5000, 5000, factionId, ceremonyId);
    const [c2] = await db.insert(ceremonies).values({
      serverId, poleKey: key(9000, 9000), x: "9000.00", y: "100.00", z: "9000.00",
      windowStart: now, windowEnd: now, status: "claimed", detectedAt: now, expiresAt: now,
    }).returning();
    expect(await clan(9000, 9000, factionId, c2!.id)).toEqual({ ok: false, reason: "owner-has-base" });
  });

  it("release by faction deletes the row and sets grace", async () => {
    await seedPole(5000, 5000);
    await clan(5000, 5000, factionId, ceremonyId);
    const at = new Date(now.getTime() + 60_000);
    expect(await db.transaction((tx) => releaseTx(tx, { factionId }, at))).toBe(true);
    expect(await declarationForFaction(db, factionId)).toBeNull();
    const [p] = await db.select().from(poles).where(and(eq(poles.serverId, serverId), eq(poles.poleKey, key(5000, 5000))));
    expect(p!.graceUntil.getTime()).toBe(at.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("a solo and a clan can't both hold one pole", async () => {
    await solo(5000, 5000, "A");
    expect(await clan(5000, 5000, factionId, ceremonyId)).toEqual({ ok: false, reason: "pole-taken" });
  });

  describe("publicPoles", () => {
    it("lists an undeclared, raised pole past its grace, with its texture", async () => {
      await seedPole(5000, 5000, { texture: "Flag_Wolf" });
      expect(await publicPoles(db, serverId, now)).toEqual([{ poleKey: key(5000, 5000), x: "5000.00", y: "100.00", z: "5000.00", texture: "Flag_Wolf" }]);
    });

    it("⚠️ an undeclared base flying a CLAIMED texture is still public", async () => {
      // Base-declaration §2.1: rule 2 is texture-agnostic. This is the one a
      // future "optimisation" is most likely to break.
      await seedPole(5000, 5000, { texture: "Flag_Bear" });
      expect(await publicPoles(db, serverId, now)).toHaveLength(1);
    });

    it("hides a declared pole, a lowered pole, and a pole inside grace", async () => {
      await seedPole(5000, 5000); await solo(5000, 5000, "A");
      await seedPole(6000, 6000, { raised: false });
      await seedPole(7000, 7000, { graceUntil: new Date(now.getTime() + 1) });
      expect(await publicPoles(db, serverId, now)).toEqual([]);
    });

    it("orders by poleKey ascending regardless of insertion order", async () => {
      // Inserted in reverse key order — the ordering has to come from the
      // query's own `orderBy`, not from insertion or id order.
      await seedPole(9000, 9000);
      await seedPole(5000, 5000);
      expect(await publicPoles(db, serverId, now)).toEqual([
        { poleKey: key(5000, 5000), x: "5000.00", y: "100.00", z: "5000.00", texture: "Flag_White" },
        { poleKey: key(9000, 9000), x: "9000.00", y: "100.00", z: "9000.00", texture: "Flag_White" },
      ]);
    });
  });
});
