import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, factions, factionMembers, claimDrafts, ceremonies, servers, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const now = new Date("2026-08-31T12:00:00Z");

describe("faction schema", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, claim_drafts, factions, ceremonies, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const ceremony = (overrides: Record<string, unknown> = {}) => db.insert(ceremonies).values({
    serverId, poleKey: "1:2:3", windowStart: now, windowEnd: new Date(now.getTime() + 600_000),
    status: "provisional", detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    x: "1.00", y: "2.00", z: "3.00",
    ...overrides,
  }).returning();

  const faction = (o: Record<string, unknown> = {}) => db.insert(factions).values({
    serverId, name: "The Bears", tag: "BEAR", texture: "Flag_Bear",
    poleKey: "1:2:3", x: "1.00", y: "2.00", z: "3.00",
    status: "reserved", leaderDiscordId: "100", createdAt: now,
    reservedUntil: new Date(now.getTime() + 86_400_000), ...o,
  }).returning();

  it("creates a reserved faction", async () => {
    const [f] = await faction();
    expect(f?.status).toBe("reserved");
  });

  it("rejects an unknown status", async () => {
    await expect(faction({ status: "banana" })).rejects.toThrow(/factions_status_valid/);
  });

  it("allows only one holder of a flag per server", async () => {
    await faction();
    await expect(faction({ tag: "BR2", poleKey: "9:9:9" })).rejects.toThrow(/factions_holding_texture_uniq/);
  });

  it("frees the flag when the holder disbands", async () => {
    // The whole reclamation mechanism. A disbanded faction must release its
    // identity or a 33-slot pool starves permanently.
    const [f] = await faction();
    await db.update(factions).set({ status: "disbanded" }).where(sql`id = ${f!.id}`);
    await expect(faction({ tag: "BR2", poleKey: "9:9:9" })).resolves.toBeDefined();
  });

  it("frees the flag when a reservation lapses", async () => {
    const [f] = await faction();
    await db.update(factions).set({ status: "lapsed" }).where(sql`id = ${f!.id}`);
    await expect(faction({ tag: "BR2", poleKey: "9:9:9" })).resolves.toBeDefined();
  });

  it("treats tags case-insensitively", async () => {
    // BEAR and bear in channel names are the same tag to a human.
    await faction();
    await expect(faction({ tag: "bear", texture: "Flag_Wolf", poleKey: "9:9:9" }))
      .rejects.toThrow(/factions_holding_tag_uniq/);
  });

  it("allows only one faction per pole", async () => {
    await faction();
    await expect(faction({ tag: "WOLF", texture: "Flag_Wolf" }))
      .rejects.toThrow(/factions_holding_pole_uniq/);
  });

  it("refuses a duplicate roster member", async () => {
    const [f] = await faction();
    const m = { factionId: f!.id, dayzId: UID_A, discordId: "100", role: "leader" as const, joinedAt: now };
    await db.insert(factionMembers).values(m);
    await expect(db.insert(factionMembers).values(m)).rejects.toThrow(/faction_members_uniq/);
  });

  it("rejects an unknown role", async () => {
    const [f] = await faction();
    await expect(db.insert(factionMembers).values({
      factionId: f!.id, dayzId: UID_A, discordId: "100", role: "emperor", joinedAt: now,
    })).rejects.toThrow(/faction_members_role_valid/);
  });

  it("requires reserved_until on a reserved faction", async () => {
    // A reservation with no deadline is a permanent hole in the pool.
    await expect(faction({ reservedUntil: null })).rejects.toThrow(/factions_reserved_has_deadline/);
  });

  it("allows different players to each hold a draft for the same ceremony", async () => {
    // A ceremony seats several participants and any of them may run the claim
    // command — each needs their own draft rather than colliding on the first.
    const [c] = await ceremony();
    await db.insert(claimDrafts).values({
      ceremonyId: c!.id, discordId: "100", name: "The Bears", tag: "BEAR", texture: "Flag_Bear", createdAt: now,
    });
    await expect(db.insert(claimDrafts).values({
      ceremonyId: c!.id, discordId: "200", name: "The Wolves", tag: "WOLF", texture: "Flag_Wolf", createdAt: now,
    })).resolves.toBeDefined();
  });

  it("refuses a second draft from the same player on one ceremony", async () => {
    const [c] = await ceremony();
    const draft = { ceremonyId: c!.id, discordId: "100", name: "The Bears", tag: "BEAR", texture: "Flag_Bear", createdAt: now };
    await db.insert(claimDrafts).values(draft);
    await expect(db.insert(claimDrafts).values(draft)).rejects.toThrow(/claim_drafts_ceremony_discord_uniq/);
  });
});
