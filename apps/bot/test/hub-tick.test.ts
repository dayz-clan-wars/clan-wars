import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, bans, consumerCursors, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { hubTick, HUB_CONSUMER } from "../src/hub-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40), B = "B".repeat(40), C = "C".repeat(40);
const HUB = { x: 100, y: 998.6, z: 93 };
const GROUND = { x: 100, y: 310, z: 93 };
const now = new Date("2026-09-22T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe("hubTick", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate events, raw_lines, adm_files, bans, consumer_cursors, servers restart identity cascade`);
    serverId = (await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning())[0]!.id;
    fileId = (await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: ago(86_400 * 2), linesIngested: 0, complete: true }).returning())[0]!.id;
    line = 0;
    await writeCursor(db, HUB_CONSUMER, 0);   // seeded: every test below starts from the beginning
  });
  const ev = (type: string, at: Date, payload: Record<string, unknown>) =>
    db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: type as never, occurredAt: at, payload }).returning({ id: events.id });
  const hit = (attacker: string, victim: string, at: Date, pos = HUB) =>
    ev("player.hit", at, { attackerType: "player", attackerDayzId: attacker, attackerGamertag: attacker.slice(0, 3), victimDayzId: victim, victimPos: pos, attackerPos: pos });
  const banned = async () => (await db.select().from(bans).orderBy(bans.id)).map((b) => b.dayzId);

  it("the first hitter is banned for an hour from NOW, not from when it happened", async () => {
    await hit(A, B, ago(3 * 3600));   // logged three hours late
    const r = await hubTick(db, { now });
    expect(r.banned.map((b) => b.dayzId)).toEqual([A]);
    const [b] = await db.select().from(bans);
    expect(b).toMatchObject({ reason: "hub_combat", status: "pending", serverId, gamertag: "AAA" });
    expect(b!.bannedAt.toISOString()).toBe(now.toISOString());
    expect(b!.expiresAt!.toISOString()).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(b!.incidentId).toBeNull();
  });

  it("return fire within two minutes is self-defence; after two minutes it is not", async () => {
    await hit(B, A, ago(300));
    await hit(A, B, ago(200));   // 100 s later: self-defence
    await hit(A, B, ago(60));    // 240 s after B's hit: an offence
    await hubTick(db, { now });
    expect(await banned()).toEqual([B, A]);
  });

  it("self-defence is per pair: hitting a third player is still an offence", async () => {
    await hit(B, A, ago(100));
    await hit(A, C, ago(90));
    await hubTick(db, { now });
    expect((await banned()).sort()).toEqual([A, B].sort());
  });

  it("the attack that started it need not be at the Hub", async () => {
    await hit(B, A, ago(100), GROUND);
    await hit(A, B, ago(90));
    await hubTick(db, { now });
    expect(await banned()).toEqual([]);
  });

  it("⚠️ a same-second exchange bans exactly the one logged first", async () => {
    const t = ago(100);
    await hit(A, B, t);
    await hit(B, A, t);
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
  });

  it("a kill at the Hub bans the killer; a fight on the ground below bans nobody", async () => {
    await ev("player.killed", ago(50), { killerDayzId: A, killerGamertag: "AAA", victimDayzId: B, victimPos: HUB, killerPos: HUB });
    await hit(C, B, ago(40), GROUND);
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
  });

  it("a trap placed at the Hub bans the placer; a tent does not", async () => {
    await ev("item.placed", ago(50), { dayzId: A, gamertag: "AAA", itemClass: "BearTrap", item: "Bear Trap", pos: HUB });
    await ev("item.placed", ago(40), { dayzId: B, gamertag: "BBB", itemClass: "LargeTent", item: "Large Tent", pos: HUB });
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
  });

  it("one ban at a time: a brawl is one ban, and a new offence after it ends is a new one", async () => {
    for (let i = 0; i < 20; i++) await hit(A, B, ago(100 - i));
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
    await db.update(bans).set({ status: "expired" });
    await hit(A, B, ago(10));
    await hubTick(db, { now });
    expect(await banned()).toEqual([A, A]);
  });

  it("an event older than 24 h is skipped, and the cursor still moves past it", async () => {
    const [e] = await hit(A, B, ago(25 * 3600));
    await hubTick(db, { now });
    expect(await banned()).toEqual([]);
    const [c] = await db.select().from(consumerCursors).where(sql`consumer_name = ${HUB_CONSUMER}`);
    expect(c!.lastEventId).toBe(e!.id);
  });

  it("⚠️ with no cursor row it seeds at the log head and bans nobody — history is never replayed", async () => {
    await db.execute(sql`truncate consumer_cursors`);
    await hit(A, B, ago(100));
    const r = await hubTick(db, { now });
    expect(r.seeded).toBe(true);
    expect(await banned()).toEqual([]);
    await hit(C, B, ago(10));
    await hubTick(db, { now });
    expect(await banned()).toEqual([C]);
  });

  it("an infected's hit at the Hub is never an offence", async () => {
    await ev("player.hit", ago(10), { attackerType: "infected", attackerDayzId: null, victimDayzId: B, victimPos: HUB, attackerPos: null });
    await hubTick(db, { now });
    expect(await banned()).toEqual([]);
  });
});
