import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, kothEvents, servers, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { kothGroup } from "../src/commands/koth.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NOW = at("2026-10-03T12:00:00Z");

const schedule = kothGroup.specs.find((s) => s.path === "koth schedule")!.handler;
const cancel = kothGroup.specs.find((s) => s.path === "koth cancel")!.handler;
const status = kothGroup.specs.find((s) => s.path === "koth status")!.handler;

describe("/koth", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_events, airdrop_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const ctx = (post: ((c: string) => Promise<void>) | null = vi.fn(async () => {}), now: Date = NOW) =>
    ({ db, now, serverEvents: null, bountiesEnabled: false, koth: post, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (over: Partial<CommandInput> & { location?: string; at?: string } = {}) => ({
    actorDiscordId: "99", isAdmin: true,
    string: (n: string) => (n === "location" ? over.location ?? "lembork" : over.at ?? SLOT.toISOString()),
    integer: () => null, boolean: () => null, user: () => null,
    ...over,
  }) as unknown as CommandInput;
  const rows = () => db.select().from(kothEvents);

  it("schedules, announces, and stamps announced_at", async () => {
    const post = vi.fn(async () => {});
    const reply = await schedule(ctx(post), input());
    expect(reply.content).toMatch(/Lembork/);
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, location: "lembork", state: "scheduled", scheduledByDiscordId: "99" });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining("LEMBORK"));
  });

  it("refuses a non-admin", async () => {
    const reply = await schedule(ctx(), input({ isAdmin: false }));
    expect(reply.content).toMatch(/admin/i);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses with KOTH_TICK off", async () => {
    const reply = await schedule(ctx(null), input());
    expect(reply.content).toMatch(/KOTH_TICK/);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses an unknown town, a non-slot time, and a slot under 30 minutes away", async () => {
    const unknownTown = await schedule(ctx(), input({ location: "narnia" }));
    expect(unknownTown.content).toMatch(/not one of/);
    const notASlot = await schedule(ctx(), input({ at: "2026-10-03T21:00:00Z" }));
    expect(notASlot.content).toMatch(/restart slot/);
    const tooSoon = await schedule(ctx(undefined, at("2026-10-03T19:45:00Z")), input());
    expect(tooSoon.content).toMatch(/30 minutes/);
    expect(await rows()).toHaveLength(0);
  });

  // ⚠️ Spec §2.12.
  it("refuses while another event is scheduled or live", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: at("2026-10-03T18:00:00Z"), location: "dolnik", centreX: "0", centreZ: "0",
      state: "scheduled", scheduledByDiscordId: "1", announcedAt: NOW,
    });
    const reply = await schedule(ctx(), input());
    expect(reply.content).toMatch(/already/i);
    expect(await rows()).toHaveLength(1);
  });

  it("refuses a slot an airdrop holds", async () => {
    await db.insert(airdropEvents).values({
      serverId, slotAt: SLOT, location: "dolnik", colour: "blue", decidedAt: NOW,
      popAtDecision: 4, threshold: "0", state: "announced", announcedAt: NOW,
    });
    const reply = await schedule(ctx(), input());
    expect(reply.content).toMatch(/airdrop/i);
    expect(await rows()).toHaveLength(0);
  });

  it("marks the row failed and says so when the announcement cannot post", async () => {
    const reply = await schedule(ctx(vi.fn(async () => { throw new Error("channel gone"); })), input());
    expect(reply.content).toMatch(/could not/i);
    const [row] = await rows();
    expect(row!.state).toBe("failed");
    expect(row!.announcedAt).toBeNull();
  });

  it("cancel moves a scheduled event to cancelled and refuses a live one", async () => {
    await schedule(ctx(), input());
    const cancelled = await cancel(ctx(), input());
    expect(cancelled.content).toMatch(/cancelled/i);
    const [row] = await rows();
    expect(row!.state).toBe("cancelled");

    const [prior] = await rows();
    await db.update(kothEvents).set({ state: "live" }).where(eq(kothEvents.id, prior!.id));
    const live = await cancel(ctx(), input());
    expect(live.content).toMatch(/live/i);
    const [after] = await rows();
    expect(after!.state).toBe("live");
  });

  it("cancel refuses a non-admin and reports nothing scheduled", async () => {
    const nonAdmin = await cancel(ctx(), input({ isAdmin: false }));
    expect(nonAdmin.content).toMatch(/admin/i);
    const nothing = await cancel(ctx(), input());
    expect(nothing.content).toMatch(/nothing/i);
  });

  it("status reports the scheduled event, or that none is scheduled", async () => {
    const none = await status(ctx(), input());
    expect(none.content).toMatch(/no king of the hill/i);
    await schedule(ctx(), input());
    const reply = await status(ctx(), input());
    expect(reply.content).toMatch(/Lembork/);
    expect(reply.content).toMatch(/scheduled/);
  });

  // (I1) The open-check is a plain SELECT, not a lock: two concurrent calls can both
  // pass it and both reach the INSERT. `koth_events_one_open` (or, racing the same
  // slot, `koth_events_slot_uq`) is what actually stops the second row; this pins
  // that the loser gets the same friendly refusal as the pre-existing "already
  // scheduled" reply — never a raw error reaching the router's generic failure text
  // — and that exactly one row lands.
  //
  // ⚠️ A bare `Promise.all([schedule(...), schedule(...)])` on a cold pool does NOT
  // race here: postgres.js's pool starts with no connections, and the first call
  // finishes its whole sequence of round trips on an already-idle connection before
  // the second call's new connection has even finished its handshake — confirmed by
  // instrumenting both calls (the second settles strictly after the first, every
  // time, over 5 runs). Issuing a couple of trivial queries first forces the pool to
  // open (and idle) two connections, so the two schedule() calls that follow actually
  // start from warm connections and interleave — confirmed to reproduce the raw
  // `23505` on `koth_events_one_open` deterministically, every time, against the
  // unpatched handler.
  it("a concurrent /koth schedule gets the friendly refusal, not a raw error", async () => {
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`), db.execute(sql`select 1`)]);
    const postA = vi.fn(async () => {});
    const postB = vi.fn(async () => {});
    const [replyA, replyB] = await Promise.all([
      schedule(ctx(postA), input()),
      schedule(ctx(postB), input()),
    ]);
    const replies = [replyA, replyB];
    const winners = replies.filter((r) => /Lembork/.test(r.content ?? ""));
    const losers = replies.filter((r) => !/Lembork/.test(r.content ?? ""));
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.content).toMatch(/already|took that slot/i);
    expect(await rows()).toHaveLength(1);
  });

  it("autocompletes towns by prefix and the next 7 days of slots", async () => {
    const towns = await kothGroup.specs.find((s) => s.path === "koth schedule")!.autocomplete!.location!(ctx(), { actorDiscordId: "99", value: "le" });
    expect(towns.map((t) => t.value)).toContain("lembork");
    const slots = await kothGroup.specs.find((s) => s.path === "koth schedule")!.autocomplete!.at!(ctx(), { actorDiscordId: "99", value: "" });
    expect(slots.length).toBeLessThanOrEqual(25);
    expect(slots[0]!.value).toBe("2026-10-03T14:00:00.000Z");
  });
});
