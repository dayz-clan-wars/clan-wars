import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, events, admFiles, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRebindStore } from "../src/rebind-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID_MEMBER = "A".repeat(40);
const UID_STRANGER = "B".repeat(40);

describe("PgRebindStore", () => {
  let db: Database;
  let store: PgRebindStore;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table events, raw_lines, adm_files, faction_members, factions, servers restart identity cascade`);
    });
    store = new PgRebindStore(db);
    lineIndex = 0;

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: ago(999_999),
    }).returning();
    admFileId = f!.id;

    const [faction] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      poleKey: "1.00:1.00:1.00", x: "1", y: "1", z: "1", status: "active",
      leaderDiscordId: "leader", createdAt: ago(999_999), activatedAt: ago(999_999),
    }).returning();
    factionId = faction!.id;

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID_MEMBER, discordId: "leader", role: "leader", joinedAt: ago(999_999) },
    ]);
  });

  const raiseAt = (o: {
    poleKey: string; texture?: string; dayzId?: string; occurredAt?: Date; serverIdOverride?: number;
  }) => db.insert(events).values({
    serverId: o.serverIdOverride ?? serverId,
    admFileId,
    lineIndex: lineIndex++,
    subIndex: 0,
    type: "flag.raised",
    occurredAt: o.occurredAt ?? ago(1000),
    payload: {
      poleKey: o.poleKey,
      texture: o.texture ?? "Flag_Bear",
      dayzId: o.dayzId ?? UID_MEMBER,
      gamertag: "Raiser",
      pole: { x: 9, y: 8, z: 7 },
    },
  });

  const target = async () => (await store.factionFor(factionId))!;

  it("reads the faction's rebind-relevant fields", async () => {
    const t = await target();
    expect(t.texture).toBe("Flag_Bear");
    expect(t.poleKey).toBe("1.00:1.00:1.00");
    expect(t.status).toBe("active");
    expect(t.reboundAt).toBeNull();
  });

  it("finds a member's raise of the faction's own texture at another pole", async () => {
    await raiseAt({ poleKey: "9.00:8.00:7.00" });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    expect(out).toHaveLength(1);
    expect(out[0]!.poleKey).toBe("9.00:8.00:7.00");
    expect(out[0]!.x).toBe(9);
  });

  it("⚠️ ignores a raise by someone who is not on the roster", async () => {
    // A rebind moves the faction's identity to coordinates of someone's
    // choosing. If a stranger's raise could supply that target, anyone could
    // relocate any faction to a pole they control.
    await raiseAt({ poleKey: "9.00:8.00:7.00", dayzId: UID_STRANGER });
    expect(await store.qualifyingRaises(await target(), ago(3_600_000))).toEqual([]);
  });

  it("ignores a raise of a different texture", async () => {
    await raiseAt({ poleKey: "9.00:8.00:7.00", texture: "Flag_Wolf" });
    expect(await store.qualifyingRaises(await target(), ago(3_600_000))).toEqual([]);
  });

  it("ignores a raise at a pole another holding faction owns", async () => {
    await db.insert(factions).values({
      serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf",
      poleKey: "9.00:8.00:7.00", x: "9", y: "8", z: "7", status: "active",
      leaderDiscordId: "other", createdAt: ago(999_999),
    });
    await raiseAt({ poleKey: "9.00:8.00:7.00" });
    expect(await store.qualifyingRaises(await target(), ago(3_600_000))).toEqual([]);
  });

  it("ignores a raise older than the window", async () => {
    await raiseAt({ poleKey: "9.00:8.00:7.00", occurredAt: ago(7_200_000) });
    expect(await store.qualifyingRaises(await target(), ago(3_600_000))).toEqual([]);
  });

  const args = (over: Partial<Parameters<PgRebindStore["rebind"]>[0]> = {}) => ({
    factionId, leaderDiscordId: "leader",
    expectedPoleKey: "1.00:1.00:1.00",
    poleKey: "9.00:8.00:7.00", x: 9, y: 8, z: 7,
    at: now, notBefore: ago(604_800_000),
    ...over,
  });

  it("moves the pole, activates, and clears dormancy in one write", async () => {
    await db.update(factions).set({ status: "dormant", dormantSince: ago(5000) })
      .where(eq(factions.id, factionId));

    expect(await store.rebind(args())).toBe(true);

    const [row] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(row!.poleKey).toBe("9.00:8.00:7.00");
    expect(Number(row!.x)).toBe(9);
    expect(row!.status).toBe("active");
    expect(row!.dormantSince).toBeNull();
    expect(row!.reboundAt).toEqual(now);
  });

  it("refuses a non-leader", async () => {
    expect(await store.rebind(args({ leaderDiscordId: "someone-else" }))).toBe(false);
  });

  it("refuses inside the cooldown", async () => {
    await db.update(factions).set({ reboundAt: ago(1000) }).where(eq(factions.id, factionId));
    expect(await store.rebind(args())).toBe(false);
  });

  it("⚠️ refuses when the pole moved since the candidate was read", async () => {
    // Two leaders confirming two different candidates concurrently must produce
    // one move and one refusal, not two writes. expectedPoleKey is the guard.
    expect(await store.rebind(args({ expectedPoleKey: "stale" }))).toBe(false);
  });

  it("refuses a reserved faction", async () => {
    await db.update(factions).set({ status: "reserved", reservedUntil: now })
      .where(eq(factions.id, factionId));
    expect(await store.rebind(args())).toBe(false);
  });

  it("refuses a disbanded faction", async () => {
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, factionId));
    expect(await store.rebind(args())).toBe(false);
  });
});
