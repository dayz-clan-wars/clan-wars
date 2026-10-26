import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, awardGrants, clanNotices, consumerCursors, servers, wellAwards, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { seedEvent, seedLink, seedServer } from "./achievements/seed.js";
import { WELL_AWARD_CONSUMER, payWellAwards, wellAwardTick } from "../src/well-award-tick.js";
import { bricksNear, wellAnchor } from "../src/wells.js";

// The catalogue-loss test removes plate-carrier; every other test sees the real catalogue.
// The per-row isolation test makes grantAwardTx refuse one winner.
const stub = vi.hoisted(() => ({ dropPlateCarrier: false, refuseFor: null as string | null }));
vi.mock("@factions/roster/internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@factions/roster/internal")>();
  return {
    ...real,
    grantAwardTx: (...args: Parameters<typeof real.grantAwardTx>) =>
      args[1].winnerDiscordId === stub.refuseFor ? Promise.resolve({ ok: false, reason: "stubbed refusal" }) : real.grantAwardTx(...args),
  };
});
vi.mock("@factions/domain/awards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@factions/domain/awards")>();
  return {
    ...real,
    awardsCatalogue: () => {
      const all = real.awardsCatalogue();
      if (!stub.dropPlateCarrier) return all;
      const { ["plate-carrier"]: _gone, ...rest } = all;
      return rest;
    },
  };
});

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-10-20T00:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const SITE = "https://dayzclanwars.com";
const BOT = "1000";
const A = "A".repeat(40); const B = "B".repeat(40); const C = "C".repeat(40);
const opts = (now = h(100)) => ({ now, siteBaseUrl: SITE, grantedByDiscordId: BOT });

describe("wellAwardTick", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table well_awards, award_grants, clan_notices, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    serverId = (await seedServer(db)).id;
    stub.dropPlateCarrier = false; stub.refuseFor = null;
  });
  // ⚠️ Close each test's pool: the bot suite shares one Postgres, and unclosed per-test
  // clients pushed CI's service container past max_connections (PR #221).
  afterEach(async () => { stub.dropPlateCarrier = false; stub.refuseFor = null; await db.$client.end(); });

  const place = (who: string, part: string, at: Date, x = 1000, z = 1000, server = serverId) =>
    seedEvent(db, { serverId: server, type: "base.built", at, payload: { dayzId: who, gamertag: "G", part, tool: "Shovel", structure: null, pos: { x, y: 10, z } } });
  const link = (dayzId: string, discordId: string) => seedLink(db, { dayzId, discordId, gamertag: "G", verifiedAt: t0 });

  it("records and pays a linked roof-builder one plate-carrier for 7 days, reason \"Rebuilt a well\"", async () => {
    await link(A, "7");
    const brick = await place(B, "well_brick", h(1));
    const roof = await place(A, "roof", h(2));
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 1 });
    const [g] = await db.select().from(awardGrants);
    expect(g).toMatchObject({ awardKey: "plate-carrier", discordId: "7", grantedByDiscordId: BOT, durationDays: 7, reason: "Rebuilt a well" });
    const [w] = await db.select().from(wellAwards);
    expect(w).toMatchObject({ serverId, dayzId: A, wellBrickEventId: brick.id, roofEventId: roof.id, roofedAt: roof.occurredAt, awardGrantId: g!.id, awardFailure: null });
    expect((await db.select().from(clanNotices)).map((n) => n.kind)).toEqual(["award_granted"]);
    const [c] = await db.select().from(consumerCursors).where(sql`${consumerCursors.consumerName} = ${WELL_AWARD_CONSUMER}`);
    expect(c!.lastEventId).toBe(roof.id);
  });

  it("⚠️ an unlinked roof-builder is owed, not paid, and is paid the tick after linking", async () => {
    await place(B, "well_brick", h(1));
    await place(A, "roof", h(2));
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 0 });
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect((await db.select().from(wellAwards))[0]).toMatchObject({ dayzId: A, awardGrantId: null, awardFailure: null });
    await link(A, "7");
    expect(await wellAwardTick(db, opts(h(200)))).toEqual({ recorded: 0, paid: 1 });
    expect(await db.select().from(awardGrants)).toEqual([expect.objectContaining({ discordId: "7", durationDays: 7 })]);
  });

  it("⚠️ the same player roofing the same well after a rebuild (new brick 2 m away) is not paid again", async () => {
    await link(A, "7");
    const first = await place(B, "well_brick", h(1), 1000, 1000);
    await place(A, "roof", h(2), 1001, 1000);
    // Decayed and rebuilt: the new brick is 2 m from the old, and this roof is 4.5 m from
    // the new brick but 6.5 m from the old one, so only the new brick is within reach of it.
    await place(C, "well_brick", h(50), 1002, 1000);
    await place(A, "roof", h(51), 1006.5, 1000);
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 1 });
    expect(await db.select().from(awardGrants)).toHaveLength(1);
    expect((await db.select().from(wellAwards)).map((w) => w.wellBrickEventId)).toEqual([first.id]);
  });

  it("⚠️ a rebuild brick that brings a neighbouring well's earlier brick within reach does not pay that well again", async () => {
    await link(A, "7");
    // Well A's brick, then well B's brick 8 m away and later: two wells.
    const a1 = await place(B, "well_brick", h(1), 1000, 1000);
    const b1 = await place(C, "well_brick", h(2), 1008, 1000);
    await place(A, "roof", h(3), 1008, 1000);
    // B rebuilt with a brick between the two: the earliest brick within 5 m of it is A1.
    await place(C, "well_brick", h(50), 1004.5, 1000);
    await place(A, "roof", h(51), 1006, 1000);
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 1 });
    expect(await db.select().from(awardGrants)).toHaveLength(1);
    expect((await db.select().from(wellAwards)).map((w) => w.wellBrickEventId)).toEqual([b1.id]);
    expect(a1.id).not.toBe(b1.id);
  });

  it("a different player roofing that same well later is paid", async () => {
    await link(A, "7"); await link(C, "8");
    const first = await place(B, "well_brick", h(1));
    await place(A, "roof", h(2));
    await place(B, "well_brick", h(50), 1002, 1000);
    await place(C, "roof", h(51), 1004, 1000);
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 2, paid: 2 });
    expect((await db.select().from(awardGrants)).map((g) => g.discordId).sort()).toEqual(["7", "8"]);
    expect((await db.select().from(wellAwards)).map((w) => w.wellBrickEventId)).toEqual([first.id, first.id]);
  });

  it("two wells 6 m apart are two wells: one player roofing both gets two plate carriers", async () => {
    await link(A, "7");
    const w1 = await place(B, "well_brick", h(1), 1000, 1000);
    const w2 = await place(B, "well_brick", h(1), 1006, 1000);
    await place(A, "roof", h(2), 1000, 1000);
    await place(A, "roof", h(3), 1006, 1000);
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 2, paid: 2 });
    expect((await db.select().from(wellAwards)).map((w) => w.wellBrickEventId)).toEqual([w1.id, w2.id]);
  });

  it("a roof with no brick within 5 m records nothing", async () => {
    await link(A, "7");
    await place(B, "well_brick", h(1), 1000, 1000);
    await place(A, "roof", h(2), 1006, 1000);
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 0, paid: 0 });
    expect(await db.select().from(wellAwards)).toEqual([]);
  });

  it("a brick laid only after the roof does not make that roof a well", async () => {
    await link(A, "7");
    await place(A, "roof", h(1));
    await place(B, "well_brick", h(2));
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 0, paid: 0 });
  });

  it("a brick on another server is not a well on this one", async () => {
    await link(A, "7");
    // Not seedServer: it forgets the first server's ADM file, and a second "S" clashes on name+map.
    const [o] = await db.insert(servers).values({ name: "Other", map: "livonia", clockOffsetMs: 0 }).returning();
    const other = o!.id;
    await place(B, "well_brick", h(1), 1000, 1000, other);
    await place(A, "roof", h(2));
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 0, paid: 0 });
  });

  it("⚠️ re-running the tick, or rewinding the cursor to 0, pays nothing more", async () => {
    await link(A, "7");
    await place(B, "well_brick", h(1));
    await place(A, "roof", h(2));
    await place(A, "roof", h(3));
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 1 });
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 0, paid: 0 });
    await db.execute(sql`update consumer_cursors set last_event_id = 0 where consumer_name = ${WELL_AWARD_CONSUMER}`);
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 0, paid: 0 });
    expect(await db.select().from(awardGrants)).toHaveLength(1);
    expect(await db.select().from(wellAwards)).toHaveLength(1);
  });

  it("⚠️ two payout passes racing over one owed award grant it exactly once", async () => {
    // Recorded while unlinked, so the award is still owed when both passes start.
    await place(B, "well_brick", h(1));
    await place(A, "roof", h(2));
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 0 });
    await link(A, "7");
    const paid = await Promise.all([payWellAwards(db, opts()), payWellAwards(db, opts())]);
    expect(paid.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await db.select().from(awardGrants)).toHaveLength(1);
    expect((await db.select().from(clanNotices)).map((n) => n.kind)).toEqual(["award_granted"]);
  });

  it("⚠️ plate-carrier missing from the catalogue sets award_failure once and stops retrying", async () => {
    await link(A, "7");
    await place(B, "well_brick", h(1));
    await place(A, "roof", h(2));
    stub.dropPlateCarrier = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 1, paid: 0 });
    const [w] = await db.select().from(wellAwards);
    expect(w!.awardFailure).toMatch(/plate-carrier/u);
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(await wellAwardTick(db, opts(h(200)))).toEqual({ recorded: 0, paid: 0 });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("⚠️ one award that fails to grant does not stop the next one being paid, and it stays owed", async () => {
    await link(A, "7"); await link(C, "8");
    await place(B, "well_brick", h(1));
    await place(A, "roof", h(2));
    await place(C, "roof", h(3));
    stub.refuseFor = "7";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await wellAwardTick(db, opts())).toEqual({ recorded: 2, paid: 1 });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
    const rows = await db.select().from(wellAwards).orderBy(wellAwards.id);
    expect(rows[0]).toMatchObject({ dayzId: A, awardGrantId: null, awardFailure: null });
    expect(rows[1]!.awardGrantId).not.toBeNull();
    // The refused row rolled back whole: no grant, no DM. Next tick it is paid.
    expect((await db.select().from(clanNotices))).toHaveLength(1);
    stub.refuseFor = null;
    expect(await wellAwardTick(db, opts(h(200)))).toEqual({ recorded: 0, paid: 1 });
    expect(await db.select().from(awardGrants)).toHaveLength(2);
  });
});

describe("well identity (bricksNear + wellAnchor)", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table well_awards, award_grants, clan_notices, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    serverId = (await seedServer(db)).id;
  });
  afterEach(async () => { await db.$client.end(); });
  const brick = (at: Date, x = 1000, z = 1000) =>
    seedEvent(db, { serverId, type: "base.built", at, payload: { dayzId: A, gamertag: "G", part: "well_brick", tool: "Shovel", structure: null, pos: { x, y: 10, z } } });

  it("the anchor is the earliest brick, not the lowest id", async () => {
    const later = await brick(h(5));
    const earlier = await brick(h(1), 1002, 1000);
    expect(wellAnchor(await bricksNear(db, serverId, 1000, 1000))).toBe(earlier.id);
    expect(later.id).toBeLessThan(earlier.id);
  });

  it("two bricks at the same instant: the lower id is the anchor", async () => {
    const one = await brick(h(1));
    const two = await brick(h(1), 1001, 1000);
    expect(one.id).toBeLessThan(two.id);
    expect(wellAnchor(await bricksNear(db, serverId, 1000, 1000))).toBe(one.id);
    expect(wellAnchor(await bricksNear(db, serverId, 1001, 1000))).toBe(one.id);
  });

  it("a rebuild 2 m from the original anchors to the original", async () => {
    const original = await brick(h(1), 1000, 1000);
    const rebuilt = await brick(h(50), 1002, 1000);
    expect(wellAnchor(await bricksNear(db, serverId, 1002, 1000))).toBe(original.id);
    expect(rebuilt.id).not.toBe(original.id);
  });

  it("an empty well throws rather than inventing an anchor", () => {
    expect(() => wellAnchor([])).toThrow();
  });
});
