import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, alphaWeeks, raidAwardWeeks, awardGrants, factions, type Database,
} from "@factions/db";
import { payRaidAwards } from "../src/raid-award.js";
import { raidAwardText } from "../src/raid-award-text.js";
import { seedFaction, seedSeason } from "./seed.js";

const awardsOverride = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@factions/domain/awards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@factions/domain/awards")>();
  return { ...actual, awardsCatalogue: () => awardsOverride.current ?? actual.awardsCatalogue() };
});

/** Forces `grantAwardTx` to refuse: its only refusals are validation ones the payout cannot reach on its own. */
const refuseGrants = vi.hoisted(() => ({ on: false }));
vi.mock("@factions/roster/internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@factions/roster/internal")>();
  return {
    ...actual,
    grantAwardTx: ((...args: Parameters<typeof actual.grantAwardTx>) =>
      refuseGrants.on ? Promise.resolve({ ok: false, reason: "bad-duration" }) : actual.grantAwardTx(...args)) as typeof actual.grantAwardTx,
  };
});

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const WEEK = at("2026-11-02T00:00:00Z");
const OLD_WEEK = at("2026-10-26T00:00:00Z");
const NOW = at("2026-11-08T14:01:00Z");

describe("payRaidAwards", () => {
  let db: Database; let seasonId = 0; let factionId = 0; let serverId = 0;
  const posts: string[] = [];
  const post = async (t: string) => { posts.push(t); };
  const run = () => payRaidAwards(db, { now: NOW, siteBaseUrl: "https://site.test", grantedByDiscordId: "bot", post });

  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table raid_award_weeks, award_grants, clan_notices, alpha_weeks, season_standings, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    posts.length = 0;
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const start = at("2026-09-02T12:00:00Z");
    seasonId = (await seedSeason(db, serverId, start)).id;
    const f = await seedFaction(db, { serverId, name: "Wolves *of* War", tag: "WOLF", texture: "Flag_Wolf", poleKey: "2000.00:100.00:2000.00", createdAt: start, activatedAt: start, leaderDiscordId: "leader-1" });
    factionId = f.id;
  });
  afterEach(() => { awardsOverride.current = null; refuseGrants.on = false; });

  const rank1 = (weekStart: Date, points = 42) => db.insert(alphaWeeks).values({ seasonId, weekStart, rank: 1, factionId, points });

  it("grants the weapon kit for 7 days to the leader, records the week, and posts once", async () => {
    await rank1(WEEK);
    expect(await run()).toEqual({ paid: 1 });
    const [row] = await db.select().from(raidAwardWeeks);
    expect(row).toMatchObject({ seasonId, factionId, leaderDiscordId: "leader-1" });
    expect(row!.awardGrantId).not.toBeNull();
    const [g] = await db.select().from(awardGrants).where(eq(awardGrants.id, row!.awardGrantId!));
    expect(g).toMatchObject({ awardKey: "weapon-kit", discordId: "leader-1", durationDays: 7, grantedByDiscordId: "bot", reason: "Top raiding clan, week of 2026-11-02" });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toBe(raidAwardText("Wolves *of* War", 42));
    expect(posts[0]).toContain("Wolves \\*of\\* War");
    expect(await run()).toEqual({ paid: 0 });
    expect(posts).toHaveLength(1);
    expect(await db.select().from(awardGrants)).toHaveLength(1);
  });

  it("never pays a week before the first paid week", async () => {
    await rank1(OLD_WEEK);
    expect(await run()).toEqual({ paid: 0 });
    expect(await db.select().from(raidAwardWeeks)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("records a disbanded winner with a failure, no grant, no throw, no post", async () => {
    await rank1(WEEK);
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, factionId));
    expect(await run()).toEqual({ paid: 0 });
    const [row] = await db.select().from(raidAwardWeeks);
    expect(row!.awardGrantId).toBeNull();
    expect((row!.detail as { failure?: string }).failure).toMatch(/disbanded/u);
    expect(await db.select().from(awardGrants)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("records a prize missing from the catalogue with a failure and does not throw", async () => {
    awardsOverride.current = {};
    await rank1(WEEK);
    expect(await run()).toEqual({ paid: 0 });
    const [row] = await db.select().from(raidAwardWeeks);
    expect(row!.awardGrantId).toBeNull();
    expect((row!.detail as { failure?: string }).failure).toMatch(/awards\.json/u);
  });

  it("throws on a refused grant and rolls the ledger row back", async () => {
    await rank1(WEEK);
    refuseGrants.on = true;
    await expect(run()).rejects.toThrow(/grant refused/u);
    expect(await db.select().from(raidAwardWeeks)).toHaveLength(0);
    expect(await db.select().from(awardGrants)).toHaveLength(0);
    expect(posts).toHaveLength(0);
    // The next tick retries once the refusal clears.
    refuseGrants.on = false;
    expect(await run()).toEqual({ paid: 1 });
  });
});
