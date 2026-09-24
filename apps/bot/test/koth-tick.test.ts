import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, kothEvents, servers, serverRestarts, events, kills,
  admFiles, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { KILLS_CONSUMER } from "../src/kills-tick.js";
import { kothTick } from "../src/koth-tick.js";

// A row id to make `scoreAndAward` throw for, set per-test — simplest reliable way to
// force the deliberate-throw path (a refused award grant) without wiring up a real
// refusal in `koth-score.ts`. `vi.mock`'s factory is hoisted above this file's other
// imports, so the set is declared with `vi.hoisted` and mutated from inside a test.
const throwForRowId = vi.hoisted(() => ({ id: null as number | null }));
vi.mock("../src/koth-score.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/koth-score.js")>();
  return {
    ...actual,
    scoreAndAward: async (db: Database, rowId: number, opts: { now: Date; siteBaseUrl: string }) => {
      if (rowId === throwForRowId.id) throw new Error("koth: forced scoring failure for test");
      return actual.scoreAndAward(db, rowId, opts);
    },
  };
});

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const END = at("2026-10-03T22:00:00Z");

describe("koth tick", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    throwForRowId.id = null;
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table koth_events, award_grants, clan_notices, kills, events, adm_files, identity_links, players, server_restarts, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f1.ADM", bootAt: SLOT, linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0;
  });

  /** One player.killed event + its kills row, as the kills consumer would write it. */
  async function kill(killer: string, victim: string, iso: string, victimPos: { x: number; z: number } | null, over: Partial<typeof kills.$inferInsert> = {}) {
    const payload = { killerDayzId: killer, victimDayzId: victim, ...(victimPos ? { victimPos: { x: victimPos.x, y: 100, z: victimPos.z } } : {}) };
    const [e] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.killed", occurredAt: at(iso), payload }).returning();
    await db.insert(kills).values({ serverId, eventId: e!.id, occurredAt: at(iso), victimDayzId: victim, killerDayzId: killer, cause: "killed", ...over });
    return e!.id;
  }
  /** An event past the window end, and the kills cursor past it: ingest has caught up. */
  async function ready() {
    const id = await kill("z", "y", "2026-10-03T22:20:00Z", null);
    await writeCursor(db, KILLS_CONSUMER, id);
  }
  const row = async (): Promise<typeof kothEvents.$inferSelect> => (await db.select().from(kothEvents))[0]!;

  it("fails a missed opening and posts a cancellation once", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "scheduled", scheduledByDiscordId: "a", announcedAt: at("2026-10-01T00:00:00Z"),
    });
    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:01:00Z"), siteBaseUrl: "https://x" });
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:02:00Z"), siteBaseUrl: "https://x" });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toMatch(/CANCELLED/);
    expect((await row()).state).toBe("failed");
  });

  it("reminds once inside the 30-minute window and never before it", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "scheduled", scheduledByDiscordId: "a", announcedAt: at("2026-10-01T00:00:00Z"),
    });
    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});
    // Before the window: restartSlot(19:00) = 18:00 < SLOT, so the missed-opening
    // sweep leaves this row alone too.
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T19:00:00Z"), siteBaseUrl: "https://x" });
    expect(announce).not.toHaveBeenCalled();
    expect((await row()).remindedAt).toBeNull();

    await kothTick(db, { announce, ops }, { now: at("2026-10-03T19:35:00Z"), siteBaseUrl: "https://x" });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toMatch(/30 MINUTES/);
    expect((await row()).remindedAt).not.toBeNull();

    // Still inside the window on a later tick: never posts twice.
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T19:50:00Z"), siteBaseUrl: "https://x" });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("posts the live announcement once", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "live", scheduledByDiscordId: "a", announcedAt: SLOT, openedAt: SLOT,
    });
    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:05:00Z"), siteBaseUrl: "https://x" });
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:10:00Z"), siteBaseUrl: "https://x" });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toMatch(/IS LIVE/);
    expect((await row()).livePostedAt).not.toBeNull();
  });

  it("scores only once ready, then posts results and stamps them", async () => {
    await db.insert(serverRestarts).values([
      { serverId, scheduledFor: SLOT, issuedAt: at("2026-10-03T20:00:04Z"), outcome: "restarted" },
      { serverId, scheduledFor: END, issuedAt: at("2026-10-03T22:00:04Z"), outcome: "restarted" },
    ]);
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "live", scheduledByDiscordId: "a", announcedAt: SLOT, openedAt: SLOT, livePostedAt: SLOT,
    });
    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});

    // Not ready: too soon after the closing restart, and no cursor yet either.
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:05:00Z"), siteBaseUrl: "https://x" });
    expect((await row()).state).toBe("live");
    expect((await row()).resultsPostedAt).toBeNull();

    await ready();
    const res = await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:30:00Z"), siteBaseUrl: "https://x" });
    expect(res.scored).toBe(1);
    const r = await row();
    expect(r.state).toBe("no_winner");
    expect(r.resultsPostedAt).not.toBeNull();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toMatch(/RESULTS|nobody/i);
  });

  it("leaves the stamp null when a post throws, and posts it on the next tick", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "live", scheduledByDiscordId: "a", announcedAt: SLOT, openedAt: SLOT,
    });
    const announce = vi.fn()
      .mockRejectedValueOnce(new Error("discord down"))
      .mockResolvedValue(undefined);
    const ops = vi.fn(async (_c: string) => {});
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:05:00Z"), siteBaseUrl: "https://x" });
    expect((await row()).livePostedAt).toBeNull();
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:10:00Z"), siteBaseUrl: "https://x" });
    expect((await row()).livePostedAt).not.toBeNull();
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("sends exactly one ops alert for a failed row, even across two ticks", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "failed", scheduledByDiscordId: "a", detail: { failure: "preset missing" },
    });
    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:05:00Z"), siteBaseUrl: "https://x" });
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:10:00Z"), siteBaseUrl: "https://x" });
    expect(ops).toHaveBeenCalledTimes(1);
    expect(ops.mock.calls[0]![0]).toMatch(/preset missing/);
  });

  it("alerts on a restore error once per distinct message", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "no_winner", scheduledByDiscordId: "a", detail: { restoreError: "cfggameplay.json could not be read" },
    });
    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:05:00Z"), siteBaseUrl: "https://x" });
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:10:00Z"), siteBaseUrl: "https://x" });
    expect(ops).toHaveBeenCalledTimes(1);
    expect(ops.mock.calls[0]![0]).toMatch(/cfggameplay\.json could not be read/);

    await db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || '{"restoreError":"events.xml could not be read"}'::jsonb` }).where(eq(kothEvents.serverId, serverId));
    await kothTick(db, { announce, ops }, { now: at("2026-10-03T20:15:00Z"), siteBaseUrl: "https://x" });
    expect(ops).toHaveBeenCalledTimes(2);
    expect(ops.mock.calls[1]![0]).toMatch(/events\.xml could not be read/);
  });

  // I2: `koth_events_one_open` allows only one `scheduled`/`live` row per server at a
  // time, so the sibling here is an already-`awarded` row (steps 5–7) rather than a
  // second live one — that's still enough to prove one row's thrown scoring cannot
  // starve a different row's results post in the same tick.
  it("a row whose scoring throws does not block another row's results post", async () => {
    await db.insert(serverRestarts).values([
      { serverId, scheduledFor: SLOT, issuedAt: at("2026-10-03T20:00:04Z"), outcome: "restarted" },
      { serverId, scheduledFor: END, issuedAt: at("2026-10-03T22:00:04Z"), outcome: "restarted" },
    ]);
    const [live] = await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "live", scheduledByDiscordId: "a", announcedAt: SLOT, openedAt: SLOT, livePostedAt: SLOT,
    }).returning();
    throwForRowId.id = live!.id;
    await ready();

    // A different, already-scored row on the same server, still awaiting its results
    // post — steps 5–7 must reach it even though the row above throws in step 4.
    const results = { top: [{ dayzId: "z", gamertag: "Z", kills: 3 }], topKiller: { dayzId: "z", gamertag: "Z", kills: 3 }, winner: null, droppedNoPosition: 0 };
    await db.insert(kothEvents).values({
      serverId, slotAt: at("2026-10-01T18:00:00Z"), location: "kabanino", centreX: "1000", centreZ: "2000",
      state: "no_winner", scheduledByDiscordId: "a", results,
    });

    const announce = vi.fn(async (_c: string) => {}); const ops = vi.fn(async (_c: string) => {});
    const res = await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:30:00Z"), siteBaseUrl: "https://x" });

    expect(res.scored).toBe(0);
    const rows = await db.select().from(kothEvents).where(eq(kothEvents.serverId, serverId));
    const liveRow = rows.find((r) => r.id === live!.id)!;
    expect(liveRow.state).toBe("live"); // the forced throw never wrote anything — next tick retries
    const scoredRow = rows.find((r) => r.location === "kabanino")!;
    expect(scoredRow.resultsPostedAt).not.toBeNull();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toMatch(/RESULTS/);
  });
});
