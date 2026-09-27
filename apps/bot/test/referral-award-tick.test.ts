// apps/bot/test/referral-award-tick.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, admFiles, events, identityLinks, players, playerSessions, referrals, referralWeeks, awardGrants, type Database,
} from "@factions/db";
import { writeCursor } from "@factions/event-log";
import { SESSIONS_CONSUMER } from "../src/sessions-tick.js";
import { referralAwardTick } from "../src/referral-award-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("referralAwardTick", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  let announced: string[]; let ops: string[]; let failAnnounce: boolean;
  const posters = {
    announce: async (c: string) => { if (failAnnounce) throw new Error("discord down"); announced.push(c); },
    ops: async (c: string) => { ops.push(c); },
  };
  const tick = (now: string, payout = true) => referralAwardTick(db, posters, { now: at(now), siteBaseUrl: "https://site.test", grantedByDiscordId: "bot", payout });

  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table referral_week_winners, referral_weeks, award_grants, clan_notices, player_sessions, events, adm_files, identity_links, players, consumer_cursors, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0; announced = []; ops = []; failAnnounce = false;
    for (const [d, g] of [["A", "Otto"], ["N", "Newbie"]] as const) {
      await db.insert(players).values({ dayzId: `dz-${d}`, gamertag: g, firstSeenAt: at("2026-09-01T00:00:00Z"), lastSeenAt: at("2026-09-01T00:00:00Z") });
      await db.insert(identityLinks).values({ discordId: d, dayzId: `dz-${d}`, gamertag: g, verifiedAt: at("2026-09-01T00:00:00Z") });
    }
    await db.insert(referrals).values({ referredDiscordId: "N", referrerDiscordId: "A", referrerDayzId: "dz-A", source: "link_bot", createdAt: at("2026-09-22T12:00:00Z") });
  });

  async function event(iso: string) {
    return (await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.connected", occurredAt: at(iso), payload: {} }).returning())[0]!.id;
  }
  /** A 3h session for the referred player in the week of 2026-09-21, and ingest caught up past the boundary. */
  async function playedAndIngested() {
    const e = await event("2026-09-23T18:00:00Z");
    await db.insert(playerSessions).values({ serverId, dayzId: "dz-N", connectedAt: at("2026-09-23T18:00:00Z"), connectEventId: e, disconnectedAt: at("2026-09-23T21:00:00Z"), closeReason: "disconnect" });
    const last = await event("2026-09-28T09:50:00Z");
    await event("2026-09-28T10:10:00Z");
    await writeCursor(db, SESSIONS_CONSUMER, last);
  }

  it("qualifies even with the payout off, and pays nothing", async () => {
    await playedAndIngested();
    expect(await tick("2026-09-28T11:00:00Z", false)).toEqual({ qualified: 1, closed: 0, posted: 0 });
    expect(await db.select().from(referralWeeks)).toEqual([]);
  });

  it("closes the ended week, grants, and announces once", async () => {
    await playedAndIngested();
    expect(await tick("2026-09-28T11:00:00Z")).toEqual({ qualified: 1, closed: 1, posted: 1 });
    expect(announced).toEqual(["Top referrer this week: **Otto**, who brought in 1 new player. They get a plate carrier for a week."]);
    expect(await tick("2026-09-28T11:05:00Z")).toEqual({ qualified: 0, closed: 0, posted: 0 });
    expect(announced).toHaveLength(1);
    expect(await db.select().from(awardGrants)).toHaveLength(1);
  });

  it("retries a failed announcement on the next tick", async () => {
    await playedAndIngested();
    failAnnounce = true;
    expect((await tick("2026-09-28T11:00:00Z")).posted).toBe(0);
    failAnnounce = false;
    expect((await tick("2026-09-28T11:05:00Z")).posted).toBe(1);
    expect(announced).toHaveLength(1);
  });

  it("does not close before ingest has caught up", async () => {
    const e = await event("2026-09-23T18:00:00Z");
    await db.insert(playerSessions).values({ serverId, dayzId: "dz-N", connectedAt: at("2026-09-23T18:00:00Z"), connectEventId: e, disconnectedAt: at("2026-09-23T21:00:00Z"), closeReason: "disconnect" });
    expect((await tick("2026-09-28T11:00:00Z")).closed).toBe(0);
  });

  it("never pays a backlog: after two weeks down, only the latest week closes", async () => {
    await playedAndIngested();                              // qualifies in the week of 09-21
    await event("2026-10-05T10:10:00Z");
    await writeCursor(db, SESSIONS_CONSUMER, 1_000_000);
    expect((await tick("2026-10-05T11:00:00Z")).closed).toBe(1);
    expect((await db.select().from(referralWeeks)).map((w) => w.weekStart)).toEqual([at("2026-09-28T10:00:00Z")]);
    expect(await db.select().from(awardGrants)).toEqual([]);
  });

  it("posts one ops note for a skipped referrer", async () => {
    await db.delete(identityLinks).where(sql`discord_id = 'A'`);
    await playedAndIngested();
    await tick("2026-09-28T11:00:00Z");
    await tick("2026-09-28T11:05:00Z");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toContain("A");
    expect(announced).toEqual([]);
  });
});
