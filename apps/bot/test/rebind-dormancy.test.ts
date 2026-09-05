import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, events, admFiles, declarations, poles, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRebindStore } from "@factions/roster/internal";
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

// Both far from the Hub (100, 93) and far from each other — declareTx now
// enforces 200 m, so these can no longer sit near (1,1,1)/(9,8,7).
const P1 = { x: 10000, y: 100, z: 10000 };
const P2 = { x: 20000, y: 100, z: 20000 };
const P1_KEY = "10000.00:100.00:10000.00";
const P2_KEY = "20000.00:100.00:20000.00";

describe("rebind and the dormancy clock", () => {
  let db: Database;
  let rebindStore: PgRebindStore;
  let dormancyStore: PgDormancyStore;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table events, raw_lines, adm_files, declarations, poles, faction_members, factions, servers restart identity cascade`);
    });
    rebindStore = new PgRebindStore(db);
    dormancyStore = new PgDormancyStore(db);
    lineIndex = 0;

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
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active",
      leaderDiscordId: "leader", createdAt: ago(999_999_999), activatedAt: ago(999_999_999),
    }).returning();
    factionId = faction!.id;

    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID, discordId: "leader", role: "leader", joinedAt: ago(999_999_999),
    });

    // The founding evidence for the faction's P1 declaration.
    const [founding] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, subIndex: 0,
      type: "flag.raised", occurredAt: ago(999_999_999),
      payload: { poleKey: P1_KEY, texture: "Flag_Bear", dayzId: UID, gamertag: "Founder", pole: P1 },
    }).returning();

    await db.insert(declarations).values({
      serverId, poleKey: P1_KEY, x: P1.x.toFixed(2), y: P1.y.toFixed(2), z: P1.z.toFixed(2),
      ownerFactionId: factionId, evidenceEventId: founding!.id, declaredAt: ago(999_999_999),
    });

    await db.insert(poles).values([
      {
        serverId, map: "livonia", poleKey: P1_KEY,
        x: P1.x.toFixed(2), y: P1.y.toFixed(2), z: P1.z.toFixed(2),
        currentTexture: "Flag_Bear", flagRaised: true,
        firstSeenAt: ago(999_999_999), lastSeenAt: ago(999_999_999), graceUntil: now,
      },
      {
        serverId, map: "livonia", poleKey: P2_KEY,
        x: P2.x.toFixed(2), y: P2.y.toFixed(2), z: P2.z.toFixed(2),
        currentTexture: null, flagRaised: false,
        firstSeenAt: ago(999_999_999), lastSeenAt: ago(999_999_999), graceUntil: now,
      },
    ]);
  });

  /** A raise of the faction's own texture at `poleKey`, plus a server heartbeat. */
  const raise = (poleKey: string, occurredAt: Date, idx: number) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: idx, subIndex: 0,
      type: "flag.raised", occurredAt,
      payload: { poleKey, texture: "Flag_Bear", dayzId: UID, gamertag: "Leader", pole: P2 },
    }).returning();

  const clockFor = async (id: number) =>
    (await dormancyStore.clocks()).find((c) => c.id === id)!;

  it("⚠️ a faction that just rebound is NOT dormant on the next tick", async () => {
    // The whole point. LAST_RAISE keys on (server, poleKey, texture) — after
    // the move the pole is the new one, and the raise that qualified the
    // rebind was this faction's own texture AT that pole, so the clock finds
    // it with no compensating write.
    const [ev] = await raise(P2_KEY, ago(60_000), 10);
    const target = (await rebindStore.factionFor(factionId))!;
    expect(await rebindStore.rebind({
      factionId, leaderDiscordId: "leader",
      expectedPoleKey: target.poleKey!,
      poleKey: P2_KEY, x: P2.x, y: P2.y, z: P2.z,
      evidenceEventId: ev!.id,
      at: now, notBefore: ago(604_800_000),
    })).toBe("ok");

    const clock = await clockFor(factionId);
    expect(clock.status).toBe("active");
    expect(clock.dormantSince).toBeNull();
    expect(decide(clock, now, W)).toBeNull();
  });

  it("still goes dormant 7 days after the rebind if the flag never flies again", async () => {
    // Reviving must restart the clock, not disable it.
    const [ev] = await raise(P2_KEY, ago(60_000), 10);
    const target = (await rebindStore.factionFor(factionId))!;
    await rebindStore.rebind({
      factionId, leaderDiscordId: "leader",
      expectedPoleKey: target.poleKey!,
      poleKey: P2_KEY, x: P2.x, y: P2.y, z: P2.z,
      evidenceEventId: ev!.id,
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
    const [ev] = await raise(P2_KEY, ago(60_000), 10);

    const target = (await rebindStore.factionFor(factionId))!;
    await rebindStore.rebind({
      factionId, leaderDiscordId: "leader",
      expectedPoleKey: target.poleKey!,
      poleKey: P2_KEY, x: P2.x, y: P2.y, z: P2.z,
      evidenceEventId: ev!.id,
      at: now, notBefore: ago(604_800_000),
    });

    const clock = await clockFor(factionId);
    expect(clock.status).toBe("active");
    expect(clock.dormantSince).toBeNull();
    expect(decide(clock, now, W)).toBeNull();
  });
});
