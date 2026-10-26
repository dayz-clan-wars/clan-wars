import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, membershipHistory, servers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { makeCtx } from "../../src/achievements/types.js";
import { collectTouched, headWatermarks, readWatermarks, ownerKey } from "../../src/achievements/touched.js";
import { seedServer, seedFaction, seedMembership, seedKill, seedEvent, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-08-01T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);

describe("collectTouched", () => {
  let db: Database; let serverId = 0; let bear = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 })).id;
  });

  it("the membership watermark never moves backwards when an old span is closed", async () => {
    const spans = [];
    for (let i = 0; i < 3; i++) spans.push(await seedMembership(db, { serverId, factionId: bear, dayzId: `${i}`.repeat(36), joinedAt: m(i), leftAt: null }));
    const first = await collectTouched(db, await readWatermarks(db), 100);
    expect(first.next.membership).toBe(spans[2]!.id);

    // Only the OLDEST span closes. Its id is below the watermark, so a naive "last row
    // read" would drag the watermark back to it and re-collect the whole server next pass.
    await db.update(membershipHistory).set({ leftAt: m(50) }).where(eq(membershipHistory.id, spans[0]!.id));
    const second = await collectTouched(db, first.next, 100);
    expect(second.next.membership).toBe(first.next.membership);
    expect(second.next.membershipClosed).toBe(m(50).getTime());
    // Only the closed span's owners are touched.
    expect(second.owners.map(ownerKey).sort()).toEqual([`clan:${bear}`, `player:${"0".repeat(36)}`].sort());

    // And a third pass, with nothing new, touches nobody.
    const third = await collectTouched(db, second.next, 100);
    expect(third.owners).toEqual([]);
  });

  it("headWatermarks reports the same heads collectTouched would reach, without reading rows", async () => {
    const k = await seedKill(db, { serverId, killer: "K".repeat(36), victim: "V".repeat(36), at: m(1) });
    const span = await seedMembership(db, { serverId, factionId: bear, dayzId: "A".repeat(36), joinedAt: m(0), leftAt: m(9) });
    const heads = await headWatermarks(db);
    const collected = await collectTouched(db, await readWatermarks(db), 1000);
    expect(heads.kills).toBe(k.id);
    expect(heads.membership).toBe(span.id);
    expect(heads.membershipClosed).toBe(m(9).getTime());
    expect(heads.activations).toBe(t0.getTime());
    expect(heads).toEqual(collected.next);
  });

  describe("event sources", () => {
    const A = "A".repeat(36), B = "B".repeat(36), C = "C".repeat(36);
    const players = async () => (await collectTouched(db, await readWatermarks(db), 100)).owners.map(ownerKey).filter((k) => k.startsWith("player:")).sort();

    it("a hit touches its victim and its player attacker", async () => {
      await seedEvent(db, { serverId, type: "player.hit", at: m(1), payload: { victimDayzId: A, attackerDayzId: B, attackerType: "player" } });
      await seedEvent(db, { serverId, type: "player.hit", at: m(2), payload: { victimDayzId: C, attackerDayzId: null, attackerLabel: "Doberman" } });
      expect(await players()).toEqual([`player:${A}`, `player:${B}`, `player:${C}`]);
    });
    it.each(["item.placed", "item.packed", "player.conscious"])("%s touches its player", async (type) => {
      await seedEvent(db, { serverId, type, at: m(1), payload: { dayzId: A } });
      expect(await players()).toEqual([`player:${A}`]);
    });
    it("headWatermarks counts the new types so a backfill does not replay them", async () => {
      const e = await seedEvent(db, { serverId, type: "player.hit", at: m(1), payload: { victimDayzId: A } });
      expect((await headWatermarks(db)).events).toBe(e.id);
    });
  });

  describe("the clan tiles' sources (Task B8)", () => {
    const A = "A".repeat(36), B = "B".repeat(36);
    const clans = (owners: { kind: string; id: string }[]) => owners.filter((o) => o.kind === "clan").map((o) => o.id);
    let wolf = 0;
    beforeEach(async () => {
      wolf = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: t0, activatedAt: t0 })).id;
    });
    // The membership and activation sources would touch the clans on their own; start past them.
    const settled = async () => (await collectTouched(db, await readWatermarks(db), 100)).next;

    it("a kill touches the killer's clan as resolved at the kill (Warband, Armory)", async () => {
      const wm = await settled();
      await seedKill(db, { serverId, killer: A, victim: B, at: m(1), killerFactionId: bear });
      await seedKill(db, { serverId, killer: B, victim: A, at: m(2), killerFactionId: null });
      expect(clans((await collectTouched(db, wm, 100)).owners)).toEqual([String(bear)]);
    });

    it("a base.built touches the clan whose full-member span covers the builder at that moment (Renovators)", async () => {
      await seedMembership(db, { serverId, factionId: bear, dayzId: A, joinedAt: m(0), leftAt: null });
      await seedMembership(db, { serverId, factionId: wolf, dayzId: B, joinedAt: m(0), leftAt: m(5) });
      const wm = await settled();
      await seedEvent(db, { serverId, type: "base.built", at: m(10), payload: { dayzId: A, structure: null, part: "door" } });
      await seedEvent(db, { serverId, type: "base.built", at: m(10), payload: { dayzId: B, structure: null, part: "door" } });   // B left WOLF at m(5)
      expect(clans((await collectTouched(db, wm, 100)).owners)).toEqual([String(bear)]);
    });

    it("collectTouched: a well_brick also touches everyone who cleared rubble within 5 m on that server", async () => {
      const D = "D".repeat(36), E = "E".repeat(36);
      const other = (await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning())[0]!.id;
      const built = (dayzId: string, part: string, x: number, sid = serverId, at = m(1)) =>
        seedEvent(db, { serverId: sid, type: "base.built", at, payload: { dayzId, structure: null, part, pos: { x, y: 0, z: 1000 } } });
      await built(A, "rubble_a", 1000);
      await built(D, "rubble_a", 1050);          // 50 m away
      await built(E, "rubble_a", 1000, other);   // same spot, another server
      const wm = await settled();                // their own events are consumed: only the brick can touch them now
      await built(B, "well_brick", 1001, serverId, m(2));
      const owners = (await collectTouched(db, wm, 100)).owners.map(ownerKey).filter((k) => k.startsWith("player:"));
      expect(owners).toEqual([`player:${A}`, `player:${B}`].sort());
    });

    it("a class_* unlock touches the clan the player was in when it was earned, once (Every Class Covered)", async () => {
      await seedMembership(db, { serverId, factionId: bear, dayzId: A, joinedAt: m(0), leftAt: null });
      await seedMembership(db, { serverId, factionId: wolf, dayzId: B, joinedAt: m(20), leftAt: null });
      const wm = await settled();
      // noticed_at defaults to now(), with microseconds: the second pass below proves the
      // millisecond watermark does not re-collect the same row forever.
      await db.insert(achievementUnlocks).values([
        { ownerKind: "player", ownerId: A, key: "class_snipers", earnedAt: m(3) },
        { ownerKind: "player", ownerId: B, key: "class_snipers", earnedAt: m(3) },   // before B joined WOLF
        { ownerKind: "player", ownerId: B, key: "full_armory", earnedAt: m(30) },    // not a class tile
      ]);
      const first = await collectTouched(db, wm, 100);
      expect(clans(first.owners)).toEqual([String(bear)]);
      expect(first.next.classUnlocks).toBeGreaterThan(0);
      expect(clans((await collectTouched(db, first.next, 100)).owners)).toEqual([]);
      expect(await headWatermarks(db)).toEqual(first.next);
    });
  });

  it("memo: two rules asking for the same key share one read", async () => {
    let reads = 0; const ctx = makeCtx(t0);
    const [a, b] = await Promise.all([ctx.memo("k", async () => ++reads), ctx.memo("k", async () => ++reads)]);
    expect(reads).toBe(1);
    expect([a, b]).toEqual([1, 1]);
    expect(await makeCtx(t0).memo("k", async () => 7)).toBe(7);
  });
});
