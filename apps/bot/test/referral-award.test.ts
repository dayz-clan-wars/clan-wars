// apps/bot/test/referral-award.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, admFiles, events, identityLinks, referrals, referralQualifications, referralWeeks, referralWeekWinners, awardGrants, clanNotices,
  type Database,
} from "@factions/db";
import { writeCursor } from "@factions/event-log";
import { SESSIONS_CONSUMER } from "../src/sessions-tick.js";
import { closeReferralWeek, referralWeekReady } from "../src/referral-award.js";

/**
 * A mutable override for `awardsCatalogue()`, set by name so `vi.mock`'s factory
 * (hoisted above every import) can close over it. `null` means "use the real
 * catalogue" — every test but the missing-catalogue one below leaves it alone.
 */
const awardsOverride = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@factions/domain/awards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@factions/domain/awards")>();
  return { ...actual, awardsCatalogue: () => awardsOverride.current ?? actual.awardsCatalogue() };
});

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const WEEK = { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-28T10:00:00Z") };
const IN_WEEK = at("2026-09-24T12:00:00Z");
const CLOSE_AT = at("2026-09-28T11:00:00Z");
const opts = { now: CLOSE_AT, siteBaseUrl: "https://site.test", grantedByDiscordId: "bot" };
/** A week closed before WEEK, so WEEK is not the first-ever close (which is recorded unpaid, spec §6). */
const PRIOR_WEEK_START = at("2026-09-14T10:00:00Z");

describe("closing a referral week", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0; let n = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table referral_week_winners, referral_weeks, award_grants, clan_notices, events, adm_files, identity_links, consumer_cursors, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: WEEK.start, linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0; n = 0;
    await db.insert(referralWeeks).values({ weekStart: PRIOR_WEEK_START, closedAt: WEEK.start, topCount: 0 });
  });
  afterEach(() => { awardsOverride.current = null; });

  const link = (discordId: string) => db.insert(identityLinks).values({ discordId, dayzId: `dz-${discordId}`, gamertag: `gt-${discordId}`, verifiedAt: WEEK.start });
  /** `count` qualified referrals for `referrer`, each qualifying at `when`. */
  async function brought(referrer: string, count: number, when = IN_WEEK) {
    for (let i = 0; i < count; i++) {
      const referred = `r${n++}`;
      await db.insert(referrals).values({ referredDiscordId: referred, referrerDiscordId: referrer, referrerDayzId: `dz-${referrer}`, source: "later_bot", createdAt: when });
      await db.insert(referralQualifications).values({ referredDiscordId: referred, referrerDiscordId: referrer, qualifiedAt: when });
    }
  }
  /** WEEK's own row (the prior week's seeded row is always there too). */
  const weekRows = () => db.select().from(referralWeeks).where(eq(referralWeeks.weekStart, WEEK.start));
  const event = async (iso: string) =>
    (await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.connected", occurredAt: at(iso), payload: {} }).returning())[0]!.id;

  it("grants the plate carrier to the top linked referrer, with its DM, once", async () => {
    await link("A"); await link("B");
    await brought("A", 3); await brought("B", 1);
    const out = await closeReferralWeek(db, WEEK, opts);
    expect(out).toEqual({ status: "closed", winners: ["A"], topCount: 3, skipped: [] });
    const grants = await db.select().from(awardGrants);
    expect(grants).toEqual([expect.objectContaining({ awardKey: "plate-carrier", discordId: "A", grantedByDiscordId: "bot" })]);
    expect(await db.select().from(clanNotices)).toEqual([expect.objectContaining({ kind: "award_granted", discordTargetId: "A" })]);
    expect(await db.select().from(referralWeekWinners)).toEqual([expect.objectContaining({ discordId: "A", dayzId: "dz-A", awardGrantId: grants[0]!.id })]);
    expect(await closeReferralWeek(db, WEEK, opts)).toEqual({ status: "already" });
    expect(await db.select().from(awardGrants)).toHaveLength(1);
  });

  it("grants every referrer tied at the top", async () => {
    await link("A"); await link("B");
    await brought("A", 2); await brought("B", 2);
    expect(await closeReferralWeek(db, WEEK, opts)).toMatchObject({ winners: ["A", "B"], topCount: 2 });
    expect(await db.select().from(awardGrants)).toHaveLength(2);
  });

  it("skips an unlinked top referrer and records it for ops", async () => {
    await link("B");
    await brought("X", 5); await brought("B", 1);
    expect(await closeReferralWeek(db, WEEK, opts)).toMatchObject({ winners: ["B"], topCount: 1, skipped: ["X"] });
    expect((await weekRows())[0]!.detail).toEqual({ skipped: ["X"] });
  });

  it("counts a referral qualifying one second before the end, not one at the end", async () => {
    await link("A"); await link("B");
    await brought("A", 1, at("2026-09-28T09:59:59Z"));
    await brought("B", 2, WEEK.end);
    expect(await closeReferralWeek(db, WEEK, opts)).toMatchObject({ winners: ["A"], topCount: 1 });
  });

  it("closes a week with no qualified referrals with no grant", async () => {
    expect(await closeReferralWeek(db, WEEK, opts)).toEqual({ status: "closed", winners: [], topCount: 0, skipped: [] });
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await weekRows()).toEqual([expect.objectContaining({ topCount: 0, announcedAt: null })]);
  });

  it("closes with a failure and no grant when plate-carrier has left the catalogue", async () => {
    await link("A");
    await brought("A", 2);
    awardsOverride.current = {};
    const out = await closeReferralWeek(db, WEEK, opts);
    expect(out).toMatchObject({ status: "closed", winners: [], topCount: 2, skipped: [] });
    expect((out as { failure?: string }).failure).toEqual(expect.any(String));
    expect((await weekRows())[0]!.detail).toMatchObject({ failure: expect.any(String) });
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await db.select().from(referralWeekWinners)).toEqual([]);
  });

  it("rolls back everything when there is no active server, so the next tick retries", async () => {
    await link("A");
    await brought("A", 2);
    await db.update(servers).set({ active: false }).where(eq(servers.id, serverId));
    await expect(closeReferralWeek(db, WEEK, opts)).rejects.toThrow();
    expect(await weekRows()).toEqual([]);
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
    expect(await db.select().from(referralWeekWinners)).toEqual([]);
  });

  // ⚠️ Spec §1: no retroactive payouts. The week that had already ended when the
  // payout was switched on is recorded unpaid; the first paid week is the next.
  it("records the first-ever close unpaid, with no grant, DM, winner or ops note, then pays the next week", async () => {
    await db.delete(referralWeeks);
    await link("A");
    await brought("A", 2);
    expect(await closeReferralWeek(db, WEEK, opts)).toEqual({ status: "skipped-first" });
    expect(await weekRows()).toEqual([expect.objectContaining({
      topCount: 0, announcedAt: null,
      detail: { failure: "payout was not enabled during this week", opsAlerted: true },
    })]);
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
    expect(await db.select().from(referralWeekWinners)).toEqual([]);
    expect(await closeReferralWeek(db, WEEK, opts)).toEqual({ status: "already" });

    const NEXT = { start: WEEK.end, end: at("2026-10-05T10:00:00Z") };
    await brought("A", 1, at("2026-09-30T12:00:00Z"));
    expect(await closeReferralWeek(db, NEXT, { ...opts, now: at("2026-10-05T11:00:00Z") }))
      .toEqual({ status: "closed", winners: ["A"], topCount: 1, skipped: [] });
    expect(await db.select().from(awardGrants)).toHaveLength(1);
  });

  describe("readiness", () => {
    it("waits for the grace period", async () => {
      const last = await event("2026-09-28T09:00:00Z"); await event("2026-09-28T10:05:00Z");
      await writeCursor(db, SESSIONS_CONSUMER, last + 1);
      expect(await referralWeekReady(db, WEEK, at("2026-09-28T10:20:00Z"))).toBe(false);
      expect(await referralWeekReady(db, WEEK, at("2026-09-28T10:30:00Z"))).toBe(true);
    });
    it("waits for ingest to pass the boundary, and for the sessions cursor to catch up", async () => {
      const last = await event("2026-09-28T09:00:00Z");
      expect(await referralWeekReady(db, WEEK, CLOSE_AT)).toBe(false);         // nothing after the end yet
      await event("2026-09-28T10:05:00Z");
      await writeCursor(db, SESSIONS_CONSUMER, last - 1);
      expect(await referralWeekReady(db, WEEK, CLOSE_AT)).toBe(false);         // cursor behind
      await writeCursor(db, SESSIONS_CONSUMER, last);
      expect(await referralWeekReady(db, WEEK, CLOSE_AT)).toBe(true);
    });
  });
});
