import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, awardGrants, awardTransfers, boosterKitChallenges, clanNotices, identityLinks, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { giveAwardDb, saveAwardPickDb, awardForDb } from "../src/awards";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-30T12:00:00Z");
const H = 3_600_000; const D = 24 * H;
const WEEK = 7 * D;

describe("giving an award away", () => {
  let db: Database; let grantId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table award_transfers, award_grants, booster_kit_challenges, clan_notices, identity_links, servers restart identity cascade`);
    });
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
    await db.insert(identityLinks).values([
      { discordId: "1", dayzId: "A".repeat(40), gamertag: "Ron", verifiedAt: now },
      { discordId: "2", dayzId: "B".repeat(40), gamertag: "Ann", verifiedAt: now },
    ]);
    const [g] = await db.insert(awardGrants).values({
      awardKey: "plate-carrier", discordId: "1", grantedByDiscordId: "9", reason: "Won", durationDays: 3,
      grantedAt: now, placeBy: new Date(now.getTime() + WEEK),
      picks: { vest: "PlateCarrierVest_Black", pouches: "PlateCarrierPouches_Green", holster: "PlateCarrierHolster_Camo" },
    }).returning();
    grantId = g!.id;
  });

  const give = (to: string, from = "1", at = now) =>
    giveAwardDb(db, { discordId: from, grantId, toGamertag: to, siteBaseUrl: "https://dayzclanwars.com", now: at });
  const row = async () => (await db.select().from(awardGrants).where(eq(awardGrants.id, grantId)))[0]!;
  const place = () => db.update(awardGrants).set({ posX: "1.00", posY: "2.00", posZ: "3.00", placedAt: now }).where(eq(awardGrants.id, grantId));

  it("moves an unplaced award, with a fresh week and its full length saved", async () => {
    expect(await give("Ann")).toEqual({ ok: true, toGamertag: "Ann" });
    const g = await row();
    expect(g).toMatchObject({ discordId: "2", remainingMs: 3 * D, liveFrom: null, expiresAt: null, placedAt: null });
    expect(g.placeBy.getTime()).toBe(now.getTime() + WEEK);
  });

  it("⚠️ pauses a live award: spot and clock cleared, the time left saved", async () => {
    await place();
    await db.update(awardGrants).set({ liveFrom: new Date(now.getTime() - D), expiresAt: new Date(now.getTime() + 2 * D) }).where(eq(awardGrants.id, grantId));
    await give("Ann");
    expect(await row()).toMatchObject({ discordId: "2", remainingMs: 2 * D, posX: null, posY: null, posZ: null, placedAt: null, liveFrom: null, expiresAt: null });
  });

  it("closes the giver's open placement sequence for it", async () => {
    await db.insert(boosterKitChallenges).values({
      discordId: "1", targetDayzId: "A".repeat(40), sequence: ["EmoteGreeting"], progressIndex: 0,
      issuedAt: now, expiresAt: new Date(now.getTime() + H), awardGrantId: grantId,
    });
    await give("Ann");
    const [c] = await db.select().from(boosterKitChallenges);
    expect(c!.closedAt).toEqual(now);
  });

  it("records the transfer and DMs both players", async () => {
    await give("Ann");
    expect(await db.select().from(awardTransfers)).toEqual([expect.objectContaining({
      awardGrantId: grantId, fromDiscordId: "1", toDiscordId: "2", transferredAt: now, remainingMs: 3 * D,
    })]);
    const notices = await db.select().from(clanNotices).orderBy(clanNotices.id);
    expect(notices.map((n) => [n.kind, n.discordTargetId])).toEqual([["award_received", "2"], ["award_given", "1"]]);
    expect(notices[0]!.payload).toMatchObject({ grantId, label: "Plate Carrier", fromName: "Ron", remainingMs: 3 * D, awardUrl: `https://dayzclanwars.com/awards/${grantId}` });
    expect(notices[1]!.payload).toMatchObject({ grantId, label: "Plate Carrier", toName: "Ann" });
  });

  it("⚠️ a second transfer keeps the saved time, not the full length", async () => {
    await db.update(awardGrants).set({ remainingMs: 5 * H }).where(eq(awardGrants.id, grantId));
    await give("Ann");
    await give("Ron", "2");
    expect(await row()).toMatchObject({ discordId: "1", remainingMs: 5 * H });
  });

  it("hands the page to the new owner and takes it from the old one", async () => {
    await give("Ann");
    expect(await awardForDb(db, "1", grantId, now)).toBeNull();
    expect(await saveAwardPickDb(db, { discordId: "1", grantId, slot: "vest", className: "PlateCarrierVest", now })).toEqual({ ok: false, reason: "not-found" });
    expect(await saveAwardPickDb(db, { discordId: "2", grantId, slot: "vest", className: "PlateCarrierVest", now })).toEqual({ ok: true });
  });

  it("resolves the recipient's gamertag regardless of case", async () => {
    expect(await give("ann")).toEqual({ ok: true, toGamertag: "Ann" });
  });

  it.each([
    ["a grant that is not the giver's", () => giveAwardDb(db, { discordId: "2", grantId, toGamertag: "Ron", siteBaseUrl: "x", now }), "not-found"],
    ["a recipient nobody has linked", () => giveAwardDb(db, { discordId: "1", grantId, toGamertag: "Nobody", siteBaseUrl: "x", now }), "recipient-not-linked"],
    ["an empty recipient", () => giveAwardDb(db, { discordId: "1", grantId, toGamertag: "  ", siteBaseUrl: "x", now }), "recipient-not-linked"],
    ["the giver themselves", () => giveAwardDb(db, { discordId: "1", grantId, toGamertag: "Ron", siteBaseUrl: "x", now }), "recipient-is-you"],
  ])("refuses %s", async (_n, call, reason) => {
    expect(await call()).toEqual({ ok: false, reason });
    expect((await row()).discordId).toBe("1");
    expect(await db.select().from(awardTransfers)).toEqual([]);
  });

  it("refuses an award that has ended", async () => {
    await db.update(awardGrants).set({ revokedAt: now }).where(eq(awardGrants.id, grantId));
    expect(await give("Ann")).toEqual({ ok: false, reason: "ended" });
  });

  it("refuses when two linked players share the name", async () => {
    await db.insert(identityLinks).values({ discordId: "3", dayzId: "C".repeat(40), gamertag: "ANN", verifiedAt: now });
    expect(await give("aNN")).toEqual({ ok: false, reason: "ambiguous-gamertag" });
  });
});
