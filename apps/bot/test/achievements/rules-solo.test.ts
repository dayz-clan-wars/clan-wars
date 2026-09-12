import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementCounters, ceremonies, ceremonyParticipants, factions, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { SOLO_RULES } from "../../src/achievements/rules-solo.js";
import { seedServer, seedLink, seedSession, seedEvent, seedMembership, seedFaction, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const player = { kind: "player" as const, id: A };
const ctx = { now: d(60) };
const rule = (k: string) => SOLO_RULES[k as keyof typeof SOLO_RULES]!;

describe("solo rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("enlisted: the link, dated to verification", async () => {
    expect(await rule("enlisted")(db, player, ctx)).toEqual({ count: 0, target: 1 });
    await seedLink(db, { dayzId: A, discordId: "1", gamertag: "Ann", verifiedAt: t0 });
    expect(await rule("enlisted")(db, player, ctx)).toMatchObject({ count: 1, target: 1, earnedAt: t0 });
  });

  it("squad_up: the first full membership span", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    expect((await rule("squad_up")(db, player, ctx)).count).toBe(0);
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(2), leftAt: d(3) });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(5) });
    expect(await rule("squad_up")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: d(2) });
  });

  it("founder: a participant of the ceremony that produced a clan", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: d(1) });
    // Real `ceremonies` columns (packages/db/src/schema.ts ~line 415): pole_key/x/y/z,
    // window_start/window_end, status (provisional|claimed|expired), detected_at, expires_at.
    // The brief's guessed columns (texture/started_at/ends_at/status "completed") don't exist
    // on this table; only a row a faction can point at via `factions.ceremonyId` is needed.
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      windowStart: t0, windowEnd: d(1), status: "claimed", detectedAt: t0, expiresAt: d(1),
    }).returning();
    await db.update(factions).set({ ceremonyId: c!.id }).where(eq(factions.id, f.id));
    expect((await rule("founder")(db, player, ctx)).count).toBe(0);
    await db.insert(ceremonyParticipants).values({ ceremonyId: c!.id, dayzId: A, discordId: "1", gamertag: "Ann" });
    expect(await rule("founder")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: d(1) });
  });

  it("loyalist: 30 days in one clan, open spans measured to now, earned at day 30", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: t0, leftAt: d(29) });
    expect(await rule("loyalist")(db, player, ctx)).toMatchObject({ count: 29, target: 30 });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(29) });   // open, now = d(60)
    expect(await rule("loyalist")(db, player, ctx)).toMatchObject({ count: 31, earnedAt: d(59) });
  });

  it("long_haul / veteran: hours from closed sessions, earned when the running total crosses", async () => {
    for (let i = 0; i < 12; i++) await seedSession(db, { serverId, dayzId: A, from: d(i), to: new Date(d(i).getTime() + 2 * 3_600_000) });
    expect(await rule("long_haul")(db, player, ctx)).toMatchObject({ count: 24, earnedAt: new Date(d(11).getTime() + 2 * 3_600_000) });
    expect(await rule("veteran")(db, player, ctx)).toMatchObject({ count: 24, target: 100 });
    await seedSession(db, { serverId, dayzId: A, from: d(20), to: null });   // open: does not count
    expect((await rule("long_haul")(db, player, ctx)).count).toBe(24);
  });

  it("regular: seven consecutive UTC days with a session; a gap restarts the run", async () => {
    for (const i of [0, 1, 2, 4, 5, 6, 7, 8, 9]) await seedSession(db, { serverId, dayzId: A, from: h(24 * i + 1), to: h(24 * i + 2) });
    expect(await rule("regular")(db, player, ctx)).toMatchObject({ count: 6, target: 7 });
    await seedSession(db, { serverId, dayzId: A, from: h(24 * 10 + 1), to: h(24 * 10 + 2) });
    expect(await rule("regular")(db, player, ctx)).toMatchObject({ count: 7, earnedAt: h(24 * 10 + 1) });
  });

  it("wanderer / showman: counted from the player's own events", async () => {
    for (let i = 0; i < 10; i++) await seedEvent(db, { serverId, type: "player.teleported", at: h(i), payload: { dayzId: A, gamertag: "Ann" } });
    await seedEvent(db, { serverId, type: "player.teleported", at: h(20), payload: { dayzId: "B".repeat(36), gamertag: "Ben" } });
    expect(await rule("wanderer")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: h(9) });
    for (let i = 0; i < 49; i++) await seedEvent(db, { serverId, type: "emote.performed", at: h(i), payload: { dayzId: A, gamertag: "Ann", emote: "EmoteWave" } });
    expect(await rule("showman")(db, player, ctx)).toMatchObject({ count: 49, target: 50 });
  });

  it("explorer / cartographer: read the lifetime counters, earned when the counter crossed", async () => {
    expect((await rule("explorer")(db, player, ctx)).count).toBe(0);
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "explorer", value: 50, detail: { squares: [], crossedAt: h(3).toISOString() } });
    expect(await rule("explorer")(db, player, ctx)).toMatchObject({ count: 50, earnedAt: h(3) });
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "cartographer", value: 4, detail: {} });
    expect(await rule("cartographer")(db, player, ctx)).toMatchObject({ count: 4, target: 10 });
  });
});
