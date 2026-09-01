import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, identityLinks, rosterCooldowns,
  type Database,
} from "@factions/db";
import { sql, eq, and } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";

/**
 * How many backends are parked on a heavyweight lock right now. This is
 * Postgres's own view of who is waiting for whom — the same evidence the
 * other tests in this file get from a unique-index conflict, just observable
 * while the racers are still mid-flight. Ordering is derived from it; no test
 * here waits out a duration.
 */
async function blockedBackends(db: Database): Promise<number> {
  const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`);
  return Number((rows as unknown as { n: number }[])[0]!.n);
}

/**
 * Open a transaction on its own connection that holds `take` (a lock-taking
 * statement) until `body` finishes, then always releases it and closes the
 * connection.
 *
 * ⚠️ The release must happen on EVERY path. If `until` below throws while the
 * gap is open, an un-released holder leaves its lock in place and wedges the
 * next `beforeEach` TRUNCATE — one broken test would then look like a broken
 * file. Hence the `finally`.
 */
async function holdingLock(take: ReturnType<typeof sql>, body: () => Promise<void>): Promise<void> {
  const dbC = createClient(URL);
  let opened!: () => void;
  let close!: () => void;
  const isOpen = new Promise<void>((r) => { opened = r; });
  const closed = new Promise<void>((r) => { close = r; });
  const holder = dbC.transaction(async (tx) => {
    await tx.execute(take);
    opened();
    await closed;
  });
  try {
    await isOpen;
    await body();
  } finally {
    close();
    await holder.catch(() => {});
    await dbC.$client.end();
  }
}

/** Spin until a condition over real database state holds. Never a fixed delay. */
async function until(what: string, pred: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (await pred()) return;
  }
  throw new Error(`never observed: ${what}`);
}


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
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_invites, roster_cooldowns, faction_members, factions, identity_links, servers restart identity cascade`);
    });

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

    // `acceptInvite` rosters the accepter's current linked UID.
    await db.insert(identityLinks).values({
      discordId: PLAYER_DISCORD, dayzId: PLAYER_DAYZ, gamertag: "Nine", verifiedAt: t0,
    });

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
  /**
   * §8's fourth race: two renames inside the cooldown window. The second
   * UPDATE blocks on the row lock the first holds, then re-evaluates its own
   * WHERE against the committed row — where `renamed_at` is now the first
   * writer's instant, which no longer satisfies the cooldown floor. Exactly
   * one wins, and the stored name is that one's; there is no interleaving
   * where both land or where the loser's name is what sticks.
   */
  it("two renames inside the cooldown: one wins and its name is the stored one", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: t0,
    }).returning();
    const factionId = f!.id;
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "1".repeat(40), discordId: "d1", role: "leader", joinedAt: t0,
    });

    const RENAME_COOLDOWN_MS = 604_800_000;
    const notBefore = new Date(t0.getTime() - RENAME_COOLDOWN_MS);

    const [r1, r2] = await Promise.all([
      storeA.rename({ factionId, discordId: "d1", name: "Cubs", at: t0, notBefore }),
      storeB.rename({ factionId, discordId: "d1", name: "Wolves", at: t0, notBefore }),
    ]);

    expect([r1, r2].filter((r) => r === "ok")).toHaveLength(1);
    expect([r1, r2].filter((r) => r === "cooldown")).toHaveLength(1);

    const [after] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(after!.name).toBe(r1 === "ok" ? "Cubs" : "Wolves");
    expect(after!.renamedAt!.getTime()).toBe(t0.getTime());
  });

  /**
   * §4.1: a membership row must never outlive its faction's hold.
   * `faction_members_server_player_uniq` carries no status predicate, so a
   * stranded row bars that player from EVERY future faction on the server
   * with no command able to clear it — `/faction leave`, `createInvite` and
   * `acceptInvite` all refuse it. Manual SQL is the only escape.
   *
   * The interleaving that produces one is narrow, so it is staged here rather
   * than hoped for: a third connection holds ACCESS EXCLUSIVE on
   * `roster_cooldowns`, which is the table `acceptInvite` reads between its
   * faction-status check and its membership INSERT. That parks the accept in
   * exactly the gap the defect needs, using a real lock — the ordering below
   * is read back out of `pg_stat_activity`, never timed.
   *
   * Unfixed (an unlocked status SELECT), the disband commits inside that gap
   * and its roster DELETE cannot see the row the accept has not inserted yet;
   * the accept then inserts into a disbanded faction. Fixed, the accept's
   * `FOR SHARE` on the faction row makes the disband's `UPDATE factions` wait
   * for it, so the DELETE always runs after the INSERT.
   */
  it("an accept racing a disband cannot strand a membership row", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: t0,
    }).returning();
    const factionId = f!.id;

    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "1".repeat(40), discordId: "d1", role: "leader", joinedAt: t0,
    });

    const PLAYER_DAYZ = "P".repeat(40);
    const PLAYER_DISCORD = "d9";
    await db.insert(identityLinks).values({
      discordId: PLAYER_DISCORD, dayzId: PLAYER_DAYZ, gamertag: "Nine", verifiedAt: t0,
    });
    const [inv] = await db.insert(factionInvites).values({
      factionId, serverId,
      inviteeDiscordId: PLAYER_DISCORD, inviteeDayzId: PLAYER_DAYZ,
      invitedByDiscordId: "d1", createdAt: t0, expiresAt: new Date(t0.getTime() + 3_600_000),
    }).returning();

    let accepting!: Promise<string>;
    let disbanding!: Promise<string>;
    await holdingLock(sql`lock table roster_cooldowns in access exclusive mode`, async () => {
      accepting = storeA.acceptInvite(inv!.id, PLAYER_DISCORD, t0);
      await until("the accept parked on roster_cooldowns", async () => await blockedBackends(db) >= 1);

      // The disband either runs straight through (nothing holds it back when
      // the accept's status read took no lock) or parks on the faction row
      // the accept is holding FOR SHARE. Both are settled states to wait for.
      disbanding = storeB.disband(factionId, "d1");
      let disbandSettled = false;
      void disbanding.then(() => { disbandSettled = true; }, () => { disbandSettled = true; });
      await until("the disband settled or parked", async () =>
        disbandSettled || await blockedBackends(db) >= 2);
    });

    const [acceptOutcome, disbandOutcome] = await Promise.all([accepting, disbanding]);
    expect(disbandOutcome).toBe("ok");
    expect(["ok", "not-holding"]).toContain(acceptOutcome);

    const [after] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(after!.status).toBe("disbanded");

    // The whole point: nothing rostered survives the faction's hold.
    const stranded = await db.select().from(factionMembers)
      .where(eq(factionMembers.serverId, serverId));
    expect(stranded).toEqual([]);
  });
  /**
   * LOCK ORDER, not a data race. `acceptInvite` and `disband` both touch
   * `factions` and `faction_invites`; if they take them in opposite orders,
   * Postgres resolves the cycle by aborting one side with 40P01 — a raw
   * serialization failure surfacing to a player who merely pressed Accept.
   *
   * Both halves of the cycle were introduced by the final-review fix wave:
   * the accept's `FOR SHARE` on `factions` (Item 2) and the disband's revoke
   * of outstanding invites (Item 4). Before the wave neither existed.
   *
   * Staged with a real row lock, the same way the accept-vs-disband test
   * above is: a third connection holds `FOR UPDATE` on the leader's
   * membership row, which parks the disband between its `UPDATE factions`
   * (faction row now locked) and its invite revoke. The accept then runs into
   * that held faction row. Under the broken order it is already holding the
   * invite row it claimed, so when the disband is released and reaches its
   * revoke the cycle closes. Under the fixed order the accept takes
   * `factions` FIRST and holds nothing the disband needs, so the disband
   * completes and the accept simply finds the faction gone.
   *
   * A row lock, not `lock table faction_members` — `disband`'s leader guard
   * is a correlated SELECT on that same table, and a table-level ACCESS
   * EXCLUSIVE would park the disband BEFORE it locked the faction row, which
   * is the wrong gap entirely.
   */
  it("an accept and a disband cannot deadlock on faction versus invite", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: t0,
    }).returning();
    const factionId = f!.id;
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "1".repeat(40), discordId: "d1", role: "leader", joinedAt: t0,
    });

    const PLAYER_DAYZ = "P".repeat(40);
    const PLAYER_DISCORD = "d9";
    await db.insert(identityLinks).values({
      discordId: PLAYER_DISCORD, dayzId: PLAYER_DAYZ, gamertag: "Nine", verifiedAt: t0,
    });
    const [inv] = await db.insert(factionInvites).values({
      factionId, serverId,
      inviteeDiscordId: PLAYER_DISCORD, inviteeDayzId: PLAYER_DAYZ,
      invitedByDiscordId: "d1", createdAt: t0, expiresAt: new Date(t0.getTime() + 3_600_000),
    }).returning();

    let accepting!: Promise<string>;
    let disbanding!: Promise<string>;
    await holdingLock(
      sql`select id from faction_members where faction_id = ${factionId} for update`,
      async () => {
        // The disband takes the faction row, then parks on the held roster row
        // — with its invite revoke still ahead of it.
        disbanding = storeB.disband(factionId, "d1");
        await until("the disband parked on the roster row", async () => await blockedBackends(db) >= 1);

        // The accept now arrives at that same faction row.
        accepting = storeA.acceptInvite(inv!.id, PLAYER_DISCORD, t0);
        await until("the accept parked on the faction row", async () => await blockedBackends(db) >= 2);
      },
    );

    // Neither of these may reject. A 40P01 deadlock abort throws out of the
    // store — `acceptInvite`'s catch rethrows anything that is not a
    // `RosterAbort`, and `disband` has no catch at all — so the assertion
    // that both settle IS the assertion that no deadlock occurred.
    const [acceptOutcome, disbandOutcome] = await Promise.all([accepting, disbanding]);
    expect(disbandOutcome).toBe("ok");
    // Deterministic: the accept was waiting on the faction row, so it reads
    // the row only after the disband committed `disbanded` onto it.
    expect(acceptOutcome).toBe("not-holding");

    // ...and the invite was not consumed on the way past.
    const [after] = await db.select().from(factionInvites).where(eq(factionInvites.id, inv!.id));
    expect(after!.acceptedAt).toBeNull();
    expect(after!.revokedAt).not.toBeNull();
    expect(await db.select().from(factionMembers).where(eq(factionMembers.serverId, serverId))).toEqual([]);
  });
});
