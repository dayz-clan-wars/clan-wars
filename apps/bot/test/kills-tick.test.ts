import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, membershipHistory, factions, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { seedFaction } from "./seed.js";
import { killsTick, rebuildKills } from "../src/kills-tick.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-07T12:00:00Z");
const t1 = new Date(t0.getTime() + 60_000);
const t5 = new Date(t0.getTime() + 5 * 60_000);
const t6 = new Date(t0.getTime() + 6 * 60_000);

const A = "A".repeat(40);
const B = "B".repeat(40);
const R = "R".repeat(40);
const S = "S".repeat(40); // stranger, no membership history

describe("killsTick", () => {
  let db: Database; let serverId = 0; let file1 = 0; let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table kills, membership_history, declarations, poles, factions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a1] = await db.insert(admFiles).values({ serverId, filename: "f1.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    file1 = a1!.id;
    line = 0;

    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "tex1", createdAt: t0, poleKey: "1.00:2.00:3.00" });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "tex2", createdAt: t0, poleKey: "4.00:5.00:6.00" });

    await db.insert(membershipHistory).values({ serverId, factionId: bear.id, dayzId: A, joinedAt: t0, leftAt: null });
    await db.insert(membershipHistory).values({ serverId, factionId: bear.id, dayzId: B, joinedAt: t0, leftAt: t5 });
    await db.insert(membershipHistory).values({ serverId, factionId: wolf.id, dayzId: R, joinedAt: t0, leftAt: null });
  });

  const ev = (type: string, payload: unknown, at: Date) =>
    db.insert(events).values({ serverId, admFileId: file1, lineIndex: line++, type: type as never, occurredAt: at, payload }).returning({ id: events.id });

  it("1. A kills R (different clans): killerFactionId BEAR, victimFactionId WOLF, friendlyFire false", async () => {
    await ev("player.killed", { victimDayzId: R, victimGamertag: "R", killerDayzId: A, killerGamertag: "A", weapon: "AKM", distanceM: 123.4 }, t1);
    const result = await killsTick(db);
    expect(result.scanned).toBe(1);
    expect(result.written).toBe(1);
    const rows = await db.select().from(kills);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const [bear] = await db.select().from(factions).where(sql`tag = 'BEAR'`);
    const [wolf] = await db.select().from(factions).where(sql`tag = 'WOLF'`);
    expect(row.killerDayzId).toBe(A);
    expect(row.victimDayzId).toBe(R);
    expect(row.killerFactionId).toBe(bear!.id);
    expect(row.victimFactionId).toBe(wolf!.id);
    expect(row.friendlyFire).toBe(false);
    expect(row.weapon).toBe("AKM");
    expect(row.distanceM).toBe("123.4");
    expect(row.cause).toBe("pvp");
  });

  it("2. A kills B: friendly fire true while both in BEAR, false with victimFactionId null after B has left", async () => {
    await ev("player.killed", { victimDayzId: B, victimGamertag: "B", killerDayzId: A, killerGamertag: "A", weapon: "M4", distanceM: 10 }, t1);
    await ev("player.killed", { victimDayzId: B, victimGamertag: "B", killerDayzId: A, killerGamertag: "A", weapon: "M4", distanceM: 20 }, t6);
    await killsTick(db);
    const rows = await db.select().from(kills).orderBy(kills.occurredAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.friendlyFire).toBe(true);
    expect(rows[0]!.victimFactionId).not.toBeNull();
    expect(rows[1]!.friendlyFire).toBe(false);
    expect(rows[1]!.victimFactionId).toBeNull();
  });

  it("2b. a self-kill (killerDayzId === victimDayzId) is never friendly fire, even for a clan member", async () => {
    await ev("player.killed", { victimDayzId: A, victimGamertag: "A", killerDayzId: A, killerGamertag: "A", weapon: "M67", distanceM: 0 }, t1);
    await killsTick(db);
    const rows = await db.select().from(kills);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.killerDayzId).toBe(A);
    expect(rows[0]!.victimDayzId).toBe(A);
    expect(rows[0]!.friendlyFire).toBe(false);
    expect(rows[0]!.killerFactionId).not.toBeNull();
    expect(rows[0]!.victimFactionId).not.toBeNull();
    expect(rows[0]!.killerFactionId).toBe(rows[0]!.victimFactionId);
  });

  it("3. player.died (infected) for A: killerDayzId null, cause 'infected', killerFactionId null, friendlyFire false", async () => {
    await ev("player.died", { victimDayzId: A, victimGamertag: "A", cause: "infected", entity: "ZmbM_Base" }, t1);
    const result = await killsTick(db);
    expect(result.scanned).toBe(1);
    expect(result.written).toBe(1);
    const rows = await db.select().from(kills);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.killerDayzId).toBeNull();
    expect(row.cause).toBe("infected");
    expect(row.killerFactionId).toBeNull();
    expect(row.friendlyFire).toBe(false);
    expect(row.victimDayzId).toBe(A);
  });

  it("3b. a bare `died` is attributed from the hits and knockouts in the two minutes before it", async () => {
    const t = (s: number) => new Date(t1.getTime() + s * 1000);
    // A, mauled: an infected hit, then a knockout, then a bare death with the bleed still open.
    await ev("player.hit", { victimDayzId: A, victimGamertag: "A", victimHp: 80, attackerType: "infected", attackerDayzId: null, attackerGamertag: null, attackerLabel: "Infected", damage: 7.65, bodyPart: "Torso" }, t(0));
    await ev("player.unconscious", { dayzId: A, gamertag: "A", disconnecting: false }, t(20));
    await ev("player.died", { victimDayzId: A, victimGamertag: "A", cause: "died", entity: null, water: 500, energy: 500, bleedSources: 1 }, t(40));
    // R, starved: no hits, energy 0.
    await ev("player.died", { victimDayzId: R, victimGamertag: "R", cause: "died", entity: null, water: 500, energy: 0, bleedSources: 0 }, t(60));
    // S, a fall: a FallDamage hit to 0 HP, then a bare death.
    await ev("player.hit", { victimDayzId: S, victimGamertag: "S", victimHp: 0, attackerType: "environment", attackerDayzId: null, attackerGamertag: null, attackerLabel: "FallDamageHealth", damage: null, bodyPart: null }, t(70));
    await ev("player.died", { victimDayzId: S, victimGamertag: "S", cause: "died", entity: null, water: 500, energy: 500, bleedSources: 0 }, t(71));
    // B, unexplained: A's infected hit is another player's evidence, and B's own hit is outside the window.
    await ev("player.hit", { victimDayzId: B, victimGamertag: "B", victimHp: 50, attackerType: "infected", attackerDayzId: null, attackerGamertag: null, attackerLabel: "Infected", damage: 7.65, bodyPart: "Torso" }, t(100));
    await ev("player.died", { victimDayzId: B, victimGamertag: "B", cause: "died", entity: null, water: 500, energy: 500, bleedSources: 1 }, t(100 + 121));
    const result = await killsTick(db);
    expect(result.scanned).toBe(4);
    const rows = await db.select({ victim: kills.victimDayzId, cause: kills.cause }).from(kills).orderBy(kills.occurredAt);
    expect(rows).toEqual([{ victim: A, cause: "mauled" }, { victim: R, cause: "starvation" }, { victim: S, cause: "fall" }, { victim: B, cause: "died" }]);
  });

  it("4. a stranger with no membership history on both sides: both faction ids null", async () => {
    await ev("player.killed", { victimDayzId: S, victimGamertag: "S", killerDayzId: "X".repeat(40), killerGamertag: "X", weapon: null, distanceM: null }, t1);
    await killsTick(db);
    const rows = await db.select().from(kills);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.killerFactionId).toBeNull();
    expect(rows[0]!.victimFactionId).toBeNull();
    expect(rows[0]!.friendlyFire).toBe(false);
    expect(rows[0]!.distanceM).toBeNull();
  });

  it("5. replay writes nothing twice; rebuildKills reproduces the rows", async () => {
    await ev("player.killed", { victimDayzId: R, victimGamertag: "R", killerDayzId: A, killerGamertag: "A", weapon: "AKM", distanceM: 123.4 }, t1);
    await ev("player.killed", { victimDayzId: B, victimGamertag: "B", killerDayzId: A, killerGamertag: "A", weapon: "M4", distanceM: 20 }, t6);
    await ev("player.died", { victimDayzId: A, victimGamertag: "A", cause: "infected", entity: "ZmbM_Base" }, t1);
    await killsTick(db);
    const before = await db.select().from(kills);
    expect(before).toHaveLength(3);

    // replay: reset cursor to 0 and tick again — must write nothing new.
    await db.execute(sql`update consumer_cursors set last_event_id = 0`);
    const result = await killsTick(db);
    expect(result.written).toBe(0);
    const afterReplay = await db.select().from(kills);
    expect(afterReplay).toEqual(before);

    const strip = (rows: (typeof kills.$inferSelect)[]) =>
      rows.map(({ id, ...rest }) => rest).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const beforeStripped = strip(before);
    const written = await rebuildKills(db, serverId);
    expect(written).toBe(before.length);
    const after = await db.select().from(kills);
    expect(strip(after)).toEqual(beforeStripped);
  });
});
