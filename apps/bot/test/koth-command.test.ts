import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, kothEvents, servers, admFiles, events, kills, players,
  serverRestarts, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { awardsCatalogue } from "@factions/domain/awards";
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
    await db.execute(sql`truncate table koth_events, airdrop_events, kills, events, adm_files, players, server_restarts, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const ctx = (post: ((c: string) => Promise<void>) | null = vi.fn(async () => {}), now: Date = NOW) =>
    ({ db, now, serverEvents: null, bountiesEnabled: false, koth: post, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (over: Partial<CommandInput> & { location?: string; at?: string; prize?: string } = {}) => ({
    actorDiscordId: "99", isAdmin: true,
    string: (n: string) => (n === "location" ? over.location ?? "lembork" : n === "prize" ? over.prize ?? "plate-carrier" : over.at ?? SLOT.toISOString()),
    integer: () => null, boolean: () => null, user: () => null,
    ...over,
  }) as unknown as CommandInput;
  const rows = () => db.select().from(kothEvents);

  it("schedules, announces, and stamps announced_at", async () => {
    const post = vi.fn(async () => {});
    const reply = await schedule(ctx(post), input());
    expect(reply.content).toMatch(/Lembork/);
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, location: "lembork", state: "scheduled", scheduledByDiscordId: "99", awardKey: "plate-carrier" });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining("LEMBORK"));
    expect(post).toHaveBeenCalledWith(expect.stringContaining("Plate Carrier"));
  });

  it("schedules with no prize: a null award_key, and the post says so", async () => {
    const post = vi.fn(async () => {});
    const reply = await schedule(ctx(post), input({ prize: "none" }));
    expect(reply.content).toMatch(/no prize/);
    const [row] = await rows();
    expect(row!.awardKey).toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining("No prize this time"));
  });

  it("refuses a prize the catalogue does not have", async () => {
    const reply = await schedule(ctx(), input({ prize: "golden-gun" }));
    expect(reply.content).toMatch(/prize/i);
    expect(await rows()).toHaveLength(0);
  });

  // ⚠️ Required, so "no prize" is always somebody's choice, never a blank field.
  it("registers prize as a required option: every catalogue award plus No prize", () => {
    const sub = (kothGroup.command.toJSON().options as { name: string; options?: { name: string; required?: boolean; choices?: { value: string }[] }[] }[])
      .find((o) => o.name === "schedule")!;
    const prize = sub.options!.find((o) => o.name === "prize")!;
    expect(prize.required).toBe(true);
    expect(prize.choices!.map((c) => c.value)).toEqual([...Object.keys(awardsCatalogue()), "none"]);
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

  // ⚠️ M2: at the opening slot the restart tick may already be writing the town's
  // files; a cancel now would race it. The next restart ends the session anyway.
  it("cancel refuses inside the opening slot and leaves the row alone", async () => {
    await schedule(ctx(), input());
    const reply = await cancel(ctx(undefined, at("2026-10-03T20:00:30Z")), input());
    expect(reply.content).toMatch(/opening this slot/i);
    expect(reply.content).toMatch(/next restart/i);
    const [row] = await rows();
    expect(row!.state).toBe("scheduled");
  });

  // ⚠️ FI4 (migration 0050): a cancelled or never-announced row must not hold its slot.
  it("a cancelled slot, or one whose announcement failed, can be scheduled again", async () => {
    await schedule(ctx(vi.fn(async () => { throw new Error("channel gone"); })), input());
    const first = await schedule(ctx(), input());
    expect(first.content).toMatch(/Scheduled/);
    await cancel(ctx(), input());
    const again = await schedule(ctx(), input());
    expect(again.content).toMatch(/Scheduled/);
    expect((await rows()).map((r) => r.state).sort()).toEqual(["cancelled", "failed", "scheduled"]);
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

  // ⚠️ Spec §7: a live event shows its standings so far, from the opening restart to now.
  it("status on a live event shows the top five so far, gamertags escaped", async () => {
    const [row] = await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "live", scheduledByDiscordId: "1", announcedAt: NOW, openedAt: SLOT,
    }).returning();
    await db.insert(serverRestarts).values({ serverId, scheduledFor: SLOT, issuedAt: at("2026-10-03T20:00:04Z"), outcome: "restarted" });
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: SLOT, linesIngested: 0, complete: true }).returning();
    await db.insert(players).values({ dayzId: "a", gamertag: "**Boss**", firstSeenAt: SLOT, lastSeenAt: SLOT });
    let line = 0;
    const kill = async (killer: string, iso: string, x: number) => {
      const [e] = await db.insert(events).values({ serverId, admFileId: f!.id, lineIndex: line++, type: "player.killed", occurredAt: at(iso),
        payload: { killerDayzId: killer, victimDayzId: `v${line}`, victimPos: { x, y: 100, z: 6635 } } }).returning();
      await db.insert(kills).values({ serverId, eventId: e!.id, occurredAt: at(iso), victimDayzId: `v${line}`, killerDayzId: killer, cause: "killed" });
    };
    await kill("a", "2026-10-03T20:10:00Z", 8675);
    await kill("a", "2026-10-03T20:11:00Z", 8680);
    await kill("b", "2026-10-03T20:12:00Z", 8675);
    await kill("b", "2026-10-03T20:00:01Z", 8675);        // before the opening restart was issued
    await kill("c", "2026-10-03T20:13:00Z", 8675 + 900);  // off the hill
    const reply = await status(ctx(undefined, at("2026-10-03T21:00:00Z")), input());
    expect(reply.content).toMatch(/live/);
    expect(reply.content).toContain("1. \\*\\*Boss\\*\\* — 2");
    expect(reply.content).toContain("2. b — 1");
    expect(reply.content).not.toMatch(/\bc — /);
    expect(row!.id).toBeGreaterThan(0);
  });

  it("status on a live event with no kills yet says so", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
      state: "live", scheduledByDiscordId: "1", announcedAt: NOW, openedAt: SLOT,
    });
    const reply = await status(ctx(undefined, at("2026-10-03T21:00:00Z")), input());
    expect(reply.content).toMatch(/no kills on the hill yet/i);
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
