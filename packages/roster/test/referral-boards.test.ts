import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, seasons, players, identityLinks, factionMembers, referrals, referralQualifications, type Database,
} from "@factions/db";
import { playerBoardsDb, boardPageDb, clanBoardDb, BOARD_KINDS } from "../src/stats";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const now = at("2026-09-30T12:00:00Z");               // week of Mon 2026-09-28 10:00
const THIS_WEEK = at("2026-09-29T12:00:00Z");
const LAST_WEEK = at("2026-09-22T12:00:00Z");
const ALL = { kind: "all" } as const;

describe("referral boards", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table faction_members, declarations, poles, factions, identity_links, players, events, adm_files, seasons, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
  });

  const link = async (discordId: string, dayzId: string, gamertag: string) => {
    await db.insert(players).values({ dayzId, gamertag, firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId, dayzId, gamertag, verifiedAt: now });
  };
  /** A qualified referral of `referred` by `referrer`, qualifying at `when`. */
  const qualified = async (referred: string, referrer: string, when: Date, snapDayzId = `dz-${referrer}`) => {
    await db.insert(referrals).values({ referredDiscordId: referred, referrerDiscordId: referrer, referrerDayzId: snapDayzId, source: "later_bot", createdAt: when });
    await db.insert(referralQualifications).values({ referredDiscordId: referred, referrerDiscordId: referrer, qualifiedAt: when });
  };

  it("adds both kinds to BOARD_KINDS, last", () => {
    expect(BOARD_KINDS.slice(-2)).toEqual(["referrers", "referrersWeek"]);
  });

  it("counts only qualified referrals, all-time and this week", async () => {
    await link("B", "dz-B", "Otto"); await link("C", "dz-C", "Cleo");
    await qualified("r1", "B", THIS_WEEK); await qualified("r2", "B", LAST_WEEK); await qualified("r3", "C", THIS_WEEK);
    // Recorded but not qualified: counts nowhere.
    await db.insert(referrals).values({ referredDiscordId: "r4", referrerDiscordId: "C", referrerDayzId: "dz-C", source: "later_bot", createdAt: THIS_WEEK });
    const b = await playerBoardsDb(db, ALL, 10, now);
    expect(b.referrers.map((r) => [r.gamertag, r.value])).toEqual([["Otto", 2], ["Cleo", 1]]);
    expect(b.referrersWeek.map((r) => [r.gamertag, r.value])).toEqual([["Cleo", 1], ["Otto", 1]]);
  });

  it("orders a tie by who reached the count first", async () => {
    await link("B", "dz-B", "Otto"); await link("C", "dz-C", "Cleo");
    await qualified("r1", "B", at("2026-09-29T01:00:00Z")); await qualified("r2", "C", at("2026-09-29T02:00:00Z"));
    expect((await playerBoardsDb(db, ALL, 10, now)).referrersWeek.map((r) => r.gamertag)).toEqual(["Otto", "Cleo"]);
  });

  it("referrers follows the season scope; referrersWeek ignores it", async () => {
    await link("B", "dz-B", "Otto");
    await db.insert(seasons).values({ serverId, number: 1, startedAt: at("2026-09-01T00:00:00Z"), endedAt: at("2026-09-25T00:00:00Z") });
    await qualified("r1", "B", LAST_WEEK); await qualified("r2", "B", THIS_WEEK);
    const s1 = await playerBoardsDb(db, { kind: "season", number: 1 }, 10, now);
    expect(s1.referrers.map((r) => r.value)).toEqual([1]);
    expect(s1.referrersWeek.map((r) => r.value)).toEqual([1]);
  });

  it("shows an unlinked referrer by the character the referral snapshotted", async () => {
    await db.insert(players).values({ dayzId: "dz-gone", gamertag: "Ghost", firstSeenAt: now, lastSeenAt: now });
    await qualified("r1", "gone", THIS_WEEK, "dz-gone");
    expect((await playerBoardsDb(db, ALL, 10, now)).referrers).toEqual([{ dayzId: "dz-gone", gamertag: "Ghost", value: 1 }]);
  });

  it("pages like any board", async () => {
    await link("B", "dz-B", "Otto"); await link("C", "dz-C", "Cleo");
    await qualified("r1", "B", THIS_WEEK); await qualified("r2", "C", THIS_WEEK);
    const p = await boardPageDb(db, "referrersWeek", ALL, 1, now, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.hasNext).toBe(true);
  });

  it("the clan board narrows by the referrer's character", async () => {
    const memberDayzId = "dz-L";
    await link("L", memberDayzId, "Leo");
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", leaderDiscordId: "L", createdAt: now, activatedAt: now });
    await db.insert(factionMembers).values({ factionId: f.id, serverId, dayzId: memberDayzId, discordId: "L", role: "leader", joinedAt: now, status: "full" });
    await link("C", "dz-C", "Cleo");
    await qualified("r1", "L", THIS_WEEK, memberDayzId); await qualified("r2", "C", THIS_WEEK);
    const b = await clanBoardDb(db, "L", ALL, 10, now);
    if (typeof b === "string") throw new Error(b);
    expect(b.referrers.map((r) => r.dayzId)).toEqual([memberDayzId]);
  });
});
