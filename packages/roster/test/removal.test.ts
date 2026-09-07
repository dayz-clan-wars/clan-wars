import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionVotes, factionVoteBallots, successionClaims, clanNotices,
  identityLinks, players, admFiles, declarations, poles, events, rosterCooldowns, vaultLocks,
  guestPasses, identityHolds,
  type Database,
} from "@factions/db";
import { sql, eq, and, asc } from "drizzle-orm";
import { ROSTER_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, NEW_POLE_GRACE_MS, type ClanNoticeKind } from "@factions/domain";
import { removeFromGuildDb, openVoteDb, claimSuccessionDb } from "../src/internal";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const DAY = 86_400_000;
const SITE = "https://example.test";

// L founded; O2 joined before O1 (so O2 is the longest-tenured OFFICER, and
// the successor test cannot pass by picking the first row inserted).
const UID = {
  L: "L".repeat(40), O1: "1".repeat(40), O2: "2".repeat(40), M1: "M".repeat(40),
  P: "P".repeat(40), S: "S".repeat(40), U: "U".repeat(40),
};
const TAGS: Record<keyof typeof UID, string> = {
  L: "Leo", O1: "Otto", O2: "Ozzy", M1: "Mina", P: "Pia", S: "Solo", U: "Uma",
};
const D: Record<keyof typeof UID, string> = {
  L: "dL", O1: "dO1", O2: "dO2", M1: "dM1", P: "dP", S: "dS", U: "dU",
};

const SOLO_POLE = "9000.00:100.00:9000.00";

describe("guild removal: the one roster write a gateway event starts", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;
  let admFileId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table guest_passes, vault_history, vault_locks, faction_vote_ballots, faction_votes, succession_claims, clan_notices, faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [adm] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = adm!.id;

    const who = Object.keys(UID) as (keyof typeof UID)[];
    await db.insert(players).values(who.map((k) => ({ dayzId: UID[k], gamertag: TAGS[k], firstSeenAt: ago(60 * DAY), lastSeenAt: now })));
    await db.insert(identityLinks).values(who.map((k) => ({ discordId: D[k], dayzId: UID[k], gamertag: TAGS[k], verifiedAt: now })));

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: D.L, createdAt: ago(30 * DAY), activatedAt: ago(30 * DAY),
    });
    factionId = f.id;
    // t0 = 30 days ago. O2 (t0+1d) outranks O1 (t0+2d) on tenure.
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID.L, discordId: D.L, role: "leader", joinedAt: ago(30 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.O1, discordId: D.O1, role: "officer", joinedAt: ago(28 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.O2, discordId: D.O2, role: "officer", joinedAt: ago(29 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.M1, discordId: D.M1, role: "member", joinedAt: ago(27 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.P, discordId: D.P, role: "member", joinedAt: ago(1 * DAY), status: "pending", pendingSince: ago(1 * DAY) },
    ]);
  });

  afterEach(async () => { await db.$client.end(); });

  /** A solo declaration for `k`, written the way `seed.ts` writes a clan's: pole, evidence, row. */
  const seedSolo = async (k: keyof typeof UID) => {
    await db.insert(poles).values({
      serverId, map: "livonia", poleKey: SOLO_POLE, x: "9000.00", y: "100.00", z: "9000.00",
      currentTexture: "Flag_White", flagRaised: true, firstSeenAt: ago(10 * DAY), lastSeenAt: ago(10 * DAY),
      graceUntil: new Date(ago(10 * DAY).getTime() + NEW_POLE_GRACE_MS),
    }).onConflictDoNothing();
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: 1, type: "flag.raised", occurredAt: ago(10 * DAY),
      payload: { dayzId: UID[k], gamertag: TAGS[k], texture: "Flag_White", poleKey: SOLO_POLE, pole: { x: 9000, y: 100, z: 9000 } },
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey: SOLO_POLE, x: "9000.00", y: "100.00", z: "9000.00",
      ownerDayzId: UID[k], evidenceEventId: ev!.id, declaredAt: ago(10 * DAY),
    });
  };

  const remove = (k: keyof typeof UID, at = now) => removeFromGuildDb(db, { discordId: D[k], at });

  const memberRow = async (k: keyof typeof UID) => {
    const [m] = await db.select().from(factionMembers)
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, UID[k])));
    return m ?? null;
  };
  const linkRow = async (k: keyof typeof UID) => {
    const [l] = await db.select().from(identityLinks).where(eq(identityLinks.discordId, D[k]));
    return l ?? null;
  };
  const cooldownRow = async (k: keyof typeof UID) => {
    const [c] = await db.select().from(rosterCooldowns).where(eq(rosterCooldowns.dayzId, UID[k]));
    return c ?? null;
  };
  const notices = async (kind: ClanNoticeKind) => {
    const rows = await db.select({ payload: clanNotices.payload }).from(clanNotices)
      .where(eq(clanNotices.kind, kind)).orderBy(asc(clanNotices.id));
    return rows.map((r) => r.payload as Record<string, unknown>);
  };
  const noticeKinds = async () => (await db.select({ kind: clanNotices.kind }).from(clanNotices).orderBy(asc(clanNotices.id))).map((r) => r.kind);
  const factionRow = async () => (await db.select().from(factions).where(eq(factions.id, factionId)))[0]!;
  const lock = (name: string, minRole: "leader" | "officer" | "member") =>
    db.insert(vaultLocks).values({
      factionId, name, code: "1234", minRole, createdByDayzId: UID.L, createdAt: ago(5 * DAY),
    }).returning({ id: vaultLocks.id });
  const lockExposed = async (name: string) => {
    const [l] = await db.select({ exposedAt: vaultLocks.exposedAt }).from(vaultLocks)
      .where(and(eq(vaultLocks.factionId, factionId), eq(vaultLocks.name, name)));
    return l!.exposedAt;
  };

  // ------------------------------------------------- 1. the leader, with officers

  it("the leader goes: the longest-tenured officer takes the seat, with no cooldown for anyone", async () => {
    expect(await remove("L")).toEqual({
      linked: true, roster: "leader-succeeded", successorDiscordId: D.O2, releasedSoloBase: false,
    });

    expect(await memberRow("L")).toBeNull();
    expect((await memberRow("O2"))!.role).toBe("leader");
    expect((await memberRow("O1"))!.role).toBe("officer");
    expect((await factionRow()).leaderDiscordId).toBe(D.O2);
    expect(await cooldownRow("L")).toBeNull();
    expect(await cooldownRow("O2")).toBeNull();
    expect(await notices("leader_removed")).toEqual([{ old: TAGS.L, new: TAGS.O2 }]);
    expect(await linkRow("L")).toBeNull();
  });

  // ------------------------------------------------- 2. no officers / nobody left

  it("with no officers the longest-tenured full member leads (a pending member is never chosen)", async () => {
    await db.delete(factionMembers).where(and(
      eq(factionMembers.factionId, factionId),
      sql`${factionMembers.role} = 'officer'`,
    ));
    expect(await remove("L")).toMatchObject({ roster: "leader-succeeded", successorDiscordId: D.M1 });
    expect((await memberRow("M1"))!.role).toBe("leader");
    expect((await memberRow("P"))!.status).toBe("pending");
    expect((await factionRow()).leaderDiscordId).toBe(D.M1);
  });

  it("a leader alone disbands the clan: holds written, declaration released, roster gone", async () => {
    await db.delete(factionMembers).where(and(eq(factionMembers.factionId, factionId), sql`${factionMembers.dayzId} <> ${UID.L}`));

    expect(await remove("L")).toEqual({
      linked: true, roster: "leader-disbanded", successorDiscordId: null, releasedSoloBase: false,
    });

    expect((await factionRow()).status).toBe("disbanded");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toEqual([]);
    const holds = await db.select({ kind: identityHolds.kind, value: identityHolds.valueLower }).from(identityHolds).orderBy(asc(identityHolds.kind));
    expect(holds).toEqual([{ kind: "name", value: "bears" }, { kind: "tag", value: "bear" }]);
    expect(await db.select().from(declarations)).toEqual([]);
    expect(await linkRow("L")).toBeNull();
  });

  // ------------------------------------------------- 3. everyone else

  it("an officer goes as a leave does: cooldown, electorate slot, vault exposure, notice, link", async () => {
    await lock("gate", "member");
    await lock("stash", "officer");
    await lock("core", "leader");
    // O1 is in the electorate of an open vote and has cast the opener's ballot.
    expect(await openVoteDb(db, { factionId, openerDiscordId: D.O1, nomineeDiscordId: D.O2, at: now, siteBaseUrl: SITE })).toMatchObject({ outcome: "ok" });
    const [v] = await db.select().from(factionVotes);

    expect(await remove("O1")).toEqual({
      linked: true, roster: "member-left", successorDiscordId: null, releasedSoloBase: false,
    });

    expect(await memberRow("O1")).toBeNull();
    expect((await cooldownRow("O1"))!.until.getTime()).toBe(now.getTime() + ROSTER_COOLDOWN_MS);

    const [after] = await db.select().from(factionVotes).where(eq(factionVotes.id, v!.id));
    expect(after!.electorateSize).toBe(v!.electorateSize - 1);
    expect(after!.electorateDayzIds).not.toContain(UID.O1);
    const ballots = await db.select({ dayzId: factionVoteBallots.dayzId }).from(factionVoteBallots).where(eq(factionVoteBallots.voteId, v!.id));
    expect(ballots.map((b) => b.dayzId)).not.toContain(UID.O1);

    // An officer sees the officer and member locks, never the leader's.
    expect(await lockExposed("gate")).toEqual(now);
    expect(await lockExposed("stash")).toEqual(now);
    expect(await lockExposed("core")).toBeNull();

    expect(await notices("left")).toEqual([{ gamertag: TAGS.O1 }]);
    expect(await linkRow("O1")).toBeNull();
  });

  it("a pending member goes with the cooldown and the notice, but touches no vault and no electorate", async () => {
    await lock("gate", "member");
    expect(await openVoteDb(db, { factionId, openerDiscordId: D.O1, nomineeDiscordId: D.O2, at: now, siteBaseUrl: SITE })).toMatchObject({ outcome: "ok" });
    const [v] = await db.select().from(factionVotes);

    expect(await remove("P")).toEqual({
      linked: true, roster: "member-left", successorDiscordId: null, releasedSoloBase: false,
    });

    expect(await memberRow("P")).toBeNull();
    expect((await cooldownRow("P"))!.until.getTime()).toBe(now.getTime() + ROSTER_COOLDOWN_MS);
    const [after] = await db.select().from(factionVotes).where(eq(factionVotes.id, v!.id));
    expect(after!.electorateSize).toBe(v!.electorateSize);
    expect(await lockExposed("gate")).toBeNull();
    expect(await notices("left")).toEqual([{ gamertag: TAGS.P }]);
    expect(await linkRow("P")).toBeNull();
  });

  it("a pending member still holding a solo base has it released", async () => {
    await seedSolo("P");
    expect(await remove("P")).toMatchObject({ roster: "member-left", releasedSoloBase: true });
    expect(await db.select().from(declarations).where(eq(declarations.ownerDayzId, UID.P))).toEqual([]);
  });

  // ------------------------------------------------- 4. open leadership business

  it("the leader's removal closes an open vote and an open claim in silence", async () => {
    expect(await openVoteDb(db, { factionId, openerDiscordId: D.O1, nomineeDiscordId: D.O2, at: now, siteBaseUrl: SITE })).toMatchObject({ outcome: "ok" });
    await db.update(players).set({ lastSeenAt: ago(30 * DAY) }).where(eq(players.dayzId, UID.L));
    expect(await claimSuccessionDb(db, { factionId, claimantDiscordId: D.O1, at: now })).toBe("ok");

    expect(await remove("L")).toMatchObject({ roster: "leader-succeeded", successorDiscordId: D.O2 });

    const [v] = await db.select().from(factionVotes);
    expect(v!.result).toBe("failed");
    expect(v!.closedAt).toEqual(now);
    expect((await factionRow()).nextVoteAllowedAt).toBeNull();

    const [c] = await db.select().from(successionClaims);
    expect(c!.outcome).toBe("voided");
    expect(c!.closedAt).toEqual(now);

    expect(await noticeKinds()).not.toContain("vote_failed");
    expect(await noticeKinds()).not.toContain("succession_voided");
  });

  // ------------------------------------------------- 5. no clan / no link

  it("a solo declarant loses the base and the link, and was never on a roster", async () => {
    await seedSolo("S");
    expect(await remove("S")).toEqual({
      linked: true, roster: "none", successorDiscordId: null, releasedSoloBase: true,
    });
    expect(await db.select().from(declarations).where(eq(declarations.ownerDayzId, UID.S))).toEqual([]);
    const [p] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, SOLO_POLE));
    expect(p!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
    expect(await linkRow("S")).toBeNull();
  });

  it("an unlinked id writes nothing at all", async () => {
    const before = await db.select().from(identityLinks);
    expect(await removeFromGuildDb(db, { discordId: "d-nobody", at: now })).toEqual({
      linked: false, roster: "none", successorDiscordId: null, releasedSoloBase: false,
    });
    expect(await db.select().from(identityLinks)).toEqual(before);
    expect(await db.select().from(clanNotices)).toEqual([]);
    expect(await db.select().from(rosterCooldowns)).toEqual([]);
  });

  it("a linked user in no clan loses only the link", async () => {
    expect(await remove("U")).toEqual({
      linked: true, roster: "none", successorDiscordId: null, releasedSoloBase: false,
    });
    expect(await linkRow("U")).toBeNull();
    expect(await db.select().from(clanNotices)).toEqual([]);
    expect(await db.select().from(rosterCooldowns)).toEqual([]);
  });

  it("open guest passes anywhere are revoked, converted and already-revoked ones untouched", async () => {
    const revokedEarlier = ago(1 * DAY);
    await db.insert(guestPasses).values([
      { factionId, discordUserId: D.U, grantedByDiscordId: D.L, grantedAt: ago(2 * DAY), expiresAt: new Date(now.getTime() + DAY) },
      { factionId, discordUserId: D.U, grantedByDiscordId: D.L, grantedAt: ago(3 * DAY), expiresAt: ago(2 * DAY), revokedAt: revokedEarlier },
      { factionId, discordUserId: D.M1, grantedByDiscordId: D.L, grantedAt: ago(2 * DAY), expiresAt: new Date(now.getTime() + DAY) },
    ]);
    await remove("U");
    const rows = await db.select({ id: guestPasses.id, user: guestPasses.discordUserId, revokedAt: guestPasses.revokedAt })
      .from(guestPasses).orderBy(asc(guestPasses.id));
    expect(rows.map((r) => r.revokedAt)).toEqual([now, revokedEarlier, null]);
  });

  // ------------------------------------------------- 6. idempotence

  it("a second gateway event for the same id is a no-op", async () => {
    expect(await remove("O1")).toMatchObject({ linked: true, roster: "member-left" });
    const notices = await db.select().from(clanNotices);
    expect(await remove("O1")).toEqual({
      linked: false, roster: "none", successorDiscordId: null, releasedSoloBase: false,
    });
    expect(await db.select().from(clanNotices)).toEqual(notices);
  });
});
