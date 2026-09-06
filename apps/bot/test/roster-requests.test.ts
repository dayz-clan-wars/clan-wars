import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionJoinRequests, identityLinks, clanNotices,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { CLAN_SIZE_CAP } from "@factions/domain";
import { seedFaction } from "./seed.js";
import {
  PgRosterStore, requestJoinDb, openRequestsFor, requestsBy, decideRequestDb, withdrawRequestDb,
} from "@factions/roster/internal";

const URL = requireTestDatabaseUrl();
const LEADER = "d1";
const UID_B = "200".padEnd(40, "0");
const now = new Date("2026-08-31T12:00:00Z");
const later = new Date(now.getTime() + 604_800_000);

describe("PgRosterStore join requests", () => {
  let db: Database;
  let store: PgRosterStore;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_join_requests, faction_invites, roster_cooldowns, faction_members, declarations, poles, events, adm_files, factions, identity_links, servers restart identity cascade`);
    });
    store = new PgRosterStore(db);

    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const f = await seedFaction(db, {
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      status: "active", leaderDiscordId: LEADER, createdAt: now,
    });
    factionId = f.id;
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "L".repeat(40), discordId: LEADER, role: "leader", joinedAt: now,
    });
    // `decideRequestDb` rosters the requester's CURRENT linked UID, so the
    // link is part of the fixture, not scenery.
    await db.insert(identityLinks).values({
      discordId: "200", dayzId: UID_B, gamertag: "Two Hundred", verifiedAt: now,
    });
  });

  it("a request needs a recruiting clan; accepting makes a pending member and closes the request", async () => {
    expect((await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later })).outcome).toBe("not-recruiting");
    expect(await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: "EU evenings", language: "en", pitch: "Casual, no drama" })).toBe("ok");
    const { outcome, requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(outcome).toBe("ok");
    expect((await openRequestsFor(db, factionId, now)).map((r) => r.dayzId)).toEqual([UID_B]);
    expect((await requestsBy(db, UID_B, now))[0]).toMatchObject({ factionName: "Bears", tag: "BEAR" });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("ok");
    const [m] = await db.select({ status: factionMembers.status }).from(factionMembers).where(eq(factionMembers.dayzId, UID_B));
    expect(m).toEqual({ status: "pending" });
    expect(await openRequestsFor(db, factionId, now)).toEqual([]);
    const [req] = await db.select().from(factionJoinRequests).where(eq(factionJoinRequests.id, requestId!));
    expect(req).toMatchObject({ decision: "accepted", decidedByDiscordId: LEADER });
  });

  it("refusals: second open request, member acting, non-recruiting at decide time, declined leaves no member", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const first = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect((await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later })).outcome).toBe("already-requested");
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: "nobody", decision: "accepted", at: now })).toBe("not-permitted");
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: false, playWindow: null, language: null, pitch: null });
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("not-recruiting");
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "declined", at: now })).toBe("ok");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.dayzId, UID_B))).toEqual([]);
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("gone");
  });

  it("an accepted decision queues a 'joined' channel notice and a 'request_accepted' DM", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const { requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("ok");
    const rows = await db.select().from(clanNotices);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.target === "channel")).toMatchObject({ kind: "joined", payload: { gamertag: "Two Hundred" } });
    expect(rows.find((r) => r.target === "dm")).toMatchObject({ kind: "request_accepted", discordTargetId: "200", payload: { clan: "Bears" } });
  });

  it("a declined decision queues only a 'request_declined' DM", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const { requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: LEADER, decision: "declined", at: now })).toBe("ok");
    const rows = await db.select().from(clanNotices);
    expect(rows).toEqual([expect.objectContaining({ target: "dm", kind: "request_declined", discordTargetId: "200", payload: { clan: "Bears" } })]);
  });

  it("a refused decision (not permitted) queues no notice", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const { requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: "nobody", decision: "accepted", at: now })).toBe("not-permitted");
    expect(await db.select().from(clanNotices)).toEqual([]);
  });

  it("the cap refuses at request and at accept; an expired request is not offered", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    for (let i = 0; i < 9; i++) await db.insert(factionMembers).values({ factionId, serverId, dayzId: `F${i}`.padEnd(40, "0"), discordId: `f${i}`, role: "member", joinedAt: now });
    expect((await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later })).outcome).toBe("cap");
    await db.delete(factionMembers).where(eq(factionMembers.dayzId, "F8".padEnd(40, "0")));
    const { requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "F8".padEnd(40, "0"), discordId: "f8", role: "member", joinedAt: now });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("cap");
    expect(await openRequestsFor(db, factionId, new Date(later.getTime() + 1))).toEqual([]);
  });

  it("an expired open request is refreshed by a new one; a live one still blocks", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const first = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(first.outcome).toBe("ok");

    // Still within the window: blocked, same row, unchanged expiry.
    const blocked = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(blocked.outcome).toBe("already-requested");
    const [stillOpen] = await db.select().from(factionJoinRequests).where(eq(factionJoinRequests.id, first.requestId!));
    expect(stillOpen).toMatchObject({ expiresAt: later });

    // Past expiry: the same open row is refreshed, not left stuck forever.
    const afterExpiry = new Date(later.getTime() + 1);
    const freshExpiry = new Date(afterExpiry.getTime() + 604_800_000);
    const refreshed = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: afterExpiry, expiresAt: freshExpiry });
    expect(refreshed.outcome).toBe("ok");
    expect(refreshed.requestId).toBe(first.requestId);
    const [rows] = await db.select().from(factionJoinRequests).where(eq(factionJoinRequests.dayzId, UID_B));
    expect(rows).toMatchObject({ id: first.requestId, expiresAt: freshExpiry, decidedAt: null });
  });

  it("an officer revokes an outstanding invite; a member cannot; invitesOut lists the rest", async () => {
    // `f0` must exist as a `member` row for the "a member cannot" assertion.
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "M0".padEnd(40, "0"), discordId: "f0", role: "member", joinedAt: now });
    const a = await store.createInvite({ factionId, serverId, inviteeDiscordId: "200", inviteeDayzId: UID_B, invitedByDiscordId: LEADER, at: now, expiresAt: later, siteBaseUrl: "https://example.test" });
    expect((await store.invitesOut(factionId, now)).map((i) => i.inviteeDiscordId)).toEqual(["200"]);
    expect(await store.revokeInvite({ inviteId: a.inviteId!, factionId, actorDiscordId: "f0", at: now })).toBe("not-permitted");
    expect(await store.revokeInvite({ inviteId: a.inviteId!, factionId, actorDiscordId: LEADER, at: now })).toBe("ok");
    expect(await store.invitesOut(factionId, now)).toEqual([]);
    expect(await store.revokeInvite({ inviteId: a.inviteId!, factionId, actorDiscordId: LEADER, at: now })).toBe("gone");
  });

  it("only leader or officer sets the recruiting post", async () => {
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "M".repeat(40), discordId: "m", role: "member", joinedAt: now });
    expect(await store.setRecruitingPost({ factionId, actorDiscordId: "m", recruiting: true, playWindow: null, language: null, pitch: null })).toBe("not-permitted");
  });

  it("withdraws a request the requester owns; not someone else's", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const { requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(await withdrawRequestDb(db, requestId!, "someone-else", now)).toBe(false);
    expect(await withdrawRequestDb(db, requestId!, "200", now)).toBe(true);
    expect(await openRequestsFor(db, factionId, now)).toEqual([]);
  });

  /**
   * CONTROLLER RULING: `decideRequestDb`'s recheck lock is `FOR UPDATE`, not
   * `FOR SHARE` — mirroring `acceptInvite`'s own reasoning (task 3/4). `FOR
   * SHARE` lets two concurrent approvals both count below `CLAN_SIZE_CAP`
   * and both insert, overshooting the cap. This test proves the lock, not
   * just its presence: two separate connections decide two different open
   * requests for the SAME faction, at the SAME cap-adjacent membership
   * count, via `Promise.all` — genuine concurrency, not two statements on
   * one connection.
   */
  it("⚠️ concurrent decides for the same faction serialize on the cap — exactly one wins", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    // CLAN_SIZE_CAP - 1 on the table already: the leader from beforeEach,
    // plus CLAN_SIZE_CAP - 2 more. One more accept fits; a second, racing
    // it, must not.
    for (let i = 0; i < CLAN_SIZE_CAP - 2; i++) {
      await db.insert(factionMembers).values({
        factionId, serverId, dayzId: `R${i}`.padEnd(40, "0"), discordId: `r${i}`, role: "member", joinedAt: now,
      });
    }

    const SECOND_DISCORD = "201";
    const SECOND_DAYZ = "300".padEnd(40, "0");
    await db.insert(identityLinks).values({
      discordId: SECOND_DISCORD, dayzId: SECOND_DAYZ, gamertag: "Three Hundred", verifiedAt: now,
    });

    const first = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    const second = await requestJoinDb(db, { factionId, serverId, dayzId: SECOND_DAYZ, discordId: SECOND_DISCORD, at: now, expiresAt: later });
    expect(first.outcome).toBe("ok");
    expect(second.outcome).toBe("ok");

    const dbA = createClient(URL);
    const dbB = createClient(URL);
    try {
      const [r1, r2] = await Promise.all([
        decideRequestDb(dbA, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "accepted", at: now }),
        decideRequestDb(dbB, { requestId: second.requestId!, actorDiscordId: LEADER, decision: "accepted", at: now }),
      ]);

      const outcomes = [r1, r2].sort();
      expect(outcomes).toEqual(["cap", "ok"]);

      const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
      expect(rows).toHaveLength(CLAN_SIZE_CAP);
    } finally {
      await dbA.$client.end();
      await dbB.$client.end();
    }
  });
});
