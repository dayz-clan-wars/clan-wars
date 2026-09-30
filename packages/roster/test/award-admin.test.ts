import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, awardGrants, awardTransfers, clanNotices, boosterKitChallenges, identityLinks, players, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { grantAwardDb, revokeAwardDb, listAwardsDb, removeFromGuildDb } from "../src/internal/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-22T12:00:00Z");

describe("award administration", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table award_transfers, award_grants, booster_kit_challenges, clan_notices, identity_links, players, servers restart identity cascade`);
    });
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
  });

  const grant = (over: Partial<Parameters<typeof grantAwardDb>[1]> = {}) => grantAwardDb(db, {
    awardKey: "plate-carrier", winnerDiscordId: "1", grantedByDiscordId: "9",
    reason: "Winner, Sept king-of-the-hill", siteBaseUrl: "https://dayzclanwars.com", now, ...over,
  });

  it("lists who last gave each award away", async () => {
    const out = await grant();
    if (!out.ok) throw new Error("grant failed");
    await db.insert(awardTransfers).values([
      { awardGrantId: out.grantId, fromDiscordId: "5", toDiscordId: "6", transferredAt: now, remainingMs: 1 },
      { awardGrantId: out.grantId, fromDiscordId: "6", toDiscordId: "1", transferredAt: new Date(now.getTime() + 1), remainingMs: 1 },
    ]);
    const [r] = await listAwardsDb(db, { discordId: null, now });
    expect(r!.givenBy).toBe("6");
  });

  it("lists givenBy as null for an award never transferred", async () => {
    await grant();
    expect((await listAwardsDb(db, { discordId: null, now }))[0]!.givenBy).toBeNull();
  });

  it("writes the grant and its DM in one go, with a 7-day placement deadline", async () => {
    const out = await grant();
    expect(out).toMatchObject({ ok: true, placeBy: new Date("2026-09-29T12:00:00Z") });
    const [g] = await db.select().from(awardGrants);
    expect(g).toMatchObject({ awardKey: "plate-carrier", discordId: "1", grantedByDiscordId: "9", picks: {} });
    const [n] = await db.select().from(clanNotices);
    expect(n).toMatchObject({ kind: "award_granted", target: "dm", discordTargetId: "1", factionId: null });
    expect(n!.payload).toMatchObject({
      grantId: g!.id, awardKey: "plate-carrier", label: "Plate Carrier",
      awardUrl: `https://dayzclanwars.com/awards/${g!.id}`, placeBy: "2026-09-29T12:00:00.000Z",
    });
  });

  it("stores the catalogue's duration when no days are given, and puts it in the DM", async () => {
    expect(await grant()).toMatchObject({ ok: true, durationDays: 7 });
    const [g] = await db.select().from(awardGrants);
    expect(g!.durationDays).toBe(7);
    expect((await db.select().from(clanNotices))[0]!.payload).toMatchObject({ durationDays: 7 });
  });

  it("stores an admin's days instead of the default", async () => {
    expect(await grant({ durationDays: 3 })).toMatchObject({ ok: true, durationDays: 3 });
    expect((await db.select().from(awardGrants))[0]!.durationDays).toBe(3);
    expect(await grant({ durationDays: null })).toMatchObject({ ok: true, durationDays: 7 });
  });

  it.each([0, -1, 1.5, 91])("refuses %s days, and writes nothing", async (d) => {
    expect(await grant({ durationDays: d })).toEqual({ ok: false, reason: "bad-duration" });
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
  });

  it("⚠️ pre-picks a slot with only one item, and leaves real choices empty", async () => {
    await grant({ awardKey: "dead-rooster" });
    await grant();
    const [rooster, plate] = await db.select().from(awardGrants).orderBy(awardGrants.id);
    expect(rooster).toMatchObject({ picks: { rooster: "DeadRooster" }, durationDays: 14 });
    expect(plate!.picks).toEqual({});
  });

  it("grants the booster kit as an award", async () => {
    expect(await grant({ awardKey: "booster-kit" })).toMatchObject({ ok: true, durationDays: 7 });
    expect((await db.select().from(clanNotices))[0]!.payload).toMatchObject({ awardKey: "booster-kit", label: "Booster Kit" });
  });

  it("refuses an award key that is not in the catalogue, and writes nothing", async () => {
    expect(await grant({ awardKey: "golden-shovel" })).toEqual({ ok: false, reason: "unknown-award" });
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
  });

  it("refuses an empty reason", async () => {
    expect(await grant({ reason: "   " })).toEqual({ ok: false, reason: "no-reason" });
  });

  it("refuses with no active server, since a notice needs one", async () => {
    await db.update(servers).set({ active: false });
    expect(await grant()).toEqual({ ok: false, reason: "no-server" });
  });

  // ⚠️ Pins the order the task-10 review restored: an unknown key is a bad
  // request no matter the server state, so it must be caught before the
  // server lookup ever runs — not just before the transaction opens.
  it("reports an unknown award key ahead of a missing server, even when both are true", async () => {
    await db.update(servers).set({ active: false });
    expect(await grant({ awardKey: "golden-shovel" })).toEqual({ ok: false, reason: "unknown-award" });
  });

  it("gives a second win its own row", async () => {
    await grant();
    await grant();
    expect(await db.select().from(awardGrants)).toHaveLength(2);
  });

  it("revokes an open grant and closes its open challenge", async () => {
    const out = await grant();
    const id = (out as { grantId: number }).grantId;
    await db.insert(boosterKitChallenges).values({
      discordId: "1", targetDayzId: "A".repeat(40), sequence: ["EmoteSalute"], issuedAt: now, expiresAt: now, awardGrantId: id,
    });
    expect(await revokeAwardDb(db, { grantId: id, now })).toEqual({ ok: true });
    const [g] = await db.select().from(awardGrants);
    expect(g!.revokedAt).toEqual(now);
    const [c] = await db.select().from(boosterKitChallenges);
    expect(c!.closedAt).toEqual(now);
  });

  it("refuses to revoke a missing or already-ended grant", async () => {
    expect(await revokeAwardDb(db, { grantId: 999, now })).toEqual({ ok: false, reason: "not-found" });
    const id = ((await grant()) as { grantId: number }).grantId;
    await revokeAwardDb(db, { grantId: id, now });
    expect(await revokeAwardDb(db, { grantId: id, now })).toEqual({ ok: false, reason: "ended" });
  });

  it("lists open grants only, optionally for one winner, newest first", async () => {
    const a = ((await grant()) as { grantId: number }).grantId;
    const b = ((await grant({ winnerDiscordId: "2" })) as { grantId: number }).grantId;
    const c = ((await grant()) as { grantId: number }).grantId;
    await revokeAwardDb(db, { grantId: c, now });
    expect((await listAwardsDb(db, { discordId: null, now })).map((r) => r.id)).toEqual([b, a]);
    expect((await listAwardsDb(db, { discordId: "1", now })).map((r) => r.id)).toEqual([a]);
    expect((await listAwardsDb(db, { discordId: "1", now }))[0]).toMatchObject({ label: "Plate Carrier", state: "unplaced" });
  });

  it("⚠️ leaving the guild revokes open grants, linked or not", async () => {
    await grant();
    const out = await removeFromGuildDb(db, { discordId: "1", at: now });
    expect(out).toMatchObject({ linked: false, revokedAwards: 1 });
    expect((await db.select().from(awardGrants))[0]!.revokedAt).toEqual(now);
  });

  it("leaving the guild while linked revokes too, alongside the link", async () => {
    await db.insert(players).values({ dayzId: "A".repeat(40), gamertag: "Ron", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "1", dayzId: "A".repeat(40), gamertag: "Ron", verifiedAt: now });
    await grant();
    const out = await removeFromGuildDb(db, { discordId: "1", at: now });
    expect(out).toMatchObject({ linked: true, revokedAwards: 1 });
    expect(await db.select().from(identityLinks)).toEqual([]);
  });
});
