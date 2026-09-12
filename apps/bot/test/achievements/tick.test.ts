import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, clanNotices, consumerCursors, factions, playerPositions, clanPins, type Database } from "@factions/db";
import { sql, eq, and } from "drizzle-orm";
import { achievementsTick } from "../../src/achievements/tick.js";
import { RULES } from "../../src/achievements/rules.js";
import { seedServer, seedLink, seedKill, seedFaction, seedMembership, seedEvent, TRUNCATE } from "./seed.js";
import { readResume, readWatermarks } from "../../src/achievements/touched.js";

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

  it("an owner whose TRANSACTION throws costs only that owner; the pass finishes and moves past it", async () => {
    // ⚠️ Spec §6.2. `evaluateOwner` isolates a throwing rule, but the commit can throw too. The
    // failure is forced the way a real one arrives: a bogus `serverId` on the rule result, which
    // `namesFor` takes as its hint and hands to `noticeClanTx` — an FK violation on
    // `clan_notices.server_id` that aborts A's whole transaction from inside.
    await seedLink(db, { dayzId: B, discordId: "222222222222222222", gamertag: "Ben", verifiedAt: t0 });
    const originals = { ...RULES } as Record<string, (typeof RULES)[keyof typeof RULES]>;
    for (const k of Object.keys(RULES)) {
      (RULES as Record<string, unknown>)[k] = async (...args: Parameters<(typeof RULES)[keyof typeof RULES]>) => {
        const r = await originals[k]!(...args);
        return args[1].id === A ? { ...r, serverId: 2_000_000_000 } : r;
      };
    }
    const seen: [string, string][] = [];
    let r: Awaited<ReturnType<typeof achievementsTick>>;
    try {
      r = await achievementsTick(db, { now: m(10), achievementsChannelId: CH, onError: (o, k) => seen.push([o.id, k]) });
    } finally { for (const k of Object.keys(originals)) (RULES as Record<string, unknown>)[k] = originals[k]; }

    // The pass completed and reported the owner-level failure, keyed "*" rather than a rule.
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(seen).toContainEqual([A, "*"]);
    // A's transaction rolled back whole: no unlocks, no progress cache, no notices.
    expect((await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.ownerId, A))).length).toBe(0);
    // B — collected in the same pass, after A in key order — was evaluated and committed anyway.
    const bUnlocks = await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.ownerId, B));
    expect(bUnlocks.map((u) => u.key)).toContain("enlisted");
    expect((await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, B))).length).toBe(38);

    // And the engine is not stuck on A: the drain finished, so the watermarks advanced and the
    // resume marker was cleared. The next pass — rules restored — finds nothing left to do.
    expect(await readResume(db)).toBeNull();
    expect((await readWatermarks(db)).links).toBeGreaterThan(0);
    const again = await achievementsTick(db, { now: m(11), achievementsChannelId: CH });
    expect(again).toMatchObject({ evaluated: 0, failed: 0 });
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

  it("backfill: every owner is evaluated, not just the first batch", async () => {
    // ⚠️ The backfill ends by heading the watermarks, so an owner it skipped is unreachable
    // afterwards — the live tick only looks past those heads. One call must drain them all.
    const ids = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(36));
    for (const [i, id] of ids.entries()) await seedLink(db, { dayzId: id, discordId: `3333333333333333${i}${i}`, gamertag: `P${i}`, verifiedAt: m(1) });
    const r = await achievementsTick(db, { now: m(10), everyone: true, announce: false, batch: 3 });
    expect(r.evaluated).toBeGreaterThanOrEqual(8);   // 7 players + the clan + A
    for (const id of ids) {
      expect((await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, id))).length).toBe(38);
      const unlocks = await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.ownerId, id));
      expect(unlocks.map((u) => u.key)).toContain("enlisted");
    }
  });

  it("backfill: feeds every position and pin into the counters before evaluating", async () => {
    const ev = await seedEvent(db, { serverId, type: "player.position", at: m(1), payload: { dayzId: A } });
    for (let i = 0; i < 50; i++) {
      await db.insert(playerPositions).values({ serverId, dayzId: A, x: String(i * 1000 + 1), z: "500", alt: "100", occurredAt: m(i), eventId: i === 0 ? ev.id : (await seedEvent(db, { serverId, type: "player.position", at: m(i), payload: { dayzId: A } })).id });
    }
    for (let i = 0; i < 10; i++) {
      await db.insert(clanPins).values({ factionId: bear, dayzId: A, x: "1", z: "2", icon: "loot", note: null, createdAt: m(100 + i), expiresAt: m(1000) });
    }
    // No prior live pass: the backfill is the only thing that has ever seen these rows.
    await achievementsTick(db, { now: m(200), everyone: true, announce: false, batch: 3 });
    const unlocks = await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.ownerId, A));
    expect(unlocks.find((u) => u.key === "explorer")).toMatchObject({ earnedAt: m(49) });
    expect(unlocks.find((u) => u.key === "cartographer")).toMatchObject({ earnedAt: m(109) });
  });

  it("backfill: a pin dropped WHILE it runs is not headed over", async () => {
    // ⚠️ A backfill takes minutes and the web app keeps writing through it. The heads must
    // be taken before the first row is counted, or a pin dropped mid-backfill is skipped by
    // the counter pass AND headed over — the live tick never looks at it again.
    const before = await db.insert(clanPins).values(
      Array.from({ length: 3 }, (_, i) => ({ factionId: bear, dayzId: A, x: "1", z: "2", icon: "loot" as const, note: null, createdAt: m(i), expiresAt: m(1000) })),
    ).returning({ id: clanPins.id });
    const maxBefore = Math.max(...before.map((p) => p.id));

    // A rule that drops one more pin the first time it runs — i.e. DURING the owner drain.
    const original = RULES.enlisted;
    let dropped = false;
    (RULES as Record<string, unknown>).enlisted = async (...args: Parameters<typeof original>) => {
      if (!dropped) {
        dropped = true;
        await db.insert(clanPins).values({ factionId: bear, dayzId: A, x: "1", z: "2", icon: "loot", note: null, createdAt: m(50), expiresAt: m(1000) });
      }
      return original(...args);
    };
    try {
      await achievementsTick(db, { now: m(100), everyone: true, announce: false, batch: 2 });
    } finally { (RULES as Record<string, unknown>).enlisted = original; }
    expect(dropped).toBe(true);

    // The stored watermark is the head as it was BEFORE the backfill, not "now".
    expect((await readWatermarks(db)).pins).toBe(maxBefore);
    const afterBackfill = await db.select().from(achievementProgress).where(and(eq(achievementProgress.ownerId, A), eq(achievementProgress.key, "cartographer")));
    expect(afterBackfill[0]).toMatchObject({ count: 3 });

    // So the next live pass still sees the mid-backfill pin and counts it.
    await achievementsTick(db, { now: m(110) });
    const live = await db.select().from(achievementProgress).where(and(eq(achievementProgress.ownerId, A), eq(achievementProgress.key, "cartographer")));
    expect(live[0]).toMatchObject({ count: 4 });
  });

  it("a drain skips nobody when new owners arrive mid-drain and sort before the marker", async () => {
    for (let i = 0; i < 3; i++) await seedKill(db, { serverId, killer: `${i}`.padStart(36, "K"), victim: `${i}`.padStart(36, "V"), at: m(i) });
    const first = await achievementsTick(db, { now: m(10), batch: 2 });
    expect(first.carried).toBeGreaterThan(0);
    expect(await readResume(db)).not.toBeNull();
    // Two owners whose keys sort BEFORE everything already processed.
    const early = ["0".repeat(36), "1".repeat(36)];
    await seedKill(db, { serverId, killer: early[0]!, victim: early[1]!, at: m(5) });
    for (let pass = 0; pass < 12; pass++) {
      const r = await achievementsTick(db, { now: m(20 + pass), batch: 2 });
      if (r.evaluated === 0) break;
    }
    for (const id of early) {
      expect((await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, id))).length).toBe(38);
    }
    expect(await readResume(db)).toBeNull();   // the drain finished and cleaned up after itself
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
