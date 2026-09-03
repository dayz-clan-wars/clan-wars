import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, events, admFiles, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRebindStore } from "../src/rebind-store.js";
import { PgDormancyStore } from "../src/dormancy-store.js";
import { decide, DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS } from "../src/dormancy.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID = "A".repeat(40);
const W = {
  dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
  disbandAfterDormantMs: DEFAULT_DISBAND_AFTER_DORMANT_MS,
};

describe("rebind and the dormancy clock", () => {
  let db: Database;
  let rebindStore: PgRebindStore;
  let dormancyStore: PgDormancyStore;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table events, raw_lines, adm_files, faction_members, factions, servers restart identity cascade`);
    });
    rebindStore = new PgRebindStore(db);
    dormancyStore = new PgDormancyStore(db);

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: ago(999_999_999),
    }).returning();
    admFileId = f!.id;

    // ⚠️ activated_at is deliberately ANCIENT. That is what made the old
    // Flag_White design fail: with no raise findable at the new pole, the
    // clock's coalesce fell through to this value and read as infinitely stale.
    const [faction] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      poleKey: "1.00:1.00:1.00", x: "1", y: "1", z: "1", status: "active",
      leaderDiscordId: "leader", createdAt: ago(999_999_999), activatedAt: ago(999_999_999),
    }).returning();
    factionId = faction!.id;

    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID, discordId: "leader", role: "leader", joinedAt: ago(999_999_999),
    });
  });

  /** A raise of the faction's own texture at `poleKey`, plus a server heartbeat. */
  const raise = (poleKey: string, occurredAt: Date, lineIndex: number) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex, subIndex: 0,
      type: "flag.raised", occurredAt,
      payload: { poleKey, texture: "Flag_Bear", dayzId: UID, gamertag: "Leader", pole: { x: 9, y: 8, z: 7 } },
    });

  const clockFor = async (id: number) =>
    (await dormancyStore.clocks()).find((c) => c.id === id)!;

  it("⚠️ a faction that just rebound is NOT dormant on the next tick", async () => {
    // The whole point. LAST_RAISE keys on (server, poleKey, texture) — after
    // the move the pole is the new one, and the raise that qualified the
    // rebind was this faction's own texture AT that pole, so the clock finds
    // it with no compensating write.
    await raise("9.00:8.00:7.00", ago(60_000), 1);
    const target = (await rebindStore.factionFor(factionId))!;
    expect(await rebindStore.rebind({
      factionId, leaderDiscordId: "leader",
      expectedPoleKey: target.poleKey,
      poleKey: "9.00:8.00:7.00", x: 9, y: 8, z: 7,
      at: now, notBefore: ago(604_800_000),
    })).toBe(true);

    const clock = await clockFor(factionId);
    expect(clock.status).toBe("active");
    expect(clock.dormantSince).toBeNull();
    expect(decide(clock, now, W)).toBeNull();
  });

  it("still goes dormant 7 days after the rebind if the flag never flies again", async () => {
    // Reviving must restart the clock, not disable it.
    await raise("9.00:8.00:7.00", ago(60_000), 1);
    const target = (await rebindStore.factionFor(factionId))!;
    await rebindStore.rebind({
      factionId, leaderDiscordId: "leader",
      expectedPoleKey: target.poleKey,
      poleKey: "9.00:8.00:7.00", x: 9, y: 8, z: 7,
      at: now, notBefore: ago(604_800_000),
    });

    const clock = await clockFor(factionId);
    const later = new Date(now.getTime() + DEFAULT_DORMANT_AFTER_MS + 60_000);
    // The server is still ingesting at `later`, so this is ordinary dormancy
    // rather than the paused-clock path.
    expect(decide({ ...clock, serverLastEventAt: later }, later, W)).toBe("dormant");
  });

  it("a rebind out of dormancy clears dormant_since and revives", async () => {
    await db.update(factions).set({ status: "dormant", dormantSince: ago(86_400_000) })
      .where(eq(factions.id, factionId));
    await raise("9.00:8.00:7.00", ago(60_000), 1);

    const target = (await rebindStore.factionFor(factionId))!;
    await rebindStore.rebind({
      factionId, leaderDiscordId: "leader",
      expectedPoleKey: target.poleKey,
      poleKey: "9.00:8.00:7.00", x: 9, y: 8, z: 7,
      at: now, notBefore: ago(604_800_000),
    });

    const clock = await clockFor(factionId);
    expect(clock.status).toBe("active");
    expect(clock.dormantSince).toBeNull();
    expect(decide(clock, now, W)).toBeNull();
  });
});
