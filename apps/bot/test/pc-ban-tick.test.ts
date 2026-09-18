import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, playerDevices, identityLinks, verificationChallenges, bans, servers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { pcBanTick } from "../src/pc-ban-tick.js";

const URL = requireTestDatabaseUrl();
const PC = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOX = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("pcBanTick", () => {
  let db: Database;
  const now = new Date("2026-09-18T12:00:00Z");

  const desktop = (dayzId = PC, gamertag = "PCGuy") =>
    db.insert(playerDevices).values({ dayzId, device: "desktop", gamertag });
  const challenge = (dayzId: string, expiresAt: Date) =>
    db.insert(verificationChallenges).values({
      discordId: "d1", sequence: ["a", "b", "c"], issuedAt: now, expiresAt, targetDayzId: dayzId,
    } as never);

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate player_devices, identity_links, verification_challenges, bans, servers restart identity cascade`);
    // Same shape as apps/bot/test/ban-tick.test.ts; `restart identity` makes it id 1.
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true });
  });

  it("bans an unlinked desktop player", async () => {
    await desktop();
    const r = await pcBanTick(db, { serverId: 1, now });
    expect(r.banned.map((b) => b.dayzId)).toEqual([PC]);
    const [row] = await db.select().from(bans);
    expect(row!.reason).toBe("unlinked_pc");
    expect(row!.status).toBe("pending");
    expect(row!.expiresAt).toBeNull();   // ⚠️ permanent: a door, not a sentence
    expect(row!.gamertag).toBe("PCGuy");
  });

  it("leaves a console player alone", async () => {
    await db.insert(playerDevices).values({ dayzId: BOX, device: "console", gamertag: "BoxGuy" });
    expect((await pcBanTick(db, { serverId: 1, now })).banned).toEqual([]);
    expect(await db.select().from(bans)).toEqual([]);
  });

  it("leaves a linked desktop player alone", async () => {
    await desktop();
    await db.insert(identityLinks).values({ discordId: "d9", dayzId: PC, gamertag: "PCGuy", verifiedAt: now });
    expect((await pcBanTick(db, { serverId: 1, now })).banned).toEqual([]);
  });

  it("does not ban someone with a live challenge", async () => {
    await desktop();
    await challenge(PC, new Date(now.getTime() + 3600_000));
    expect((await pcBanTick(db, { serverId: 1, now })).banned).toEqual([]);
  });

  it("bans once the challenge has expired", async () => {
    await desktop();
    await challenge(PC, new Date(now.getTime() - 1000));
    expect((await pcBanTick(db, { serverId: 1, now })).banned.map((b) => b.dayzId)).toEqual([PC]);
  });

  it("does not write a second ban while one is active", async () => {
    await desktop();
    await pcBanTick(db, { serverId: 1, now });
    await pcBanTick(db, { serverId: 1, now });
    expect(await db.select().from(bans)).toHaveLength(1);
  });

  it("marks an applied ban lift_pending when the player starts linking", async () => {
    await desktop();
    await pcBanTick(db, { serverId: 1, now });
    await db.update(bans).set({ status: "applied" });
    await challenge(PC, new Date(now.getTime() + 3600_000));
    const r = await pcBanTick(db, { serverId: 1, now });
    expect(r.lifted.map((b) => b.dayzId)).toEqual([PC]);
    const [row] = await db.select().from(bans);
    expect(row!.status).toBe("lift_pending");
  });

  /** ⚠️ The abuse vector. Second time around, the door stays shut. */
  it("refuses a second lift, ever", async () => {
    await desktop();
    await pcBanTick(db, { serverId: 1, now });
    await db.update(bans).set({ status: "lifted" });
    const later = new Date(now.getTime() + 86_400_000);
    await challenge(PC, new Date(later.getTime() + 3600_000));
    // Their lapsed challenge already earned them a fresh ban row.
    await db.insert(bans).values({
      serverId: 1, dayzId: PC, gamertag: "PCGuy", bannedAt: later, status: "applied", reason: "unlinked_pc",
    } as never);
    expect((await pcBanTick(db, { serverId: 1, now: later })).lifted).toEqual([]);
  });

  /** ⚠️ A zone ban is not a PC ban and must never be lifted by starting a link. */
  it("never lifts a zone ban", async () => {
    await desktop();
    await db.insert(bans).values({
      serverId: 1, dayzId: PC, gamertag: "PCGuy", bannedAt: now, status: "applied", reason: "zone",
    } as never);
    await challenge(PC, new Date(now.getTime() + 3600_000));
    const r = await pcBanTick(db, { serverId: 1, now });
    expect(r.lifted).toEqual([]);
    const [row] = await db.select().from(bans).where(eq(bans.reason, "zone"));
    expect(row!.status).toBe("applied");
  });
});
