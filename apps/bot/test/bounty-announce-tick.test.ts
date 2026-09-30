import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, bounties, players, identityLinks, awardGrants, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { bountyAnnounceTick } from "../src/bounty-announce-tick.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-23T12:00:00Z");
const T = "T".repeat(40); const K = "K".repeat(40);

describe("bountyAnnounceTick", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bounties, award_grants, players, identity_links, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(players).values([
      { dayzId: T, gamertag: "Bob", firstSeenAt: now, lastSeenAt: now },
      { dayzId: K, gamertag: "Ann", firstSeenAt: now, lastSeenAt: now },
    ]);
  });
  const base = () => ({ serverId, targetDayzId: T, reason: "r", placedByDiscordId: "9", placedAt: now, onlineBudgetMs: 3_600_000, deadlineAt: now });

  it("posts the wanted post, then the claim, stamping each only after it sends", async () => {
    await db.insert(bounties).values({ ...base(), serverId, status: "claimed", closedAt: now, claimedByDayzId: K, claimEventId: 1, claimedAt: now });
    const sent: string[] = [];
    const r = await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    expect(r).toEqual({ posted: 2, blockedAt: null });
    expect(sent[0]).toMatch(/WANTED/u); expect(sent[1]).toMatch(/Ann.*collected.*Bob/u);
    const [b] = await db.select().from(bounties);
    expect(b!.placedAnnouncedAt).toEqual(now); expect(b!.closedAnnouncedAt).toEqual(now);
  });

  it("⚠️ stamps nothing and stops at the first failure", async () => {
    await db.insert(bounties).values([{ ...base(), serverId }, { ...base(), serverId, targetDayzId: K }]);
    let calls = 0;
    const r = await bountyAnnounceTick(db, async () => { calls++; throw new Error("discord down"); }, { now, siteBaseUrl: "https://x" });
    expect(calls).toBe(1); expect(r.posted).toBe(0); expect(r.blockedAt).not.toBeNull();
    expect((await db.select().from(bounties)).every((b) => b.placedAnnouncedAt === null)).toBe(true);
  });

  it("⚠️ a closed bounty whose WANTED post fails never gets its close post attempted", async () => {
    await db.insert(bounties).values({ ...base(), serverId, status: "claimed", closedAt: now, claimedByDayzId: K, claimEventId: 1, claimedAt: now });
    let calls = 0;
    const r = await bountyAnnounceTick(db, async () => { calls++; throw new Error("discord down"); }, { now, siteBaseUrl: "https://x" });
    expect(calls).toBe(1); expect(r.posted).toBe(0); expect(r.blockedAt).not.toBeNull();
    const [b] = await db.select().from(bounties);
    expect(b!.placedAnnouncedAt).toBeNull(); expect(b!.closedAnnouncedAt).toBeNull();
  });

  it("names the prize, and tells an unlinked killer it is waiting for them", async () => {
    await db.insert(bounties).values({ ...base(), serverId, awardKey: "dead-rooster", awardDays: 14, status: "claimed", closedAt: now, claimedByDayzId: K, claimEventId: 1, claimedAt: now });
    const sent: string[] = [];
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    expect(sent[0]).toContain("Reward: **Dead Rooster**");
    expect(sent[1]).toContain("Their **Dead Rooster** is waiting for them. Link your character at https://x/link");
  });

  it("⚠️ says a linked killer won only once the grant exists, and 'on its way' before", async () => {
    await db.insert(identityLinks).values({ discordId: "7", dayzId: K, gamertag: "Ann", verifiedAt: now });
    await db.insert(bounties).values({ ...base(), serverId, awardKey: "dead-rooster", awardDays: 14, status: "claimed", closedAt: now, claimedByDayzId: K, claimEventId: 1, claimedAt: now });
    const sent: string[] = [];
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    expect(sent[1]).toMatch(/Their \*\*Dead Rooster\*\* is on its way\./u);

    const [g] = await db.insert(awardGrants).values({
      awardKey: "dead-rooster", discordId: "7", grantedByDiscordId: "9", reason: "r", durationDays: 14, grantedAt: now, placeBy: now,
    }).returning();
    await db.insert(bounties).values({ ...base(), serverId, targetDayzId: "U".repeat(40), awardKey: "dead-rooster", awardDays: 14, awardGrantId: g!.id, status: "claimed", closedAt: now, claimedByDayzId: K, claimEventId: 2, claimedAt: now });
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    expect(sent.at(-1)).toMatch(/They win \*\*Dead Rooster\*\*\./u);
  });

  it("posts nothing twice", async () => {
    await db.insert(bounties).values({ ...base(), serverId });
    const sent: string[] = [];
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    expect(sent).toHaveLength(1);
  });
});
