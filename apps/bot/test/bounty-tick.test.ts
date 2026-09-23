import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, bounties,
  playerSessions, identityLinks, clanNotices, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { bountyTick } from "../src/bounty-tick.js";

const URL = requireTestDatabaseUrl();
const H = 3_600_000;
const t0 = new Date("2026-09-23T00:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * H);
const T = "T".repeat(40); const K = "K".repeat(40); const M = "M".repeat(40);

describe("bountyTick", () => {
  let db: Database; let serverId = 0; let file = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bounties, kills, player_sessions, clan_notices, identity_links, events, raw_lines, adm_files, servers restart identity cascade`);
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
  const bounty = (budgetH = 3) => db.insert(bounties).values({
    serverId, targetDayzId: T, reason: "r", placedByDiscordId: "9", placedAt: at(0), onlineBudgetMs: budgetH * H, deadlineAt: at(24 * 30),
  });

  it("a scoring kill claims it, freezing killer, event and kill time", async () => {
    await bounty(); await session(0, null); await kill(1);
    expect(await bountyTick(db, { now: at(1.1) })).toEqual({ claimed: 1, expired: 0 });
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
    expect(await bountyTick(db, { now: at(1) })).toEqual({ claimed: 0, expired: 0 });
  });

  it("skips a friendly kill and credits the next real one", async () => {
    await bounty(); await session(0, null);
    await kill(0.5, { killerDayzId: M, friendlyFire: true });
    await kill(0.9);
    await bountyTick(db, { now: at(1) });
    expect((await db.select().from(bounties))[0]).toMatchObject({ status: "claimed", claimedByDayzId: K });
  });

  it("a credited finish claims it", async () => {
    await bounty(); await session(0, null); await kill(1, { cause: "finished" });
    expect((await bountyTick(db, { now: at(1.1) })).claimed).toBe(1);
  });

  it("a kill from before the bounty was placed does not claim it", async () => {
    await kill(-1); await bounty(); await session(0, null);
    expect((await bountyTick(db, { now: at(1) })).claimed).toBe(0);
  });

  it("expires after the online budget plus the settle window, and DMs a linked target", async () => {
    await db.insert(identityLinks).values({ discordId: "1", dayzId: T, gamertag: "Target", verifiedAt: t0 });
    await bounty(3); await session(0, 2); await session(5, 9);
    expect((await bountyTick(db, { now: at(6.2) })).expired).toBe(0);
    expect((await bountyTick(db, { now: at(6.26) })).expired).toBe(1);
    expect((await db.select().from(bounties))[0]).toMatchObject({ status: "expired" });
    expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "bounty_expired", discordTargetId: "1" });
  });

  it("⚠️ a kill made in time but ingested after the budget ran out still claims", async () => {
    await bounty(3); await session(0, null);
    await kill(2.99);
    expect((await bountyTick(db, { now: at(3.3) })).claimed).toBe(1);
  });

  it("never touches a bounty that is no longer open", async () => {
    await db.insert(bounties).values({ serverId, targetDayzId: T, reason: "r", placedByDiscordId: "9", placedAt: at(0), onlineBudgetMs: H, deadlineAt: at(1), status: "revoked", closedAt: at(0.5), revokedByDiscordId: "9" });
    await kill(0.2);
    expect(await bountyTick(db, { now: at(2) })).toEqual({ claimed: 0, expired: 0 });
  });
});
