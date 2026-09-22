import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, awardGrants, boosterKits, boosterKitChallenges, identityLinks, players, type Database,
} from "@factions/db";
import { sql, eq, isNull } from "drizzle-orm";
import {
  awardsForDb, awardForDb, saveAwardPickDb, startAwardPlacementDb, cancelAwardPlacementDb,
} from "../src/awards";
import { boosterKitForDb, cancelKitPlacementDb, startKitPlacementDb } from "../src/booster-kit";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-22T12:00:00Z");
const UID = "A".repeat(40);
const FULL = { vest: "PlateCarrierVest_Black", pouches: "PlateCarrierPouches_Green", holster: "PlateCarrierHolster_Camo" };

describe("the award page's reads and writes", () => {
  let db: Database; let grantId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table award_grants, booster_kit_challenges, booster_kits, identity_links, players, servers restart identity cascade`);
    });
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
    await db.insert(players).values({ dayzId: UID, gamertag: "Ron", firstSeenAt: now, lastSeenAt: now });
    const [g] = await db.insert(awardGrants).values({
      awardKey: "plate-carrier", discordId: "1", grantedByDiscordId: "9", reason: "Won",
      grantedAt: now, placeBy: new Date("2026-09-29T12:00:00Z"),
    }).returning();
    grantId = g!.id;
  });

  const link = () => db.insert(identityLinks).values({ discordId: "1", dayzId: UID, gamertag: "Ron", verifiedAt: now });
  const pick = (slot: string, className: string, discordId = "1") =>
    saveAwardPickDb(db, { discordId, grantId, slot, className, now });
  const pickAll = async () => { for (const [s, c] of Object.entries(FULL)) await pick(s, c); };
  const place = (discordId = "1") => startAwardPlacementDb(db, { discordId, grantId, now, rng: () => 0.5 });

  it("lists the viewer's grants with their state", async () => {
    expect(await awardsForDb(db, "1", now)).toEqual([expect.objectContaining({ id: grantId, label: "Plate Carrier", state: "unplaced", reason: "Won" })]);
    expect(await awardsForDb(db, "2", now)).toEqual([]);
  });

  it("⚠️ another player's grant reads as missing", async () => {
    expect(await awardForDb(db, "2", grantId, now)).toBeNull();
    expect(await awardForDb(db, "1", 999, now)).toBeNull();
  });

  it("⚠️ another player's grant refuses every write as not-found", async () => {
    expect(await pick("vest", "PlateCarrierVest_Black", "2")).toEqual({ ok: false, reason: "not-found" });
    expect(await place("2")).toEqual({ ok: false, reason: "not-found" });
    expect(await cancelAwardPlacementDb(db, { discordId: "2", grantId, now })).toBe(false);
  });

  it("saves a pick checked against that award's slot", async () => {
    expect(await pick("vest", "PlateCarrierVest_Black")).toEqual({ ok: true });
    expect(await pick("vest", "PlateCarrierHolster_Black")).toEqual({ ok: false, reason: "bad-pick" });
    expect(await pick("mask", "GasMask")).toEqual({ ok: false, reason: "bad-slot" });
    expect((await awardForDb(db, "1", grantId, now))!.picks).toEqual({ vest: "PlateCarrierVest_Black" });
  });

  it("an empty class name clears a slot", async () => {
    await pick("vest", "PlateCarrierVest_Black");
    await pick("vest", "");
    expect((await awardForDb(db, "1", grantId, now))!.picks).toEqual({});
  });

  it("refuses picks once the grant has ended", async () => {
    await db.update(awardGrants).set({ revokedAt: now });
    expect(await pick("vest", "PlateCarrierVest_Black")).toEqual({ ok: false, reason: "ended" });
  });

  it("refuses to place until every slot is picked", async () => {
    await link();
    await pick("vest", "PlateCarrierVest_Black");
    expect(await place()).toEqual({ ok: false, reason: "incomplete" });
  });

  it("refuses to place with no linked character", async () => {
    await pickAll();
    expect(await place()).toEqual({ ok: false, reason: "not-linked" });
  });

  it("issues a sequence naming the grant, shown on the award and NOT on the kit", async () => {
    await link(); await pickAll();
    expect(await place()).toEqual({ ok: true });
    const [c] = await db.select().from(boosterKitChallenges);
    expect(c).toMatchObject({ awardGrantId: grantId, targetDayzId: UID, closedAt: null });
    expect((await awardForDb(db, "1", grantId, now))!.challenge?.steps).toHaveLength(c!.sequence.length);
    expect((await boosterKitForDb(db, "1", now)).challenge).toBeNull();
  });

  it("⚠️ placing an award closes an open kit sequence, and vice versa", async () => {
    await link(); await pickAll();
    await startKitPlacementDb(db, { discordId: "1", now, rng: () => 0.5 });
    await place();
    const open = await db.select().from(boosterKitChallenges).where(isNull(boosterKitChallenges.closedAt));
    expect(open).toHaveLength(1);
    expect(open[0]!.awardGrantId).toBe(grantId);
    await startKitPlacementDb(db, { discordId: "1", now, rng: () => 0.5 });
    const after = await db.select().from(boosterKitChallenges).where(isNull(boosterKitChallenges.closedAt));
    expect(after).toHaveLength(1);
    expect(after[0]!.awardGrantId).toBeNull();
  });

  it("⚠️ the kit's Cancel never closes an award's sequence", async () => {
    await link(); await pickAll(); await place();
    expect(await cancelKitPlacementDb(db, { discordId: "1", now })).toBe(false);
    expect(await cancelAwardPlacementDb(db, { discordId: "1", grantId, now })).toBe(true);
  });

  it("shows the spot as numbers only when all three coordinates are set", async () => {
    await db.update(awardGrants).set({ posX: "100.00", posY: "5.00", posZ: "200.00", placedAt: now }).where(eq(awardGrants.id, grantId));
    const v = await awardForDb(db, "1", grantId, now);
    expect(v!.spot).toEqual({ x: 100, y: 5, z: 200, placedAt: now });
    expect(v!.state).toBe("waiting");
  });
});
