import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementCounters, achievementUnlocks, ceremonies, ceremonyParticipants, events, factions, type Database } from "@factions/db";
import { EMOTES } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { SOLO_RULES } from "../../src/achievements/rules-solo.js";
import { makeCtx } from "../../src/achievements/types.js";
import { achievementsTick } from "../../src/achievements/tick.js";
import { seedServer, seedLink, seedSession, seedEvent, seedMembership, seedFaction, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const player = { kind: "player" as const, id: A };
const NOW = d(60);
const mk = () => makeCtx(NOW);
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
    expect(await rule("enlisted")(db, player, mk())).toEqual({ count: 0, target: 1 });
    await seedLink(db, { dayzId: A, discordId: "1", gamertag: "Ann", verifiedAt: t0 });
    expect(await rule("enlisted")(db, player, mk())).toMatchObject({ count: 1, target: 1, earnedAt: t0 });
  });

  it("squad_up: the first full membership span", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    expect((await rule("squad_up")(db, player, mk())).count).toBe(0);
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(2), leftAt: d(3) });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(5) });
    expect(await rule("squad_up")(db, player, mk())).toMatchObject({ count: 1, earnedAt: d(2) });
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
    expect((await rule("founder")(db, player, mk())).count).toBe(0);
    await db.insert(ceremonyParticipants).values({ ceremonyId: c!.id, dayzId: A, discordId: "1", gamertag: "Ann" });
    expect(await rule("founder")(db, player, mk())).toMatchObject({ count: 1, earnedAt: d(1) });
  });

  it("loyalist: 30 days in one clan, open spans measured to now, earned at day 30", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: t0, leftAt: d(29) });
    expect(await rule("loyalist")(db, player, mk())).toMatchObject({ count: 29, target: 30 });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(29) });   // open, now = d(60)
    expect(await rule("loyalist")(db, player, mk())).toMatchObject({ count: 31, earnedAt: d(59) });
  });

  it("long_haul / veteran: hours from closed sessions, earned when the running total crosses", async () => {
    for (let i = 0; i < 12; i++) await seedSession(db, { serverId, dayzId: A, from: d(i), to: new Date(d(i).getTime() + 2 * 3_600_000) });
    expect(await rule("long_haul")(db, player, mk())).toMatchObject({ count: 24, earnedAt: new Date(d(11).getTime() + 2 * 3_600_000) });
    expect(await rule("veteran")(db, player, mk())).toMatchObject({ count: 24, target: 100 });
    await seedSession(db, { serverId, dayzId: A, from: d(20), to: null });   // open: does not count
    expect((await rule("long_haul")(db, player, mk())).count).toBe(24);
  });

  it("regular: seven consecutive UTC days with a session; a gap restarts the run", async () => {
    for (const i of [0, 1, 2, 4, 5, 6, 7, 8, 9]) await seedSession(db, { serverId, dayzId: A, from: h(24 * i + 1), to: h(24 * i + 2) });
    expect(await rule("regular")(db, player, mk())).toMatchObject({ count: 6, target: 7 });
    await seedSession(db, { serverId, dayzId: A, from: h(24 * 10 + 1), to: h(24 * 10 + 2) });
    expect(await rule("regular")(db, player, mk())).toMatchObject({ count: 7, earnedAt: h(24 * 10 + 1) });
  });

  it("wanderer is retired: the tick never unlocks it from teleports, and an existing unlock survives", async () => {
    const B = "B".repeat(36);
    await seedLink(db, { dayzId: A, discordId: "1", gamertag: "Ann", verifiedAt: t0 });
    await seedLink(db, { dayzId: B, discordId: "2", gamertag: "Ben", verifiedAt: t0 });
    for (let i = 0; i < 10; i++) await seedEvent(db, { serverId, type: "player.teleported", at: h(i), payload: { dayzId: A, gamertag: "Ann" } });
    await db.insert(achievementUnlocks).values({ ownerKind: "player", ownerId: B, key: "wanderer", earnedAt: t0 });
    expect(rule("wanderer")).toBeUndefined();
    await achievementsTick(db, { now: NOW, everyone: true, announce: false });
    const wanderers = await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.key, "wanderer"));
    expect(wanderers.map((u) => u.ownerId)).toEqual([B]);
    // The tick did run for both: their enlisted unlocks landed.
    expect((await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.key, "enlisted"))).length).toBe(2);
  });

  it("showman: counted from the player's own events", async () => {
    for (let i = 0; i < 49; i++) await seedEvent(db, { serverId, type: "emote.performed", at: h(i), payload: { dayzId: A, gamertag: "Ann", emote: "EmoteWave" } });
    expect(await rule("showman")(db, player, mk())).toMatchObject({ count: 49, target: 50 });
  });

  it("explorer / cartographer: read the lifetime counters, earned when the counter crossed", async () => {
    expect((await rule("explorer")(db, player, mk())).count).toBe(0);
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "explorer", value: 50, detail: { squares: [], crossedAt: h(3).toISOString() } });
    expect(await rule("explorer")(db, player, mk())).toMatchObject({ count: 50, earnedAt: h(3) });
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "cartographer", value: 4, detail: {} });
    expect(await rule("cartographer")(db, player, mk())).toMatchObject({ count: 4, target: 10 });
  });

  // ── Emotes and milestones (spec 2026-10-20-achievements-150, Task B7) ──────
  const emote = (at: Date, name: string, who = A) => seedEvent(db, { serverId, type: "emote.performed", at, payload: { dayzId: who, gamertag: "Ann", emote: name } });

  it("mime: 10 different emotes, earned at the tenth distinct one; repeats and other players do not count", async () => {
    for (let i = 0; i < 9; i++) { await emote(h(i * 2), EMOTES[i]!); await emote(h(i * 2 + 1), EMOTES[i]!); }
    await emote(h(30), EMOTES[20]!, "B".repeat(36));
    expect(await rule("mime")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    const tenth = await emote(h(40), EMOTES[9]!);
    expect(await rule("mime")(db, player, mk())).toMatchObject({ count: 10, earnedAt: h(40), evidenceId: tenth.id });
  });

  it("full_repertoire: every emote in EMOTES; a token outside the list is not progress", async () => {
    for (let i = 0; i < EMOTES.length - 1; i++) await emote(h(i), EMOTES[i]!);
    await emote(h(50), "EmoteWave");   // not a console emote: never counts toward the set
    expect(await rule("full_repertoire")(db, player, mk())).toMatchObject({ count: EMOTES.length - 1, target: EMOTES.length });
    await emote(h(60), EMOTES[0]!);   // a repeat is not a new one
    expect((await rule("full_repertoire")(db, player, mk())).count).toBe(EMOTES.length - 1);
    const last = await emote(h(70), EMOTES[EMOTES.length - 1]!);
    expect(await rule("full_repertoire")(db, player, mk())).toMatchObject({ count: EMOTES.length, earnedAt: h(70), evidenceId: last.id });
  });

  it("rps_champ: 10 rock-paper-scissors emotes; other emotes do not count", async () => {
    for (let i = 0; i < 9; i++) await emote(h(i), "EmoteRPSRandom");
    await emote(h(10), "EmoteSalute"); await emote(h(11), "EmoteRPSRandom", "B".repeat(36));
    expect(await rule("rps_champ")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    await emote(h(12), "EmoteRPSRandom");
    expect(await rule("rps_champ")(db, player, mk())).toMatchObject({ count: 10, earnedAt: h(12) });
  });

  it("performer: 500 emotes of any kind, as showman counts them", async () => {
    // One seeded line for its adm file, then the rest in one insert (500 round trips is slow).
    const { admFileId } = await emote(h(0), EMOTES[0]!);
    await db.insert(events).values(Array.from({ length: 499 }, (_, j) => j + 1).map((i) => ({
      serverId, admFileId, lineIndex: 100_000 + i, type: "emote.performed" as never, occurredAt: h(i), payload: { dayzId: A, gamertag: "Ann", emote: EMOTES[i % EMOTES.length] },
    })));
    expect(await rule("showman")(db, player, mk())).toMatchObject({ count: 50, earnedAt: h(49) });
    expect(await rule("performer")(db, player, mk())).toMatchObject({ count: 500, earnedAt: h(499) });
  });

  it("lifer: 500 hours from closed sessions, earned at the disconnect that crossed", async () => {
    for (let i = 0; i < 49; i++) await seedSession(db, { serverId, dayzId: A, from: d(i), to: new Date(d(i).getTime() + 10 * 3_600_000) });
    expect(await rule("lifer")(db, player, mk())).toMatchObject({ count: 490, target: 500 });
    await seedSession(db, { serverId, dayzId: A, from: d(49), to: new Date(d(49).getTime() + 10 * 3_600_000) });
    expect(await rule("lifer")(db, player, mk())).toMatchObject({ count: 500, earnedAt: new Date(d(49).getTime() + 10 * 3_600_000) });
  });

  it("devoted: 30 consecutive UTC days, the regular rule parameterised; a gap restarts the run", async () => {
    const day = (i: number) => seedSession(db, { serverId, dayzId: A, from: h(24 * i + 1), to: h(24 * i + 2) });
    for (let i = 0; i < 29; i++) await day(i);
    await day(30);                                   // day 29 missed: the run restarts at 30
    expect(await rule("devoted")(db, player, mk())).toMatchObject({ count: 29, target: 30 });
    for (let i = 31; i < 59; i++) await day(i);      // 30..58 is 29 days
    expect((await rule("devoted")(db, player, mk())).count).toBe(29);
    await day(59);
    expect(await rule("devoted")(db, player, mk())).toMatchObject({ count: 30, earnedAt: h(24 * 59 + 1) });
    expect(await rule("regular")(db, player, mk())).toMatchObject({ count: 7, earnedAt: h(24 * 6 + 1) });
  });

  it("globetrotter: reads the explorer counter's set, earned when it crossed 150, not when it crossed 50", async () => {
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "explorer", value: 149, detail: { squares: [], crossedAt: h(3).toISOString() } });
    expect(await rule("globetrotter")(db, player, mk())).toEqual({ count: 149, target: 150 });
    await db.update(achievementCounters).set({ value: 150, detail: { squares: [], crossedAt: h(3).toISOString(), globetrotterAt: h(9).toISOString() } });
    expect(await rule("globetrotter")(db, player, mk())).toMatchObject({ count: 150, earnedAt: h(9) });
    expect(await rule("explorer")(db, player, mk())).toMatchObject({ earnedAt: h(3) });
  });
});
