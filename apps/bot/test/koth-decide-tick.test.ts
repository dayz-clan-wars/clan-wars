import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, admFiles, airdropEvents, events, kothEvents, kothVotes,
  playerSessions, servers, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { kothDecideTick } from "../src/koth-decide-tick.js";
import { kothTick } from "../src/koth-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NOW = at("2026-10-03T19:30:00Z");

describe("kothDecideTick", () => {
  let db: Database; let serverId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, koth_events, airdrop_events, player_sessions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id; line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true });
  });

  /** Same helper as airdrop-tick.test.ts: n sessions from `from` to `to`. */
  async function online(n: number, from: string, to: string | null) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    for (let i = 0; i < n; i++) {
      const [e] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at(from), payload: {} }).returning({ id: events.id });
      await db.insert(playerSessions).values({ serverId, dayzId: `p${from}-${i}`, connectedAt: at(from), connectEventId: e!.id, disconnectedAt: to ? at(to) : null, closeReason: to ? "disconnect" : null });
    }
  }
  const rows = () => db.select().from(kothEvents);
  const run = (post: (c: string) => Promise<void> = vi.fn(async () => {}), over = {}) =>
    kothDecideTick(db, post, { now: NOW, weeklyCap: 2, minPop: 10, rng: () => 0, ...over });
  const koth = (over: Partial<typeof kothEvents.$inferInsert>) => db.insert(kothEvents).values({
    serverId, slotAt: SLOT, location: "lembork", centreX: "1", centreZ: "1", state: "scheduled", origin: "admin", scheduledByDiscordId: "99", ...over,
  });

  it("decides, posts, and stamps announced_at and reminded_at together", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    const post = vi.fn(async (_c: string) => {});
    expect(await run(post)).toEqual({ decided: 1, posted: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, origin: "auto", state: "scheduled", scheduledByDiscordId: null, awardKey: null, popAtDecision: 11 });
    expect(row!.announcedAt).toEqual(NOW);
    expect(row!.remindedAt).toEqual(NOW);
    expect(post.mock.calls[0]![0]).toContain("No prize this time");
  });

  // ⚠️ The decision is AT the reminder instant; koth-tick must not post a second message.
  it("is never followed by a reminder post", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await run();
    const announce = vi.fn(async () => {});
    await kothTick(db, { announce, ops: vi.fn(async () => {}) }, { now: at("2026-10-03T19:31:00Z"), siteBaseUrl: "https://x" });
    expect(announce).not.toHaveBeenCalled();
  });

  it("does nothing before the decision instant", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    expect((await run(undefined, { now: at("2026-10-03T19:29:00Z") })).decided).toBe(0);
  });

  it("does not fire below the floor", async () => {
    await online(9, "2026-10-03T18:00:00Z", null);
    expect((await run()).decided).toBe(0);
  });

  it("does not fire below the high-water mark", async () => {
    await online(15, "2026-10-01T19:00:00Z", "2026-10-01T20:00:00Z");
    await online(11, "2026-10-03T18:00:00Z", null);
    expect((await run()).decided).toBe(0);
  });

  it("skips a slot with an open vote, and one with a failed vote", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    const vote = { serverId, slotAt: SLOT, location: "borek", startedByDiscordId: "d1", openedAt: at("2026-10-03T19:00:00Z"), closesAt: NOW, electorateSize: 5, turnoutFloor: 5 };
    await db.insert(kothVotes).values({ ...vote, state: "open" });
    expect((await run()).decided).toBe(0);
    await db.execute(sql`update koth_votes set state = 'failed', closed_at = ${NOW.toISOString()}::timestamptz`);
    expect((await run()).decided).toBe(0);
  });

  it("yields to a hand-placed airdrop for the slot", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await db.insert(airdropEvents).values({ serverId, slotAt: SLOT, location: "brena", colour: "blue", decidedAt: at("2026-10-03T12:00:00Z"), popAtDecision: 0, threshold: "0", state: "announced", manual: true, announcedAt: at("2026-10-03T12:00:00Z") });
    expect((await run()).decided).toBe(0);
  });

  it("holds the 24 h gap against an admin event, and not the cap", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await koth({ slotAt: at("2026-10-03T00:00:00Z"), state: "no_winner" });
    expect((await run()).decided).toBe(0);
  });

  it("counts only automatic events against the cap", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await koth({ slotAt: at("2026-09-28T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    await koth({ slotAt: at("2026-09-30T20:00:00Z"), state: "no_winner", origin: "vote" });
    expect((await run()).decided).toBe(1);
    await db.execute(sql`truncate table koth_events restart identity cascade`);
    await koth({ slotAt: at("2026-09-28T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    await koth({ slotAt: at("2026-09-30T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    expect((await run()).decided).toBe(0);
  });

  // Review focus 3: the cap is keyed on the SLOT's week.
  it("counts the cap by the slot's ISO week", async () => {
    const sunNow = at("2026-10-04T23:30:00Z"); // decides the Monday 00:00 slot
    await online(11, "2026-10-04T22:00:00Z", null);
    await koth({ slotAt: at("2026-09-29T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    await koth({ slotAt: at("2026-10-01T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    expect((await run(undefined, { now: sunNow })).decided).toBe(1);
  });

  it("retries a failed announcement, and never posts an unannounced row late", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    expect(await run(vi.fn(async () => { throw new Error("gone"); }))).toEqual({ decided: 1, posted: 0 });
    const post = vi.fn(async () => {});
    expect(await run(post, { now: at("2026-10-03T19:31:00Z") })).toEqual({ decided: 0, posted: 1 });
    expect((await rows())[0]!.announcedAt).not.toBeNull();
  });

  it("leaves a never-announced row for koth-tick to fail, with no cancellation", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await run(vi.fn(async () => { throw new Error("gone"); }));
    const announce = vi.fn(async () => {});
    await kothTick(db, { announce, ops: vi.fn(async () => {}) }, { now: at("2026-10-03T22:20:00Z"), siteBaseUrl: "https://x" });
    expect((await rows())[0]!.state).toBe("failed");
    expect(announce).not.toHaveBeenCalled();
  });

  // F1: an admin's (or the tick's own) cancel of a slot must stick — the tick must
  // never decide a second automatic event for a slot that already has a row, of
  // any state.
  it("never re-decides a slot whose automatic row was cancelled", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    expect((await run()).decided).toBe(1);
    await db.execute(sql`update koth_events set state = 'cancelled' where slot_at = ${SLOT.toISOString()}::timestamptz`);
    expect((await run(undefined, { now: at("2026-10-03T19:31:00Z") })).decided).toBe(0);
    expect((await rows()).length).toBe(1);
  });

  it("never decides over a cancelled admin row for the slot", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await koth({ state: "cancelled" });
    expect((await run()).decided).toBe(0);
    expect((await rows()).length).toBe(1);
  });
});
