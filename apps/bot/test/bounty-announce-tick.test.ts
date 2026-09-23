import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, bounties, players, type Database } from "@factions/db";
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
    await db.execute(sql`truncate table bounties, players, servers restart identity cascade`);
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

  it("posts nothing twice", async () => {
    await db.insert(bounties).values({ ...base(), serverId });
    const sent: string[] = [];
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    await bountyAnnounceTick(db, async (c) => { sent.push(c); }, { now, siteBaseUrl: "https://x" });
    expect(sent).toHaveLength(1);
  });
});
