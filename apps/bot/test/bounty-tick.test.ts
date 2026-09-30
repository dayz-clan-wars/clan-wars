import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, bounties,
  playerSessions, identityLinks, clanNotices, awardGrants, players, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { bountyTick, payBountyAwards } from "../src/bounty-tick.js";

const URL = requireTestDatabaseUrl();
const H = 3_600_000;
const t0 = new Date("2026-09-23T00:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * H);
const SITE = "https://dayzclanwars.com";
const T = "T".repeat(40); const K = "K".repeat(40); const M = "M".repeat(40);

describe("bountyTick", () => {
  let db: Database; let serverId = 0; let file = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bounties, award_grants, players, kills, player_sessions, clan_notices, identity_links, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    file = f!.id; line = 0;
  });

  const eventId = async (h: number) => (await db.insert(events).values({ serverId, admFileId: file, lineIndex: line++, type: "player.killed" as never, occurredAt: at(h), payload: {} }).returning({ id: events.id }))[0]!.id;
  const kill = async (h: number, over: Partial<typeof kills.$inferInsert> = {}) =>
    db.insert(kills).values({ serverId, eventId: await eventId(h), occurredAt: at(h), victimDayzId: T, killerDayzId: K, weapon: "M4-A1", cause: "pvp", ...over });
  const session = async (from: number, to: number | null) =>
    db.insert(playerSessions).values({ serverId, dayzId: T, connectedAt: at(from), connectEventId: await eventId(from), disconnectedAt: to === null ? null : at(to), closeReason: to === null ? null : "disconnect" });
  const bounty = (budgetH = 3, over: Partial<typeof bounties.$inferInsert> = {}) => db.insert(bounties).values({
    serverId, targetDayzId: T, reason: "r", placedByDiscordId: "9", placedAt: at(0), onlineBudgetMs: budgetH * H, deadlineAt: at(24 * 30), ...over,
  });
  const linkKiller = () => db.insert(identityLinks).values({ discordId: "7", dayzId: K, gamertag: "Killer", verifiedAt: t0 });

  it("a scoring kill claims it, freezing killer, event and kill time", async () => {
    await bounty(); await session(0, null); await kill(1);
    expect(await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).toEqual({ claimed: 1, expired: 0, paid: 0 });
    const [b] = await db.select().from(bounties);
    expect(b).toMatchObject({ status: "claimed", claimedByDayzId: K, claimedAt: at(1), closedAt: at(1.1) });
    expect(await db.select().from(clanNotices)).toHaveLength(0);
  });

  it("⚠️ friendly fire, a Hub kill, a self-kill and a killer-less death leave it open", async () => {
    await bounty(); await session(0, null);
    await kill(0.5, { friendlyFire: true });
    await kill(0.6, { atHub: true });
    await kill(0.7, { killerDayzId: T });
    await kill(0.8, { killerDayzId: null, cause: "fall" });
    expect(await bountyTick(db, { now: at(1), siteBaseUrl: SITE })).toEqual({ claimed: 0, expired: 0, paid: 0 });
  });

  it("skips a friendly kill and credits the next real one", async () => {
    await bounty(); await session(0, null);
    await kill(0.5, { killerDayzId: M, friendlyFire: true });
    await kill(0.9);
    await bountyTick(db, { now: at(1), siteBaseUrl: SITE });
    expect((await db.select().from(bounties))[0]).toMatchObject({ status: "claimed", claimedByDayzId: K });
  });

  it("a credited finish claims it", async () => {
    await bounty(); await session(0, null); await kill(1, { cause: "finished" });
    expect((await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).claimed).toBe(1);
  });

  it("a kill from before the bounty was placed does not claim it", async () => {
    await kill(-1); await bounty(); await session(0, null);
    expect((await bountyTick(db, { now: at(1), siteBaseUrl: SITE })).claimed).toBe(0);
  });

  it("expires after the online budget plus the settle window, and DMs a linked target", async () => {
    await db.insert(identityLinks).values({ discordId: "1", dayzId: T, gamertag: "Target", verifiedAt: t0 });
    await bounty(3); await session(0, 2); await session(5, 9);
    expect((await bountyTick(db, { now: at(6.2), siteBaseUrl: SITE })).expired).toBe(0);
    expect((await bountyTick(db, { now: at(6.26), siteBaseUrl: SITE })).expired).toBe(1);
    expect((await db.select().from(bounties))[0]).toMatchObject({ status: "expired" });
    expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "bounty_expired", discordTargetId: "1" });
  });

  it("⚠️ a kill made in time but ingested after the budget ran out still claims", async () => {
    await bounty(3); await session(0, null);
    await kill(2.99);
    expect((await bountyTick(db, { now: at(3.3), siteBaseUrl: SITE })).claimed).toBe(1);
  });

  it("never touches a bounty that is no longer open", async () => {
    await db.insert(bounties).values({ serverId, targetDayzId: T, reason: "r", placedByDiscordId: "9", placedAt: at(0), onlineBudgetMs: H, deadlineAt: at(1), status: "revoked", closedAt: at(0.5), revokedByDiscordId: "9" });
    await kill(0.2);
    expect(await bountyTick(db, { now: at(2), siteBaseUrl: SITE })).toEqual({ claimed: 0, expired: 0, paid: 0 });
  });

  describe("a prize", () => {
    const prize = { awardKey: "dead-rooster", awardDays: 3 };

    it("is granted to a linked killer in the same tick as the kill, for the days set at placement", async () => {
      await db.insert(players).values({ dayzId: T, gamertag: "Wanted", firstSeenAt: t0, lastSeenAt: t0 });
      await linkKiller(); await bounty(3, prize); await session(0, null); await kill(1);
      expect(await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).toEqual({ claimed: 1, expired: 0, paid: 1 });
      const [g] = await db.select().from(awardGrants);
      expect(g).toMatchObject({ awardKey: "dead-rooster", discordId: "7", grantedByDiscordId: "9", durationDays: 3, reason: "Collected the bounty on Wanted" });
      expect((await db.select().from(bounties))[0]!.awardGrantId).toBe(g!.id);
      expect((await db.select().from(clanNotices)).map((n) => n.kind)).toEqual(["award_granted"]);
    });

    it("⚠️ is held for an unlinked killer, then granted once that character links", async () => {
      await bounty(3, prize); await session(0, null); await kill(1);
      expect(await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).toEqual({ claimed: 1, expired: 0, paid: 0 });
      expect(await db.select().from(awardGrants)).toEqual([]);
      expect((await db.select().from(bounties))[0]).toMatchObject({ status: "claimed", awardGrantId: null });
      await linkKiller();
      expect((await bountyTick(db, { now: at(50), siteBaseUrl: SITE })).paid).toBe(1);
      expect(await db.select().from(awardGrants)).toEqual([expect.objectContaining({ discordId: "7", durationDays: 3 })]);
    });

    it("⚠️ is paid exactly once, however many passes run", async () => {
      await linkKiller(); await bounty(3, prize); await session(0, null); await kill(1);
      await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE });
      await Promise.all([payBountyAwards(db, { now: at(2), siteBaseUrl: SITE }), payBountyAwards(db, { now: at(2), siteBaseUrl: SITE })]);
      await bountyTick(db, { now: at(3), siteBaseUrl: SITE });
      expect(await db.select().from(awardGrants)).toHaveLength(1);
    });

    it("pays nothing for an expired or revoked bounty, even to a linked target's killer", async () => {
      await linkKiller(); await bounty(3, prize); await session(0, 9);
      await bountyTick(db, { now: at(9), siteBaseUrl: SITE });
      expect((await db.select().from(bounties))[0]!.status).toBe("expired");
      expect(await db.select().from(awardGrants)).toEqual([]);
    });

    it("⚠️ a prize the catalogue lost is recorded as a failure once, never retried or thrown", async () => {
      await linkKiller(); await bounty(3, { awardKey: "golden-shovel", awardDays: 3 }); await session(0, null); await kill(1);
      expect((await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).paid).toBe(0);
      expect((await db.select().from(bounties))[0]!.awardFailure).toMatch(/golden-shovel/u);
      expect(await db.select().from(awardGrants)).toEqual([]);
      expect((await bountyTick(db, { now: at(2), siteBaseUrl: SITE })).paid).toBe(0);
    });

    it("⚠️ one prize that fails to grant does not stop the next one being paid", async () => {
      await linkKiller();
      // 91 days is past AWARD_MAX_DAYS: grantAwardTx refuses it every time.
      await bounty(3, { awardKey: "dead-rooster", awardDays: 91 }); await session(0, null); await kill(1);
      await db.insert(bounties).values({
        serverId, targetDayzId: M, reason: "r", placedByDiscordId: "9", placedAt: at(0), onlineBudgetMs: 3 * H, deadlineAt: at(24 * 30),
        ...prize, status: "claimed", closedAt: at(1), claimedByDayzId: K, claimEventId: 999, claimedAt: at(1),
      });
      expect((await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).paid).toBe(1);
      const rows = await db.select().from(bounties).orderBy(bounties.id);
      expect(rows[0]!.awardGrantId).toBeNull();
      expect(rows[1]!.awardGrantId).not.toBeNull();
    });

    it("a bounty with no prize pays nothing", async () => {
      await linkKiller(); await bounty(); await session(0, null); await kill(1);
      expect((await bountyTick(db, { now: at(1.1), siteBaseUrl: SITE })).paid).toBe(0);
      expect(await db.select().from(awardGrants)).toEqual([]);
    });
  });
});
