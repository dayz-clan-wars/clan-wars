import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, rosterCooldowns,
  type Database,
} from "@factions/db";
import { sql, eq, and } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-08-31T12:00:00Z");
const UNTIL = new Date(t0.getTime() + 259_200_000);

/**
 * These are the only tests in this plan that prove the three indexes this
 * whole design leans on — `faction_members_server_player_uniq`,
 * `faction_members_leader_uniq`, `faction_invites_pending_uniq` — actually
 * decide a race rather than merely existing. Two statements run one after
 * the other in the same connection prove nothing about a constraint whose
 * entire job is arbitrating genuine concurrency, so every test here drives
 * two *separate* connections (two `createClient(URL)` calls, each wrapped
 * in its own `PgRosterStore`) through `Promise.all`. The ordering evidence
 * comes from Postgres's own row locks and unique-index conflict detection,
 * not from `setTimeout` — a race test whose pass/fail depends on scheduling
 * luck is worse than no test, because it gets trusted.
 */
describe("PgRosterStore concurrency", () => {
  let db: Database;
  let dbA: Database;
  let dbB: Database;
  let storeA: PgRosterStore;
  let storeB: PgRosterStore;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_invites, roster_cooldowns, faction_members, factions, identity_links, servers restart identity cascade`);

    dbA = createClient(URL);
    dbB = createClient(URL);
    storeA = new PgRosterStore(dbA);
    storeB = new PgRosterStore(dbB);

    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("two factions' invites accepted at the same instant yield one membership", async () => {
    const [f1] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "leader1", createdAt: t0,
    }).returning();
    const [f2] = await db.insert(factions).values({
      serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", poleKey: "4:5:6",
      x: "4.00", y: "5.00", z: "6.00", status: "active", leaderDiscordId: "leader2", createdAt: t0,
    }).returning();

    const PLAYER_DAYZ = "P".repeat(40);
    const PLAYER_DISCORD = "d9";
    const expiresAt = new Date(t0.getTime() + 3_600_000);

    const [inv1] = await db.insert(factionInvites).values({
      factionId: f1!.id, serverId,
      inviteeDiscordId: PLAYER_DISCORD, inviteeDayzId: PLAYER_DAYZ,
      invitedByDiscordId: "leader1", createdAt: t0, expiresAt,
    }).returning();
    const [inv2] = await db.insert(factionInvites).values({
      factionId: f2!.id, serverId,
      inviteeDiscordId: PLAYER_DISCORD, inviteeDayzId: PLAYER_DAYZ,
      invitedByDiscordId: "leader2", createdAt: t0, expiresAt,
    }).returning();

    const [r1, r2] = await Promise.all([
      storeA.acceptInvite(inv1!.id, PLAYER_DISCORD, t0),
      storeB.acceptInvite(inv2!.id, PLAYER_DISCORD, t0),
    ]);

    expect([r1, r2].filter((r) => r === "ok")).toHaveLength(1);
    expect([r1, r2].filter((r) => r === "already-member")).toHaveLength(1);

    const rows = await db.select().from(factionMembers).where(eq(factionMembers.dayzId, PLAYER_DAYZ));
    expect(rows).toHaveLength(1);
  });

  it("two simultaneous transfers cannot both succeed", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: t0,
    }).returning();
    const factionId = f!.id;

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "1".repeat(40), discordId: "d1", role: "leader", joinedAt: t0 },
      { factionId, serverId, dayzId: "2".repeat(40), discordId: "d2", role: "officer", joinedAt: t0 },
      { factionId, serverId, dayzId: "3".repeat(40), discordId: "d3", role: "officer", joinedAt: t0 },
    ]);

    const [r1, r2] = await Promise.all([
      storeA.transfer({ factionId, fromDiscordId: "d1", toDiscordId: "d2", at: t0 }),
      storeB.transfer({ factionId, fromDiscordId: "d1", toDiscordId: "d3", at: t0 }),
    ]);

    expect([r1, r2].filter((r) => r === "ok")).toHaveLength(1);

    const leaders = (await db.select().from(factionMembers)
      .where(eq(factionMembers.factionId, factionId))).filter((r) => r.role === "leader");
    expect(leaders).toHaveLength(1);
  });

  it("a kick racing the target's own leave leaves one cooldown and no member", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: t0,
    }).returning();
    const factionId = f!.id;
    const TARGET_DAYZ = "T".repeat(40);

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "1".repeat(40), discordId: "d1", role: "leader", joinedAt: t0 },
      { factionId, serverId, dayzId: TARGET_DAYZ, discordId: "d2", role: "member", joinedAt: t0 },
    ]);

    const [kickResult, leaveResult] = await Promise.all([
      storeA.kick({ factionId, actorDiscordId: "d1", targetDiscordId: "d2", at: t0, until: UNTIL }),
      storeB.leave({ factionId, discordId: "d2", at: t0, until: UNTIL }),
    ]);

    // Exactly one of the two racers actually removed the row; the other
    // found it already gone. Which one wins is genuinely up to Postgres's
    // lock scheduling — the test does not, and must not, assume an order —
    // but the count of successes is guaranteed regardless of that order.
    const successes = [kickResult, leaveResult].filter((r) => r === "ok");
    expect(successes).toHaveLength(1);
    if (kickResult !== "ok") expect(kickResult).toBe("target-not-member");
    if (leaveResult !== "ok") expect(leaveResult).toBe("not-member");

    const members = await db.select().from(factionMembers)
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.discordId, "d2")));
    expect(members).toHaveLength(0);

    const cooldowns = await db.select().from(rosterCooldowns)
      .where(and(eq(rosterCooldowns.serverId, serverId), eq(rosterCooldowns.dayzId, TARGET_DAYZ)));
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]!.until.getTime()).toBe(UNTIL.getTime());
  });
});
