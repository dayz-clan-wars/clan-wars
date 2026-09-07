import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionVotes, factionVoteBallots, successionClaims, clanNotices,
  identityLinks, players, admFiles,
  type Database,
} from "@factions/db";
import { sql, eq, and, asc } from "drizzle-orm";
import {
  LEADER_SILENT_MS, SUCCESSION_WINDOW_MS, VOTE_LENGTH_MS, FAILED_VOTE_COOLDOWN_MS, voteThreshold,
  type ClanNoticeKind,
} from "@factions/domain";
import {
  claimSuccessionDb, openVoteDb, castVoteDb, resolveSuccessionClaims, closeExpiredVotes,
  openVoteFor, openClaimFor, successionEligibility, closeLeadershipSilentlyTx, lockFactionTx,
  disbandFactionTx, leaderIs,
} from "../src/internal";
import { kickDb, transferDb, promoteDb, inviteDb, leaveDb, disbandDb } from "../src/writes";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const on = (ms: number) => new Date(now.getTime() + ms);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SITE = "https://example.test";

const UID = {
  L: "L".repeat(40), O1: "O".repeat(40), M1: "1".repeat(40),
  M2: "2".repeat(40), M3: "3".repeat(40), P: "P".repeat(40), X: "X".repeat(40),
};
const TAGS: Record<keyof typeof UID, string> = {
  L: "Leo", O1: "Otto", M1: "Mina", M2: "Milo", M3: "Mara", P: "Pia", X: "Xena",
};
const D: Record<keyof typeof UID, string> = {
  L: "dL", O1: "dO1", M1: "dM1", M2: "dM2", M3: "dM3", P: "dP", X: "dX",
};

describe("leadership store: succession, votes, the freeze", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_vote_ballots, faction_votes, succession_claims, clan_notices, faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true });

    const who = Object.keys(UID) as (keyof typeof UID)[];
    await db.insert(players).values(who.map((k) => ({ dayzId: UID[k], gamertag: TAGS[k], firstSeenAt: ago(30 * DAY), lastSeenAt: now })));
    await db.insert(identityLinks).values(who.map((k) => ({ discordId: D[k], dayzId: UID[k], gamertag: TAGS[k], verifiedAt: now })));

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: D.L, createdAt: ago(30 * DAY), activatedAt: ago(30 * DAY),
    });
    factionId = f.id;
    // Insert order fixes `electorate_dayz_ids` order: O1, M1, M2, M3.
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID.L, discordId: D.L, role: "leader", joinedAt: ago(30 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.O1, discordId: D.O1, role: "officer", joinedAt: ago(20 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.M1, discordId: D.M1, role: "member", joinedAt: ago(19 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.M2, discordId: D.M2, role: "member", joinedAt: ago(18 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.M3, discordId: D.M3, role: "member", joinedAt: ago(17 * DAY), status: "full" },
      { factionId, serverId, dayzId: UID.P, discordId: D.P, role: "member", joinedAt: ago(1 * DAY), status: "pending", pendingSince: ago(1 * DAY) },
    ]);
  });

  afterEach(async () => { await db.$client.end(); });

  const seen = (k: keyof typeof UID, at: Date) => db.update(players).set({ lastSeenAt: at }).where(eq(players.dayzId, UID[k]));
  const roleOf = async (k: keyof typeof UID) => {
    const [m] = await db.select({ role: factionMembers.role }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, UID[k])));
    return m?.role ?? null;
  };
  const statusOf = async () => {
    const [f] = await db.select({ status: factions.status }).from(factions).where(eq(factions.id, factionId));
    return f!.status;
  };
  const rosterSize = async () => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(factionMembers).where(eq(factionMembers.factionId, factionId));
    return r!.n;
  };
  const notices = async (kind: ClanNoticeKind) => {
    const rows = await db.select({ payload: clanNotices.payload }).from(clanNotices)
      .where(eq(clanNotices.kind, kind)).orderBy(asc(clanNotices.id));
    return rows.map((r) => r.payload as Record<string, unknown>);
  };
  const ballotCount = async (voteId: number) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(factionVoteBallots).where(eq(factionVoteBallots.voteId, voteId));
    return r!.n;
  };
  const voteRow = async () => (await db.select().from(factionVotes).orderBy(asc(factionVotes.id)))[0];
  const claimRow = async () => (await db.select().from(successionClaims).orderBy(asc(successionClaims.id)))[0];
  const leaderDiscordId = async () => {
    const [f] = await db.select({ id: factions.leaderDiscordId, next: factions.nextVoteAllowedAt }).from(factions).where(eq(factions.id, factionId));
    return f!;
  };
  const claim = (who: keyof typeof UID, at = now) =>
    claimSuccessionDb(db, { factionId, claimantDiscordId: D[who], at });
  const open = (opener: keyof typeof UID, nominee: keyof typeof UID, at = now) =>
    openVoteDb(db, { factionId, openerDiscordId: D[opener], nomineeDiscordId: D[nominee], at, siteBaseUrl: SITE });
  const cast = (who: keyof typeof UID, at = now) => castVoteDb(db, { factionId, voterDiscordId: D[who], at });

  // ---------------------------------------------------------------- 1. claim

  it("claim: a silent leader lets the officer claim, and the claim is on record", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("O1")).toBe("ok");

    const c = await claimRow();
    expect(c).toMatchObject({
      factionId, claimantDayzId: UID.O1, claimantDiscordId: D.O1,
      leaderDayzId: UID.L, leaderDiscordId: D.L, outcome: null, closedAt: null,
    });
    expect(c!.resolvesAt.getTime()).toBe(now.getTime() + SUCCESSION_WINDOW_MS);
    expect(await notices("succession_claimed")).toEqual([{ gamertag: TAGS.O1, leader: TAGS.L }]);

    const read = await openClaimFor(db, factionId);
    expect(read).toMatchObject({ claimantGamertag: TAGS.O1, leaderGamertag: TAGS.L });
    expect(read!.resolvesAt.getTime()).toBe(now.getTime() + SUCCESSION_WINDOW_MS);
  });

  it("claim: an officer outranks a member, but with no officers a member may claim", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("M1")).toBe("not-eligible");
    expect(await successionEligibility(db, factionId, UID.M1, now)).toBe("not-eligible");
    expect(await db.select().from(successionClaims)).toEqual([]);

    await db.update(factionMembers).set({ role: "member" })
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, UID.O1)));
    expect(await successionEligibility(db, factionId, UID.M1, now)).toBe("eligible");
    expect(await claim("M1")).toBe("ok");
  });

  it("claim: a leader seen inside the silence window, the leader themselves, a pending member, a second claim", async () => {
    await seen("L", ago(1 * DAY));
    expect(await claim("O1")).toBe("leader-active");
    expect(await successionEligibility(db, factionId, UID.O1, now)).toBe("leader-active");

    await seen("L", ago(LEADER_SILENT_MS + 1000));
    expect(await claim("L")).toBe("is-leader");
    expect(await successionEligibility(db, factionId, UID.L, now)).toBe("is-leader");
    expect(await claim("P")).toBe("not-member");

    expect(await claim("O1")).toBe("ok");
    expect(await claim("M1")).toBe("claim-open");
    expect(await successionEligibility(db, factionId, UID.M1, now)).toBe("claim-open");
    expect(await db.select().from(successionClaims)).toHaveLength(1);
  });

  // -------------------------------------------------------------- 2. resolve

  it("resolve: the leader showing up voids the claim, and nothing changes", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("O1")).toBe("ok");
    await seen("L", on(1 * HOUR));

    expect(await resolveSuccessionClaims(db, on(2 * HOUR))).toEqual({ succeeded: 0, voided: 1 });
    const c = await claimRow();
    expect(c!.outcome).toBe("voided");
    expect(c!.closedAt!.getTime()).toBe(on(2 * HOUR).getTime());
    expect(await notices("succession_voided")).toEqual([{ leader: TAGS.L, claimant: TAGS.O1 }]);
    expect(await roleOf("L")).toBe("leader");
    expect(await roleOf("O1")).toBe("officer");
    expect((await leaderDiscordId()).id).toBe(D.L);
  });

  it("resolve: silence to the end of the window hands the seat over", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("O1")).toBe("ok");

    expect(await resolveSuccessionClaims(db, on(SUCCESSION_WINDOW_MS))).toEqual({ succeeded: 1, voided: 0 });
    expect((await claimRow())!.outcome).toBe("succeeded");
    expect(await roleOf("O1")).toBe("leader");
    expect(await roleOf("L")).toBe("member");
    expect((await leaderDiscordId()).id).toBe(D.O1);
    expect(await notices("succession_done")).toEqual([{ gamertag: TAGS.O1 }]);

    // Idempotent: the claim is closed, so a second pass finds nothing.
    expect(await resolveSuccessionClaims(db, on(SUCCESSION_WINDOW_MS + HOUR))).toEqual({ succeeded: 0, voided: 0 });
  });

  it("resolve: a claimant who has since left the clan is voided, not crowned", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("O1")).toBe("ok");
    await db.delete(factionMembers).where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, UID.O1)));

    expect(await resolveSuccessionClaims(db, on(SUCCESSION_WINDOW_MS))).toEqual({ succeeded: 0, voided: 1 });
    expect((await claimRow())!.outcome).toBe("voided");
    expect(await roleOf("L")).toBe("leader");
    expect((await leaderDiscordId()).id).toBe(D.L);
  });

  // ------------------------------------------------------------ 3. open vote

  it("open: the electorate is every full member but the leader, and the opener has voted", async () => {
    const r = await open("M1", "M2");
    expect(r.outcome).toBe("ok");

    const v = await voteRow();
    expect(v).toMatchObject({
      factionId, nomineeDayzId: UID.M2, nomineeDiscordId: D.M2, openedByDayzId: UID.M1,
      leaderDayzId: UID.L, leaderDiscordId: D.L, electorateSize: 4, result: null, closedAt: null,
    });
    expect(v!.electorateDayzIds).toEqual([UID.O1, UID.M1, UID.M2, UID.M3]);
    expect(v!.closesAt.getTime()).toBe(now.getTime() + VOTE_LENGTH_MS);
    expect(await ballotCount(v!.id)).toBe(1);
    expect(await notices("vote_opened")).toEqual([
      { leader: TAGS.L, nominee: TAGS.M2, closesAt: on(VOTE_LENGTH_MS).toISOString(), link: `${SITE}/clan` },
    ]);

    const read = await openVoteFor(db, factionId);
    expect(read).toMatchObject({
      id: v!.id, nomineeDayzId: UID.M2, nomineeGamertag: TAGS.M2, leaderGamertag: TAGS.L,
      electorateSize: 4, ballots: 1, threshold: voteThreshold(4), electorateDayzIds: [UID.O1, UID.M1, UID.M2, UID.M3],
    });
  });

  it("open: the leader, a leader nominee, a pending nominee, a second vote, and the cooldown", async () => {
    expect((await open("L", "M1")).outcome).toBe("is-leader");
    expect((await open("M1", "L")).outcome).toBe("nominee-is-leader");
    expect((await open("M1", "P")).outcome).toBe("nominee-not-member");
    expect((await open("P", "M1")).outcome).toBe("not-member");
    expect(await db.select().from(factionVotes)).toEqual([]);

    expect((await open("M1", "M2")).outcome).toBe("ok");
    expect((await open("M3", "M2")).outcome).toBe("vote-open");
    expect(await db.select().from(factionVotes)).toHaveLength(1);
  });

  it("open: a cooldown from a failed vote refuses a new one", async () => {
    await db.update(factions).set({ nextVoteAllowedAt: on(2 * DAY) }).where(eq(factions.id, factionId));
    expect((await open("M1", "M2")).outcome).toBe("cooldown");
    expect(await db.select().from(factionVotes)).toEqual([]);
  });

  it("open: in a two-member clan the nomination alone carries the vote", async () => {
    await db.delete(factionMembers).where(and(
      eq(factionMembers.factionId, factionId),
      sql`${factionMembers.dayzId} in (${UID.O1}, ${UID.M2}, ${UID.M3}, ${UID.P})`,
    ));

    const r = await open("M1", "M1");
    expect(r.outcome).toBe("passed");
    const v = await voteRow();
    expect(v).toMatchObject({ electorateSize: 1, result: "passed" });
    expect(await roleOf("M1")).toBe("leader");
    expect(await roleOf("L")).toBe("officer");
    expect((await leaderDiscordId()).id).toBe(D.M1);
    expect(await notices("vote_passed")).toEqual([{ yes: 1, n: 1, nominee: TAGS.M1, old: TAGS.L }]);
    expect(await notices("vote_opened")).toEqual([]);
  });

  // ----------------------------------------------------------------- 4. cast

  it("cast: the third of four ballots carries it, and the old leader stays an officer", async () => {
    expect(voteThreshold(4)).toBe(3);
    const { voteId } = await open("M1", "M2");

    expect(await cast("M2", on(HOUR))).toBe("ok");
    expect(await ballotCount(voteId!)).toBe(2);
    expect((await voteRow())!.result).toBeNull();

    expect(await cast("M3", on(2 * HOUR))).toBe("passed");
    const v = await voteRow();
    expect(v!.result).toBe("passed");
    expect(v!.closedAt!.getTime()).toBe(on(2 * HOUR).getTime());
    expect(await roleOf("M2")).toBe("leader");
    expect(await roleOf("L")).toBe("officer");
    expect((await leaderDiscordId()).id).toBe(D.M2);
    expect(await notices("vote_passed")).toEqual([{ yes: 3, n: 4, nominee: TAGS.M2, old: TAGS.L }]);
  });

  it("cast: pending members, the leader, a double vote, and a member who arrived after the open", async () => {
    const { voteId } = await open("M1", "M2");

    expect(await cast("P")).toBe("not-in-electorate");
    expect(await cast("L")).toBe("not-in-electorate");
    expect(await cast("M1")).toBe("already-voted");

    await db.insert(players).values({ dayzId: UID.X, gamertag: TAGS.X, firstSeenAt: now, lastSeenAt: now }).onConflictDoNothing();
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID.X, discordId: D.X, role: "member", joinedAt: on(HOUR), status: "full",
    });
    expect(await cast("X", on(2 * HOUR))).toBe("not-in-electorate");

    expect(await ballotCount(voteId!)).toBe(1);
    expect((await voteRow())!.result).toBeNull();
  });

  it("cast: with no vote open there is nothing to cast", async () => {
    expect(await cast("M1")).toBe("no-vote");
  });

  // --------------------------------------------------------- 5. leave shrinks

  it("leave: a departure shrinks the electorate and can carry the vote on the spot", async () => {
    const { voteId } = await open("M1", "O1");
    expect(await cast("M2", on(HOUR))).toBe("ok");

    expect(await leaveDb(db, on(2 * HOUR), D.M3)).toBe("ok");

    const v = await voteRow();
    expect(v!.electorateSize).toBe(3);
    expect(voteThreshold(3)).toBe(2);
    expect(await ballotCount(voteId!)).toBe(2);
    expect(v!.result).toBe("passed");
    expect(await roleOf("O1")).toBe("leader");
    expect(await roleOf("L")).toBe("officer");
    expect(await notices("vote_passed")).toEqual([{ yes: 2, n: 3, nominee: TAGS.O1, old: TAGS.L }]);
  });

  it("leave: a voter takes their ballot with them", async () => {
    const { voteId } = await open("M2", "M3");
    expect(await ballotCount(voteId!)).toBe(1);

    expect(await leaveDb(db, on(HOUR), D.M2)).toBe("ok");

    const v = await voteRow();
    expect(v!.electorateSize).toBe(3);
    expect(v!.electorateDayzIds).toEqual([UID.O1, UID.M1, UID.M3]);
    expect(await ballotCount(voteId!)).toBe(0);
    expect(v!.result).toBeNull();
  });

  // --------------------------------------------------------------- 6. freeze

  it("freeze: an open vote refuses kick and transfer, but not promote or invite", async () => {
    expect((await open("M1", "M2")).outcome).toBe("ok");

    expect(await kickDb(db, on(HOUR), D.L, D.M1)).toBe("vote-open");
    expect(await roleOf("M1")).toBe("member");
    expect(await transferDb(db, on(HOUR), D.L, D.M1)).toBe("vote-open");
    expect(await roleOf("L")).toBe("leader");

    expect(await promoteDb(db, D.L, D.M1)).toBe("ok");
    expect(await roleOf("M1")).toBe("officer");
    expect((await inviteDb(db, on(HOUR), D.L, { discordId: D.X })).outcome).toBe("ok");
  });

  it("freeze: an open vote also refuses the leader-initiated disband, and lets it through once the vote closes", async () => {
    const { voteId } = await open("M1", "M2");

    expect(await disbandDb(db, D.L)).toBe("vote-open");
    expect(await statusOf()).toBe("active");
    expect(await rosterSize()).toBe(6);

    expect(await closeExpiredVotes(db, on(VOTE_LENGTH_MS))).toEqual({ passed: 0, failed: 1 });
    expect((await voteRow())!.result).toBe("failed");
    expect(await ballotCount(voteId!)).toBe(1);

    expect(await disbandDb(db, D.L)).toBe("ok");
    expect(await statusOf()).toBe("disbanded");
    expect(await rosterSize()).toBe(0);
  });

  // --------------------------------------------------------------- 7. expiry

  it("expiry: a vote short of the threshold at close fails and starts the cooldown", async () => {
    const { voteId } = await open("M1", "M2");
    const at = on(VOTE_LENGTH_MS);

    expect(await closeExpiredVotes(db, at)).toEqual({ passed: 0, failed: 1 });
    const v = await voteRow();
    expect(v!.result).toBe("failed");
    expect(v!.closedAt!.getTime()).toBe(at.getTime());
    const f = await leaderDiscordId();
    expect(f.next!.getTime()).toBe(at.getTime() + FAILED_VOTE_COOLDOWN_MS);
    expect(f.id).toBe(D.L);
    expect(await roleOf("L")).toBe("leader");
    expect(await notices("vote_failed")).toEqual([
      { yes: 1, n: 4, date: new Date(at.getTime() + FAILED_VOTE_COOLDOWN_MS).toISOString() },
    ]);
    expect(await ballotCount(voteId!)).toBe(1);

    expect(await closeExpiredVotes(db, on(VOTE_LENGTH_MS + HOUR))).toEqual({ passed: 0, failed: 0 });
    expect(await notices("vote_failed")).toHaveLength(1);
  });

  it("expiry: a vote still inside its window is left alone", async () => {
    await open("M1", "M2");
    expect(await closeExpiredVotes(db, on(HOUR))).toEqual({ passed: 0, failed: 0 });
    expect((await voteRow())!.result).toBeNull();
  });

  it("nominee gone: the vote closes silently — no cooldown, no notice, nothing to cast into", async () => {
    const { voteId } = await open("M1", "M2");

    expect(await leaveDb(db, on(HOUR), D.M2)).toBe("ok");

    const v = await voteRow();
    expect(v!.result).toBe("failed");
    expect(v!.closedAt!.getTime()).toBe(on(HOUR).getTime());
    // The clan was never asked, so it never said no.
    expect((await leaderDiscordId()).next).toBeNull();
    expect(await notices("vote_failed")).toEqual([]);
    expect(await roleOf("L")).toBe("leader");
    expect(await ballotCount(voteId!)).toBe(1);

    // And a ballot arriving afterwards finds nothing open.
    expect(await cast("M3", on(2 * HOUR))).toBe("no-vote");

    // The clan may open another vote at once — no cooldown was stamped.
    expect((await open("M1", "M3", on(3 * HOUR))).outcome).toBe("ok");
  });

  it("cast: a re-joiner whose dayz id is still in the frozen electorate is pending, and pending votes in nothing", async () => {
    const { voteId } = await open("M1", "M3");

    // Straight to the table: a `leaveDb` would take M2 out of the electorate
    // array, and it is precisely the STALE id that must not enfranchise them.
    await db.delete(factionMembers).where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, UID.M2)));
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID.M2, discordId: D.M2, role: "member",
      joinedAt: on(HOUR), status: "pending", pendingSince: on(HOUR),
    });
    expect((await voteRow())!.electorateDayzIds).toContain(UID.M2);

    expect(await cast("M2", on(2 * HOUR))).toBe("not-in-electorate");
    expect(await ballotCount(voteId!)).toBe(1);
  });

  it("disband: an open claim and an open vote die with the clan, and neither tick touches them again", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("O1")).toBe("ok");
    expect((await open("M1", "M2")).outcome).toBe("ok");

    // The leader-initiated `disbandDb` refuses here — §5.7's freeze now
    // covers disband too (see the "freeze" tests below) — so this exercises
    // the shared `disbandFactionTx` directly, exactly as the dormancy tick's
    // auto-disband and the guild-removal path call it: neither of those is
    // frozen, and this is what proves the cleanup they share still works
    // with a claim and a vote open.
    expect(await db.transaction((tx) => disbandFactionTx(tx, factionId, leaderIs(factionId, D.L)))).toBe(true);

    expect((await claimRow())!.outcome).toBe("voided");
    expect((await voteRow())!.result).toBe("failed");
    expect((await leaderDiscordId()).next).toBeNull();
    const before = await db.select({ id: clanNotices.id }).from(clanNotices);

    expect(await resolveSuccessionClaims(db, on(SUCCESSION_WINDOW_MS + DAY))).toEqual({ succeeded: 0, voided: 0 });
    expect(await closeExpiredVotes(db, on(VOTE_LENGTH_MS + DAY))).toEqual({ passed: 0, failed: 0 });

    expect(await db.select({ id: clanNotices.id }).from(clanNotices)).toEqual(before);
    expect((await leaderDiscordId()).next).toBeNull();
    expect(await notices("vote_failed")).toEqual([]);
    expect(await notices("succession_voided")).toEqual([]);
  });

  it("silent close: a leader who leaves the Discord takes their claim and their vote with them", async () => {
    await seen("L", ago(8 * DAY));
    expect(await claim("O1")).toBe("ok");
    expect((await open("M1", "M2")).outcome).toBe("ok");

    await db.transaction(async (tx) => {
      await lockFactionTx(tx, factionId);
      await closeLeadershipSilentlyTx(tx, factionId, on(HOUR));
    });

    expect((await claimRow())!.outcome).toBe("voided");
    expect((await voteRow())!.result).toBe("failed");
    // No cooldown and no notice: the question died with its subject.
    expect((await leaderDiscordId()).next).toBeNull();
    expect(await notices("succession_voided")).toEqual([]);
    expect(await notices("vote_failed")).toEqual([]);
  });

  // ----------------------------------------------------------------- 8. race

  it("race: the deciding ballot and a departure on two connections agree on one outcome", async () => {
    await open("M1", "O1");
    expect(await cast("M2", on(HOUR))).toBe("ok");

    const dbA = createClient(URL);
    const dbB = createClient(URL);
    try {
      // M3's ballot would be the third of four; M2's departure would shrink
      // the electorate to three, where the two ballots already stand. Either
      // order passes the vote — and neither may deadlock.
      const [a, b] = await Promise.all([
        castVoteDb(dbA, { factionId, voterDiscordId: D.M3, at: on(2 * HOUR) }),
        leaveDb(dbB, on(2 * HOUR), D.M2),
      ]);
      expect(["ok", "passed"]).toContain(a);
      expect(b).toBe("ok");
    } finally {
      await dbA.$client.end();
      await dbB.$client.end();
    }

    const v = await voteRow();
    const ballots = await ballotCount(v!.id);
    // The row outcome is consistent with its own numbers, whichever way it went.
    expect(v!.result).toBe(ballots >= voteThreshold(v!.electorateSize) ? "passed" : null);
    expect(v!.result).toBe("passed");
    expect(await roleOf("O1")).toBe("leader");
    expect(await roleOf("L")).toBe("officer");
    expect(await notices("vote_passed")).toHaveLength(1);
  });
});
