import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, admFiles, airdropEvents, events, playerSessions, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { airdropTick } from "../src/airdrop-tick.js";
import { airdropText } from "../src/airdrop-text.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
/** 19:30Z: the decision instant for the 20:00Z slot. */
const NOW = at("2026-09-21T19:30:00Z");

describe("airdropTick", () => {
  let db: Database; let serverId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, player_sessions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
    line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true });
  });

  /**
   * n players online from `from` until `to` (null = still connected).
   * ⚠️ Each session needs a real connect event, the way the schema requires —
   * the same shape `online-store.test.ts`'s `mkSession` uses.
   */
  async function online(n: number, from: string, to: string | null) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    for (let i = 0; i < n; i++) {
      const [e] = await db.insert(events).values({
        serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never,
        occurredAt: at(from), payload: {},
      }).returning({ id: events.id });
      await db.insert(playerSessions).values({
        serverId, dayzId: `p${from}-${i}`, connectedAt: at(from), connectEventId: e!.id,
        disconnectedAt: to ? at(to) : null, closeReason: to ? "disconnect" : null,
      });
    }
  }

  const rows = () => db.select().from(airdropEvents);
  const run = (post: (c: string) => Promise<void>, over = {}) =>
    airdropTick(db, post, { now: NOW, weeklyCap: 2, minPop: 5, rng: () => 0, ...over });

  it("decides and announces at a real peak", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    // ⚠️ Typed with the string param (unlike the other tests' bare `vi.fn(async () => {})`)
    // so `post.mock.calls[0]![0]` below has something to index — the untyped form infers
    // a zero-arg call tuple and fails `tsc` on that index, not on anything runtime.
    const post = vi.fn(async (_content: string) => {});
    const r = await run(post);
    expect(r).toEqual({ decided: 1, posted: 1, failed: 0 });
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: at("2026-09-21T20:00:00Z"), state: "announced", popAtDecision: 6 });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining(row!.location.charAt(0).toUpperCase() + row!.location.slice(1)));
    // ⚠️ The colour is the gamble (spec §3.4) — it must not be in the message.
    expect(post.mock.calls[0]![0]).not.toContain(row!.colour);
  });

  it("does nothing before the decision instant", async () => {
    await online(9, "2026-09-21T18:00:00Z", null);
    const r = await run(vi.fn(async () => {}), { now: at("2026-09-21T19:00:00Z") });
    expect(r.decided).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("does not fire below the floor", async () => {
    await online(3, "2026-09-21T18:00:00Z", null);
    expect((await run(vi.fn(async () => {}))).decided).toBe(0);
  });

  // ⚠️ Spec §9's refund is real, but not on the same tick as a transient post failure
  // (spec §9, ruling: the tick runs ~every 10s and the decision fires 30min ahead of
  // the slot, so a rate-limited or blipped post gets on the order of 180 more chances
  // before the window closes). Failing fast here would spend the week's cap on a
  // hiccup a later retry would have cleared, on this same day of a quiet week besides.
  it("does not write off a freshly-decided drop when the post fails once, the window still open", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    const r = await run(vi.fn(async () => { throw new Error("channel gone"); }));
    expect(r).toEqual({ decided: 1, posted: 0, failed: 0 });
    const [row] = await rows();
    expect(row!.state).toBe("announced");
    expect(row!.announcedAt).toBeNull();
  });

  // ⚠️ This is where spec §9's refund actually happens: not at the failed post above,
  // but once the slot itself has come and gone with nobody ever told. Only past this
  // point is the budget back and the week's count free of the row.
  it("fails and refunds a decided row once its slot arrives with the post never landed", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => { throw new Error("channel gone"); }));
    const r = await run(vi.fn(async () => { throw new Error("still gone"); }), { now: at("2026-09-21T20:00:00Z") });
    expect(r.failed).toBe(1);
    const [row] = await rows();
    expect(row!.state).toBe("failed");
    expect(row!.announcedAt).toBeNull();
    expect(row!.endedAt).not.toBeNull();
  });

  it("retries the post for a decided-but-unannounced row while the slot is still ahead", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => { throw new Error("nope"); }));
    await db.update(airdropEvents).set({ state: "announced" });
    const post = vi.fn(async () => {});
    const r = await run(post, { now: at("2026-09-21T19:40:00Z") });
    expect(r.posted).toBe(1);
    expect(post).toHaveBeenCalled();
    expect((await rows())[0]!.announcedAt).not.toBeNull();
  });

  it("refuses a second drop inside 24 hours", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => {}));
    await db.update(airdropEvents).set({ state: "ended" });
    const r = await run(vi.fn(async () => {}), { now: at("2026-09-22T13:30:00Z") });
    expect(r.decided).toBe(0);
  });

  // ⚠️ Dated INSIDE the current ISO week (isoWeekStart(NOW) is Monday 2026-09-21,
  // since NOW itself falls on a Monday) and more than 24h before the `now` this test
  // uses, so neither the `gte(decidedAt, isoWeekStart(...))` term nor the 24h gap
  // masks the result on its own — only `manual: false` in the week query can be doing
  // the excluding here. A manual row dated in the PREVIOUS week would pass this test
  // even with that term deleted, which pins nothing.
  // ⚠️ Runs at Wednesday 19:30 of the SAME ISO week, not the file's default NOW
  // (Monday 19:30): the week starts at Monday 00:00, only 19.5h before the default
  // NOW, which leaves no room for a decidedAt that is both inside the current week
  // and more than 24h in the past. Wednesday gives that room without leaving the week.
  it("does not count a manual drop against the week's cap", async () => {
    const now = at("2026-09-23T19:30:00Z");
    await online(6, "2026-09-23T18:00:00Z", null);
    await db.insert(airdropEvents).values({
      serverId, slotAt: at("2026-09-21T02:00:00Z"), location: "lukow", colour: "blue",
      decidedAt: at("2026-09-21T01:30:00Z"), popAtDecision: 4, threshold: "0",
      state: "ended", manual: true, announcedAt: at("2026-09-21T01:30:01Z"),
    });
    const r = await run(vi.fn(async () => {}), { now, weeklyCap: 1 });
    expect(r.decided).toBe(1);
  });

  // ⚠️ The asymmetry that matters: manual is excluded from the CAP count only. It
  // still holds the 24h gap and the one-open-drop-at-a-time guard shut, because those
  // two are about the players' experience of the event, not the budget (spec §9's
  // comment on `airdropEvents.manual`). Without this test, a later "simplification"
  // could exclude manual from the gap/open checks too and nothing would catch it.
  it("still holds a manual drop's 24h gap shut against a new automatic decision", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await db.insert(airdropEvents).values({
      serverId, slotAt: at("2026-09-21T14:00:00Z"), location: "lukow", colour: "blue",
      decidedAt: at("2026-09-21T13:30:00Z"), popAtDecision: 4, threshold: "0",
      state: "ended", manual: true, announcedAt: at("2026-09-21T13:30:01Z"),
    });
    const r = await run(vi.fn(async () => {}));
    expect(r.decided).toBe(0);
  });

  it("refuses once the week's cap is spent", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => {}));
    await db.update(airdropEvents).set({ state: "ended" });
    const r = await run(vi.fn(async () => {}), { now: at("2026-09-23T19:30:00Z"), weeklyCap: 1 });
    expect(r.decided).toBe(0);
  });

  // ⚠️ §3.1's percentile: a peak is relative to the server's own recent peaks, and
  // the floor alone must not let a routine evening spend the week's budget.
  // ⚠️ A live population AT the decision instant is required here — without it `pop`
  // is 0 and `shouldFire` refuses on the FLOOR, not the percentile, and this test
  // would still pass with `popsAt`/`p90` deleted entirely. It is the one test standing
  // between "a routine evening" and "spends the week's budget", so it has to fail for
  // the percentile reason specifically.
  it("holds the percentile once the server has grown past the floor", async () => {
    // 14 days where every decision instant had 9 on: p90 is 9, and 6 is not a peak.
    for (let d = 0; d < 14; d++) {
      await online(9, `2026-09-${String(7 + d).padStart(2, "0")}T00:00:00Z`, `2026-09-${String(8 + d).padStart(2, "0")}T00:00:00Z`);
    }
    await online(6, "2026-09-21T18:00:00Z", null);
    const r = await run(vi.fn(async () => {}));
    expect(r.decided).toBe(0);
  });
});

describe("airdropText", () => {
  it("names the place, counts down by itself, and says nothing about the colour", () => {
    const body = airdropText("dolnik", at("2026-09-21T20:00:00Z"));
    expect(body).toContain("Dolnik");
    expect(body).toContain(`<t:${1790020800}:R>`);
    expect(body).not.toMatch(/blue|orange|yellow/i);
    // House rule: no em dashes in player-facing copy.
    expect(body).not.toContain("—");
  });
});
