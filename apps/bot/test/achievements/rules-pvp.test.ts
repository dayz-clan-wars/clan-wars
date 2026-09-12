import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PVP_RULES } from "../../src/achievements/rules-pvp.js";
import { seedServer, seedKill, seedSession, seedRaid, seedDefense, seedFaction, seedSeason, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36), C = "C".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);
const player = { kind: "player" as const, id: A };
const ctx = { now: m(100_000) };
const rule = (k: string) => PVP_RULES[k as keyof typeof PVP_RULES]!;

describe("pvp rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("first_blood / ten_down / centurion: PvP kills only — friendly fire and being killed do not count", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), friendlyFire: true });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(1) });
    expect((await rule("first_blood")(db, player, ctx)).count).toBe(0);
    for (let i = 0; i < 10; i++) await seedKill(db, { serverId, killer: A, victim: i % 2 ? B : C, at: m(10 + i), weapon: `W${i}`, distanceM: 20 });
    expect(await rule("first_blood")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(10) });
    expect(await rule("ten_down")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: m(19), evidence: { kills: 10 } });
    expect(await rule("centurion")(db, player, ctx)).toMatchObject({ count: 10, target: 100 });
  });

  it("marksman / sniper / point_blank: by distance, first qualifying kill, distance in the evidence", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), distanceM: 149.9 });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), distanceM: null });
    expect(await rule("marksman")(db, player, ctx)).toMatchObject({ count: 149, target: 150 });    // best so far, floored
    const far = await seedKill(db, { serverId, killer: A, victim: B, at: m(2), distanceM: 312.4, weapon: "Mosin" });
    expect(await rule("marksman")(db, player, ctx)).toMatchObject({ count: 312, earnedAt: m(2), evidenceId: far.id, evidence: { distanceM: 312, weapon: "Mosin" } });
    expect(await rule("sniper")(db, player, ctx)).toMatchObject({ count: 312, earnedAt: m(2) });
    expect((await rule("point_blank")(db, player, ctx)).count).toBe(0);
    await seedKill(db, { serverId, killer: A, victim: B, at: m(3), distanceM: 4.9 });
    expect(await rule("point_blank")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(3) });
  });

  it("arsenal: distinct weapons, earned on the kill that brought the tenth", async () => {
    for (let i = 0; i < 12; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i), weapon: `W${i % 10}` });
    expect(await rule("arsenal")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: m(9) });
  });

  it("hat_trick: three PvP kills inside one of the killer's sessions", async () => {
    await seedSession(db, { serverId, dayzId: A, from: m(0), to: m(60) });
    await seedSession(db, { serverId, dayzId: A, from: m(100), to: m(160) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(5) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(50) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(105) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(110), friendlyFire: true });
    expect(await rule("hat_trick")(db, player, ctx)).toMatchObject({ count: 2, target: 3 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(55) });
    expect(await rule("hat_trick")(db, player, ctx)).toMatchObject({ count: 3, earnedAt: m(55) });
  });

  it("killing_spree / unstoppable: the streak walk, reset by a PvP death", async () => {
    for (let i = 0; i < 4; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i) });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(4) });
    for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: A, victim: C, at: m(10 + i) });
    expect(await rule("killing_spree")(db, player, ctx)).toMatchObject({ count: 5, earnedAt: m(14) });
    expect(await rule("unstoppable")(db, player, ctx)).toMatchObject({ count: 5, target: 10 });
  });

  it("nemesis: five kills of the same player", async () => {
    for (let i = 0; i < 4; i++) { await seedKill(db, { serverId, killer: A, victim: B, at: m(i) }); await seedKill(db, { serverId, killer: A, victim: C, at: m(100 + i) }); }
    expect(await rule("nemesis")(db, player, ctx)).toMatchObject({ count: 4, target: 5 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(200) });
    expect(await rule("nemesis")(db, player, ctx)).toMatchObject({ count: 5, earnedAt: m(200), evidence: { victim: C, kills: 5 } });
  });

  it("payback: killing your killer within an hour, not after", async () => {
    await seedKill(db, { serverId, killer: B, victim: A, at: m(0) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(61) });
    expect((await rule("payback")(db, player, ctx)).count).toBe(0);
    await seedKill(db, { serverId, killer: C, victim: A, at: m(100) });
    const pay = await seedKill(db, { serverId, killer: A, victim: C, at: m(159) });
    expect(await rule("payback")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(159), evidenceId: pay.id });
  });

  it("flag_thief / home_defender / blue_on_blue", async () => {
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: t0, activatedAt: t0 });
    const season = await seedSeason(db, serverId, t0);
    expect((await rule("flag_thief")(db, player, ctx)).count).toBe(0);
    await seedRaid(db, { serverId, seasonId: season.id, victimFactionId: wolf.id, raiderDayzId: A, raiderFactionId: bear.id, at: m(5) });
    expect(await rule("flag_thief")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(5) });
    await seedDefense(db, { serverId, factionId: bear.id, seasonId: season.id, raisedByDayzId: A, at: m(9), siegeSeconds: 3600 });
    expect(await rule("home_defender")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(9), evidence: { siegeSeconds: 3600 } });
    expect((await rule("blue_on_blue")(db, player, ctx)).count).toBe(0);
    await seedKill(db, { serverId, killer: A, victim: B, at: m(20), friendlyFire: true });
    expect(await rule("blue_on_blue")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(20) });
  });
});
