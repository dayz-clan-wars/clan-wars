import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, type Database } from "@factions/db";
import { ACHIEVEMENT_BY_KEY } from "@factions/domain";
import { sql } from "drizzle-orm";
import { REVOCABLE_KEYS, revokeAchievements } from "../../src/achievements/revoke.js";
import { PVP_RULES } from "../../src/achievements/rules-pvp.js";
import { seedServer, seedKill, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-09-20T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);

describe("revokeAchievements", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });
  const unlock = (key: string, earnedAt: Date, evidenceId: number | null = null) =>
    db.insert(achievementUnlocks).values({ ownerKind: "player", ownerId: A, key, earnedAt, evidenceId, evidence: {} });
  const held = async () => (await db.select({ key: achievementUnlocks.key }).from(achievementUnlocks)).map((r) => r.key).sort();

  it("⚠️ only kill-derived PvP keys — never a position, pin, raid or defence rule", () => {
    for (const k of REVOCABLE_KEYS) {
      expect(PVP_RULES[k]).toBeDefined();
      expect(ACHIEVEMENT_BY_KEY[k].group).toBe("pvp");
    }
    for (const k of ["flag_thief", "home_defender", "blue_on_blue"]) expect(REVOCABLE_KEYS).not.toContain(k);
  });

  it("revokes a badge that only Hub kills earned, and resets its progress", async () => {
    const k = await seedKill(db, { serverId, killer: A, victim: B, at: m(0), atHub: true });
    await unlock("first_blood", m(0), k.id);
    const r = await revokeAchievements(db, { apply: true });
    expect(r.revoked).toEqual([{ ownerId: A, key: "first_blood" }]);
    expect(await held()).toEqual([]);
    const [p] = await db.select().from(achievementProgress);
    expect(p).toMatchObject({ key: "first_blood", count: 0 });
  });

  it("keeps a badge that still holds, re-dated to the real kill that earns it", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), atHub: true });
    const real = await seedKill(db, { serverId, killer: A, victim: B, at: m(30) });
    await unlock("first_blood", m(0));
    const r = await revokeAchievements(db, { apply: true });
    expect(r.revoked).toEqual([]);
    expect(r.redated).toEqual([{ ownerId: A, key: "first_blood" }]);
    const [u] = await db.select().from(achievementUnlocks);
    expect(u).toMatchObject({ earnedAt: m(30), evidenceId: real.id });
  });

  it("a dry run reports and writes nothing", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), atHub: true });
    await unlock("first_blood", m(0));
    const r = await revokeAchievements(db, { apply: false });
    expect(r.revoked).toHaveLength(1);
    expect(await held()).toEqual(["first_blood"]);
  });

  it("⚠️ a rule that throws revokes nothing — an error is not 'no longer earned'", async () => {
    await unlock("first_blood", m(0));
    await db.execute(sql`alter table kills rename column at_hub to at_hub_gone`);
    try {
      const errors: string[] = [];
      const r = await revokeAchievements(db, { apply: true, onError: (_o, key) => errors.push(key) });
      expect(r.failed).toBe(1);
      expect(errors).toEqual(["first_blood"]);
      expect(await held()).toEqual(["first_blood"]);
    } finally {
      await db.execute(sql`alter table kills rename column at_hub_gone to at_hub`);
    }
  });
});
