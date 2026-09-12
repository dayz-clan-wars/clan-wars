import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, clanNotices, consumerCursors, factions, playerPositions, clanPins, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { achievementsTick } from "../../src/achievements/tick.js";
import { RULES } from "../../src/achievements/rules.js";
import { seedServer, seedLink, seedKill, seedFaction, seedMembership, seedEvent, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);
const CH = "123456789012345678";

describe("achievementsTick", () => {
  let db: Database; let serverId = 0; let bear = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 })).id;
    await db.update(factions).set({ discordTextChannelId: "999999999999999999" }).where(eq(factions.id, bear));
    await seedLink(db, { dayzId: A, discordId: "111111111111111111", gamertag: "Ann", verifiedAt: t0 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: A, joinedAt: t0, leftAt: null });
  });

  it("evaluates only owners touched since the last pass, unlocks with evidence, and queues the three notices", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), weapon: "Mosin", distanceM: 320 });
    const r = await achievementsTick(db, { now: m(10), achievementsChannelId: CH });
    expect(r.evaluated).toBeGreaterThanOrEqual(2);   // A (killer) and B (victim), plus the clan via membership
    const unlocks = await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.ownerId, A));
    const keys = unlocks.map((u) => u.key).sort();
    expect(keys).toEqual(expect.arrayContaining(["enlisted", "squad_up", "first_blood", "marksman", "sniper"]));
    expect(unlocks.find((u) => u.key === "sniper")).toMatchObject({ earnedAt: m(1), evidence: { distanceM: 320, weapon: "Mosin" } });
    const notices = await db.select().from(clanNotices).where(sql`${clanNotices.payload}->>'key' = 'sniper'`);
    const targets = notices.map((n) => `${n.target}:${n.factionId ?? "-"}:${n.discordTargetId ?? "-"}`).sort();
    expect(targets).toEqual([`channel:${bear}:999999999999999999`, `channel:-:${CH}`, `dm:${bear}:111111111111111111`].sort());
    // ⚠️ A linked player's ownerName is their DISCORD ID, not their gamertag: notice-text's
    // `person()` turns an all-digit value into a mention, and a mention is the point.
    expect(notices[0]!.payload).toMatchObject({ key: "sniper", name: "Sniper", ownerKind: "player", ownerName: "111111111111111111", clanTag: "BEAR" });
    // progress cached for every key of the owner's kind
    expect((await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, A))).length).toBe(38);
    // second pass: nothing new touched, nothing evaluated, nothing duplicated
    const again = await achievementsTick(db, { now: m(11), achievementsChannelId: CH });
    expect(again).toMatchObject({ evaluated: 0, unlocked: 0 });
  });

  it("a team unlock notifies the clan channel, the public channel and every full member by DM", async () => {
    await seedLink(db, { dayzId: B, discordId: "222222222222222222", gamertag: "Ben", verifiedAt: t0 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: B, joinedAt: t0, leftAt: null });
    await db.execute(sql`insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at, status)
      values (${bear}, ${serverId}, ${A}, '111111111111111111', 'leader', ${t0.toISOString()}, 'full'), (${bear}, ${serverId}, ${B}, '222222222222222222', 'member', ${t0.toISOString()}, 'full')`);
    await achievementsTick(db, { now: m(10), achievementsChannelId: CH });
    const notices = await db.select().from(clanNotices).where(sql`${clanNotices.payload}->>'key' = 'colors_raised'`);
    expect(notices.filter((n) => n.target === "dm").map((n) => n.discordTargetId).sort()).toEqual(["111111111111111111", "222222222222222222"]);
    expect(notices.filter((n) => n.target === "channel")).toHaveLength(2);
  });

  it("a rule that throws skips only itself; the owner's other unlocks land and the pass reports the failure", async () => {
    const original = RULES.enlisted;
    (RULES as Record<string, unknown>).enlisted = async () => { throw new Error("boom"); };
    try {
      await seedKill(db, { serverId, killer: A, victim: B, at: m(1) });
      const r = await achievementsTick(db, { now: m(10) });
      // Two: `failed` counts (owner, key) evaluations, and the kill touches both A and B,
      // so the one broken rule throws once for each of them.
      expect(r.failed).toBe(2);
      expect((await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.key, "first_blood"))).length).toBe(1);
    } finally { (RULES as Record<string, unknown>).enlisted = original; }
  });

  it("batches: at most `batch` owners per pass, the rest carried to the next", async () => {
    for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: `${i}`.padStart(36, "K"), victim: `${i}`.padStart(36, "V"), at: m(i) });
    const first = await achievementsTick(db, { now: m(10), batch: 4 });
    expect(first.evaluated).toBe(4);
    expect(first.carried).toBeGreaterThan(0);
    // Each capped pass takes the NEXT four owners — never the same four again — until the
    // set drains and the watermarks finally advance.
    let passes = 1, total = first.evaluated;
    for (;;) {
      const r = await achievementsTick(db, { now: m(10 + passes), batch: 4 });
      passes += 1;
      expect(r.evaluated).toBeLessThanOrEqual(4);
      if (r.evaluated === 0) break;
      total += r.evaluated;
      expect(passes).toBeLessThan(10);   // a livelock would never reach an empty pass
    }
    expect(total).toBeGreaterThanOrEqual(10);   // every killer and victim evaluated
    // Every one of the ten players the kills touched has a cached progress row.
    for (let i = 0; i < 5; i++) {
      for (const id of [`${i}`.padStart(36, "K"), `${i}`.padStart(36, "V")]) {
        expect((await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, id))).length).toBe(38);
      }
    }
  });

  it("backfill: everyone, no notices, and the watermarks land at the head; a second run inserts nothing", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1) });
    await achievementsTick(db, { now: m(10), everyone: true, announce: false, achievementsChannelId: CH });
    expect((await db.select().from(clanNotices)).length).toBe(0);
    const n1 = (await db.select().from(achievementUnlocks)).length;
    expect(n1).toBeGreaterThan(0);
    const cursors = await db.select().from(consumerCursors).where(sql`${consumerCursors.consumerName} like 'achievements:%'`);
    expect(cursors.length).toBeGreaterThan(5);
    const r = await achievementsTick(db, { now: m(11), everyone: true, announce: false });
    expect(r.unlocked).toBe(0);
    expect((await db.select().from(achievementUnlocks)).length).toBe(n1);
  });

  it("feeds new positions and pins into the counters", async () => {
    const ev = await seedEvent(db, { serverId, type: "player.position", at: m(1), payload: { dayzId: A } });
    await db.insert(playerPositions).values({ serverId, dayzId: A, x: "5050", z: "7020", alt: "100", occurredAt: m(1), eventId: ev.id });
    await db.insert(clanPins).values({ factionId: bear, dayzId: A, x: "1", z: "2", icon: "loot", note: null, createdAt: m(2), expiresAt: m(1000) });
    await achievementsTick(db, { now: m(10) });
    const progress = await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, A));
    expect(progress.find((p) => p.key === "explorer")).toMatchObject({ count: 1, target: 50 });
    expect(progress.find((p) => p.key === "cartographer")).toMatchObject({ count: 1, target: 10 });
  });
});
