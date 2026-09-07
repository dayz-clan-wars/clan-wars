import type { Database } from "@factions/db";
import { factionMembers, factionVoteBallots, factionVotes, factions, players, successionClaims } from "@factions/db";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  FAILED_VOTE_COOLDOWN_MS, HOLDING_STATUSES, LEADER_SILENT_MS, SUCCESSION_WINDOW_MS, VOTE_LENGTH_MS, voteThreshold,
} from "@factions/domain";
import { gamertagOrId } from "./feed-actor";
import { noticeClanTx } from "./notices";

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Widened to a mutable array for drizzle's inArray(), the same way
// roster-store.ts does it. Both clocks below filter on it: a disbanded clan
// has no leadership left to settle.
const HOLDING: string[] = [...HOLDING_STATUSES];

/**
 * Close one open vote saying nothing: no cooldown, no notice. The shape
 * every silent close shares — `closeLeadershipSilentlyTx` and
 * `evaluateVoteTx`'s nominee-gone branch both go through here rather than
 * writing the same UPDATE twice with different follow-ups.
 */
async function closeVoteSilentlyTx(tx: Tx, voteId: number, at: Date): Promise<void> {
  await tx.update(factionVotes).set({ result: "failed", closedAt: at }).where(eq(factionVotes.id, voteId));
}

export type ClaimOutcome = "ok" | "not-member" | "is-leader" | "not-eligible" | "leader-active" | "claim-open";
export type OpenVoteOutcome =
  | "ok" | "passed" | "not-member" | "is-leader" | "nominee-not-member" | "nominee-is-leader" | "vote-open" | "cooldown";
export type CastOutcome = "ok" | "passed" | "no-vote" | "not-in-electorate" | "already-voted";
export type SuccessionEligibility = "eligible" | "is-leader" | "not-eligible" | "leader-active" | "claim-open";

export type OpenVote = {
  id: number;
  nomineeDayzId: string;
  nomineeGamertag: string;
  leaderGamertag: string;
  openedAt: Date;
  closesAt: Date;
  electorateSize: number;
  ballots: number;
  threshold: number;
  electorateDayzIds: string[];
};

export type OpenClaim = {
  id: number;
  claimantGamertag: string;
  leaderGamertag: string;
  openedAt: Date;
  resolvesAt: Date;
};

/**
 * ⚠️ Lock order (spec §4.12): `factions` FIRST, before `faction_members`,
 * `faction_votes`, `faction_vote_ballots` and `succession_claims`. Every
 * writer in this file — and `roster-store`'s `kick`/`leave`/`transfer`, which
 * now touch `faction_votes` through `applyElectorateLeaveTx`/`voteIsOpenTx` —
 * opens its transaction with this statement, so two writers on one clan
 * queue on the same row rather than grabbing the two tables in opposite
 * orders and deadlocking. Nothing here reads the row's columns; the lock IS
 * the point (the same reasoning as `transfer`'s own note).
 */
export async function lockFactionTx(tx: Tx, factionId: number): Promise<void> {
  await tx.execute(sql`select id from factions where id = ${factionId}::bigint for update`);
}

type MemberRow = { dayzId: string; discordId: string; serverId: number; role: string; status: string };

async function memberTx(tx: Tx, factionId: number, discordId: string): Promise<MemberRow | undefined> {
  const [m] = await tx.select({
    dayzId: factionMembers.dayzId, discordId: factionMembers.discordId,
    serverId: factionMembers.serverId, role: factionMembers.role, status: factionMembers.status,
  }).from(factionMembers).where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.discordId, discordId)));
  return m;
}

/**
 * The seated leader and how recently the log saw them.
 *
 * ⚠️ `leftJoin players` on purpose: a leader with NO `players` row has never
 * been seen at all, which is the most silent a leader can be. An inner join
 * would silently make them ineligible for succession forever (ruling 1).
 */
async function leaderTx(tx: Tx, factionId: number) {
  const [l] = await tx.select({
    dayzId: factionMembers.dayzId, discordId: factionMembers.discordId,
    serverId: factionMembers.serverId, lastSeenAt: players.lastSeenAt,
  })
    .from(factionMembers)
    .leftJoin(players, eq(players.dayzId, factionMembers.dayzId))
    .where(and(
      eq(factionMembers.factionId, factionId),
      eq(factionMembers.role, "leader"),
      eq(factionMembers.status, "full"),
    ));
  return l;
}

const leaderIsSilent = (lastSeenAt: Date | null, at: Date) =>
  lastSeenAt === null || lastSeenAt.getTime() < at.getTime() - LEADER_SILENT_MS;

async function openClaimIdTx(tx: Tx, factionId: number): Promise<number | undefined> {
  const [c] = await tx.select({ id: successionClaims.id }).from(successionClaims)
    .where(and(eq(successionClaims.factionId, factionId), isNull(successionClaims.closedAt)));
  return c?.id;
}

/** Full members of the clan, leader excluded — the electorate, and the officer test. */
async function fullMembersTx(tx: Tx, factionId: number) {
  return tx.select({ id: factionMembers.id, dayzId: factionMembers.dayzId, discordId: factionMembers.discordId, role: factionMembers.role })
    .from(factionMembers)
    .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.status, "full")))
    .orderBy(asc(factionMembers.id));
}

/**
 * Who may claim a silent leader's seat, without writing anything — the read
 * `/clan` uses to decide whether to show the button. `claimSuccessionDb`
 * re-runs every one of these checks under the clan's row lock; this one is
 * advisory and may be stale by the time the form posts.
 */
export async function successionEligibility(
  db: Database, factionId: number, dayzId: string, now: Date,
): Promise<SuccessionEligibility> {
  // In a transaction only so the roster, the claim and the leader's
  // last-seen stamp are read from ONE snapshot — a page that showed the
  // button because it read the roster before a claim landed and the claim
  // after would be advertising a write that is already refused. It writes
  // nothing and takes no row lock.
  return db.transaction(async (tx) => {
    const rows = await fullMembersTx(tx, factionId);
    const me = rows.find((r) => r.dayzId === dayzId);
    if (!me) return "not-eligible" as const;
    if (me.role === "leader") return "is-leader" as const;
    if ((await openClaimIdTx(tx, factionId)) !== undefined) return "claim-open" as const;

    const leader = await leaderTx(tx, factionId);
    if (!leader) return "not-eligible" as const;
    if (!leaderIsSilent(leader.lastSeenAt, now)) return "leader-active" as const;

    // The guide's rule: an officer outranks a member for the seat. Only when
    // the roster carries no officer at all may a member claim it.
    if (rows.some((r) => r.role === "officer") && me.role !== "officer") return "not-eligible" as const;
    return "eligible" as const;
  });
}

/**
 * Claim a silent leader's seat. Opens the SUCCESSION_WINDOW_MS window; the
 * tick (`resolveSuccessionClaims`) is what actually hands the seat over, or
 * voids the claim the moment the leader shows up.
 */
export async function claimSuccessionDb(
  db: Database, a: { factionId: number; claimantDiscordId: string; at: Date },
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, a.factionId);

    const me = await memberTx(tx, a.factionId, a.claimantDiscordId);
    if (!me || me.status !== "full") return "not-member" as const;
    if (me.role === "leader") return "is-leader" as const;

    // Before eligibility: a second claimant is told the seat is already
    // spoken for, whatever their own rank.
    if ((await openClaimIdTx(tx, a.factionId)) !== undefined) return "claim-open" as const;

    const leader = await leaderTx(tx, a.factionId);
    if (!leader) return "not-eligible" as const;
    if (!leaderIsSilent(leader.lastSeenAt, a.at)) return "leader-active" as const;

    const rows = await fullMembersTx(tx, a.factionId);
    if (rows.some((r) => r.role === "officer") && me.role !== "officer") return "not-eligible" as const;

    await tx.insert(successionClaims).values({
      factionId: a.factionId, serverId: me.serverId,
      claimantDayzId: me.dayzId, claimantDiscordId: me.discordId,
      leaderDayzId: leader.dayzId, leaderDiscordId: leader.discordId,
      openedAt: a.at, resolvesAt: new Date(a.at.getTime() + SUCCESSION_WINDOW_MS),
    });

    await noticeClanTx(tx, {
      serverId: me.serverId, factionId: a.factionId, kind: "succession_claimed", occurredAt: a.at,
      payload: { gamertag: await gamertagOrId(tx, me.discordId), leader: await gamertagOrId(tx, leader.discordId) },
    });

    return "ok" as const;
  });
}

/** The open claim on a clan, named for display. Null when there is none. */
export async function openClaimFor(db: Database, factionId: number): Promise<OpenClaim | null> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(successionClaims)
      .where(and(eq(successionClaims.factionId, factionId), isNull(successionClaims.closedAt)));
    if (!c) return null;
    return {
      id: c.id,
      claimantGamertag: await gamertagOrId(tx, c.claimantDiscordId),
      leaderGamertag: await gamertagOrId(tx, c.leaderDiscordId),
      openedAt: c.openedAt,
      resolvesAt: c.resolvesAt,
    };
  });
}

/**
 * The succession clock (spec §7). Open claims are read WITHOUT a lock and
 * then re-read `for update` inside a transaction of their own, one clan at a
 * time: a tick that took every clan's row in one transaction would hold the
 * whole set against every player-driven write for the length of the pass.
 */
export async function resolveSuccessionClaims(db: Database, now: Date): Promise<{ succeeded: number; voided: number }> {
  // ⚠️ Holding clans only. A disbanded clan's rows are closed silently by
  // `disbandFactionTx`, but the join is the belt to that braces: a row that
  // outlived its clan by any route must not crown a successor on a roster
  // that no longer exists, nor post a notice to a deleted channel.
  const open = await db.select({ id: successionClaims.id, factionId: successionClaims.factionId })
    .from(successionClaims)
    .innerJoin(factions, eq(factions.id, successionClaims.factionId))
    .where(and(isNull(successionClaims.closedAt), inArray(factions.status, HOLDING)))
    .orderBy(asc(successionClaims.id));

  let succeeded = 0;
  let voided = 0;
  for (const row of open) {
    const outcome = await db.transaction(async (tx) => {
      await lockFactionTx(tx, row.factionId);

      const [c] = await tx.select().from(successionClaims)
        .where(and(eq(successionClaims.id, row.id), isNull(successionClaims.closedAt))).for("update");
      if (!c) return null;

      const close = async (result: "succeeded" | "voided") => {
        await tx.update(successionClaims).set({ outcome: result, closedAt: now }).where(eq(successionClaims.id, c.id));
      };
      const voidIt = async () => {
        await close("voided");
        await noticeClanTx(tx, {
          serverId: c.serverId, factionId: c.factionId, kind: "succession_voided", occurredAt: now,
          payload: { leader: await gamertagOrId(tx, c.leaderDiscordId), claimant: await gamertagOrId(tx, c.claimantDiscordId) },
        });
        return "voided" as const;
      };

      const claimant = await memberTx(tx, c.factionId, c.claimantDiscordId);
      if (!claimant || claimant.status !== "full" || claimant.role === "leader") return voidIt();

      const leader = await leaderTx(tx, c.factionId);
      // The seat changed hands by some other route (transfer, a passed vote,
      // a guild removal): this claim is about a leader who no longer leads.
      if (!leader || leader.discordId !== c.leaderDiscordId) return voidIt();
      if (leader.lastSeenAt !== null && leader.lastSeenAt.getTime() > c.openedAt.getTime()) return voidIt();

      if (now.getTime() < c.resolvesAt.getTime()) return null;

      // Demote before promote: `faction_members_leader_uniq` permits exactly
      // one leader per clan, so the seat must be free before it is claimed.
      // A succession sends the absent leader to `member`, not `officer`.
      await tx.update(factionMembers).set({ role: "member" })
        .where(and(eq(factionMembers.factionId, c.factionId), eq(factionMembers.discordId, leader.discordId), eq(factionMembers.role, "leader")));
      await tx.update(factionMembers).set({ role: "leader" })
        .where(and(eq(factionMembers.factionId, c.factionId), eq(factionMembers.discordId, c.claimantDiscordId)));
      // Display provenance only — never an authority — but kept true, the
      // way `transfer` keeps it.
      await tx.update(factions).set({ leaderDiscordId: c.claimantDiscordId }).where(eq(factions.id, c.factionId));

      await close("succeeded");
      await noticeClanTx(tx, {
        serverId: c.serverId, factionId: c.factionId, kind: "succession_done", occurredAt: now,
        payload: { gamertag: await gamertagOrId(tx, c.claimantDiscordId) },
      });
      return "succeeded" as const;
    });

    if (outcome === "succeeded") succeeded += 1;
    if (outcome === "voided") voided += 1;
  }
  return { succeeded, voided };
}

/** True while this clan has a no-confidence vote open. The freeze reads this. */
export async function voteIsOpenTx(tx: Tx, factionId: number): Promise<boolean> {
  const [v] = await tx.select({ id: factionVotes.id }).from(factionVotes)
    .where(and(eq(factionVotes.factionId, factionId), isNull(factionVotes.closedAt)));
  return v !== undefined;
}

/**
 * Count the ballots and decide, inside the caller's transaction, which
 * already holds the clan's row.
 *
 * `expired` is the tick's flag and nothing else's (ruling 3): only
 * `closeExpiredVotes` may fail a vote for reaching `closes_at`. A ballot or a
 * departure evaluating the same vote a millisecond after it closed must leave
 * it open for the tick to close, or a player's own write would post
 * `vote_failed` at a moment nobody asked for.
 *
 * An electorate of zero fails on the spot whoever asks: the threshold is
 * unreachable, so there is nothing left to wait for (ruling 5).
 */
export async function evaluateVoteTx(
  tx: Tx, voteId: number, at: Date, expired = false,
): Promise<"open" | "passed" | "failed"> {
  const [v] = await tx.select().from(factionVotes)
    .where(and(eq(factionVotes.id, voteId), isNull(factionVotes.closedAt))).for("update");
  // Already closed by whoever held the clan's row before us. Nothing to do.
  if (!v) return "open";

  // ⚠️ BEFORE the count, and whatever the count says. A nominee who has left
  // the clan (or who is somehow the leader already) is nobody to crown, so
  // the question the vote asked no longer has an answer. It closes SILENTLY —
  // `result = 'failed'`, no cooldown, no notice — for the same reason
  // `closeLeadershipSilentlyTx` does: the clan never rejected anyone, so
  // barring them from voting again for FAILED_VOTE_COOLDOWN_MS, and
  // announcing a defeat that nobody voted for, would both be lies.
  const nominee = await memberTx(tx, v.factionId, v.nomineeDiscordId);
  if (!nominee || nominee.status !== "full" || nominee.role === "leader") {
    await closeVoteSilentlyTx(tx, v.id, at);
    return "failed";
  }

  const [b] = await tx.select({ n: sql<number>`count(*)::int` }).from(factionVoteBallots)
    .where(eq(factionVoteBallots.voteId, v.id));
  const ballots = b!.n;

  // The clan was asked and said no — the only close that stamps a cooldown
  // and posts a notice.
  const fail = async () => {
    const nextAllowed = new Date(at.getTime() + FAILED_VOTE_COOLDOWN_MS);
    await tx.update(factionVotes).set({ result: "failed", closedAt: at }).where(eq(factionVotes.id, v.id));
    await tx.update(factions).set({ nextVoteAllowedAt: nextAllowed }).where(eq(factions.id, v.factionId));
    await noticeClanTx(tx, {
      serverId: v.serverId, factionId: v.factionId, kind: "vote_failed", occurredAt: at,
      payload: { yes: ballots, n: v.electorateSize, date: nextAllowed.toISOString() },
    });
    return "failed" as const;
  };

  if (v.electorateSize > 0 && ballots >= voteThreshold(v.electorateSize)) {
    const leader = await leaderTx(tx, v.factionId);
    // No seated leader to unseat: another path (a succession, a guild
    // removal) already took the question away. Silent, for the same reason.
    if (!leader) {
      await closeVoteSilentlyTx(tx, v.id, at);
      return "failed";
    }

    // Demote-then-promote, one transaction: `faction_members_leader_uniq`
    // permits exactly one leader at a time. The ousted leader stays an
    // officer (spec §5.7) — unlike a succession, which sends them to member.
    await tx.update(factionMembers).set({ role: "officer" })
      .where(and(eq(factionMembers.factionId, v.factionId), eq(factionMembers.discordId, leader.discordId), eq(factionMembers.role, "leader")));
    await tx.update(factionMembers).set({ role: "leader" })
      .where(and(eq(factionMembers.factionId, v.factionId), eq(factionMembers.discordId, v.nomineeDiscordId)));
    await tx.update(factions).set({ leaderDiscordId: v.nomineeDiscordId }).where(eq(factions.id, v.factionId));

    await tx.update(factionVotes).set({ result: "passed", closedAt: at }).where(eq(factionVotes.id, v.id));
    await noticeClanTx(tx, {
      serverId: v.serverId, factionId: v.factionId, kind: "vote_passed", occurredAt: at,
      payload: {
        yes: ballots, n: v.electorateSize,
        nominee: await gamertagOrId(tx, v.nomineeDiscordId), old: await gamertagOrId(tx, leader.discordId),
      },
    });
    return "passed";
  }

  if (v.electorateSize === 0 || (expired && at.getTime() >= v.closesAt.getTime())) return fail();
  return "open";
}

/**
 * Open a no-confidence vote. The leader is not in the electorate and cannot
 * open one — they have `transfer` (ruling 4) — and the opener's nomination IS
 * their yes (ruling 3), which is why a two-person electorate can pass the
 * moment it opens.
 */
export async function openVoteDb(
  db: Database,
  a: { factionId: number; openerDiscordId: string; nomineeDiscordId: string; at: Date; siteBaseUrl: string },
): Promise<{ outcome: OpenVoteOutcome; voteId: number | null }> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, a.factionId);

    const opener = await memberTx(tx, a.factionId, a.openerDiscordId);
    if (!opener || opener.status !== "full") return { outcome: "not-member" as const, voteId: null };
    if (opener.role === "leader") return { outcome: "is-leader" as const, voteId: null };

    const nominee = await memberTx(tx, a.factionId, a.nomineeDiscordId);
    if (!nominee || nominee.status !== "full") return { outcome: "nominee-not-member" as const, voteId: null };
    if (nominee.role === "leader") return { outcome: "nominee-is-leader" as const, voteId: null };

    if (await voteIsOpenTx(tx, a.factionId)) return { outcome: "vote-open" as const, voteId: null };

    const [f] = await tx.select({ nextVoteAllowedAt: factions.nextVoteAllowedAt }).from(factions).where(eq(factions.id, a.factionId));
    if (f?.nextVoteAllowedAt && f.nextVoteAllowedAt.getTime() > a.at.getTime()) {
      return { outcome: "cooldown" as const, voteId: null };
    }

    const leader = await leaderTx(tx, a.factionId);
    // A clan with no seated leader has no no-confidence to express.
    if (!leader) return { outcome: "not-member" as const, voteId: null };

    const electorate = (await fullMembersTx(tx, a.factionId)).filter((m) => m.role !== "leader").map((m) => m.dayzId);

    const [v] = await tx.insert(factionVotes).values({
      factionId: a.factionId, serverId: opener.serverId,
      nomineeDayzId: nominee.dayzId, nomineeDiscordId: nominee.discordId,
      openedByDayzId: opener.dayzId,
      leaderDayzId: leader.dayzId, leaderDiscordId: leader.discordId,
      openedAt: a.at, closesAt: new Date(a.at.getTime() + VOTE_LENGTH_MS),
      electorateDayzIds: electorate, electorateSize: electorate.length,
    }).returning({ id: factionVotes.id });

    await tx.insert(factionVoteBallots).values({ voteId: v!.id, dayzId: opener.dayzId, castAt: a.at });

    const state = await evaluateVoteTx(tx, v!.id, a.at);
    // A vote that passed on its own nomination posts `vote_passed` (written
    // by evaluateVoteTx) and nothing else — announcing a vote that is
    // already over would read as an invitation to vote in it.
    if (state === "open") {
      await noticeClanTx(tx, {
        serverId: opener.serverId, factionId: a.factionId, kind: "vote_opened", occurredAt: a.at,
        payload: {
          leader: await gamertagOrId(tx, leader.discordId),
          nominee: await gamertagOrId(tx, nominee.discordId),
          closesAt: new Date(a.at.getTime() + VOTE_LENGTH_MS).toISOString(),
          link: `${a.siteBaseUrl}/clan`,
        },
      });
    }

    return { outcome: state === "passed" ? ("passed" as const) : ("ok" as const), voteId: v!.id };
  });
}

/** One yes. There is no "no" — a vote that never reaches its threshold fails at `closes_at`. */
export async function castVoteDb(
  db: Database, a: { factionId: number; voterDiscordId: string; at: Date },
): Promise<CastOutcome> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, a.factionId);

    const [v] = await tx.select({ id: factionVotes.id, electorateDayzIds: factionVotes.electorateDayzIds })
      .from(factionVotes).where(and(eq(factionVotes.factionId, a.factionId), isNull(factionVotes.closedAt)));
    if (!v) return "no-vote" as const;

    // The electorate is the frozen list, not today's roster: it already
    // excludes the leader and every pending member, and a member who joined
    // after the open is simply not on it (ruling 2).
    // ⚠️ `status = 'full'` as well as the frozen list (spec §4.5). The list
    // holds dayz ids, and a player who left and came back is a NEW, pending
    // row carrying the same id — the array alone would enfranchise them.
    const voter = await memberTx(tx, a.factionId, a.voterDiscordId);
    if (!voter || voter.status !== "full" || !v.electorateDayzIds.includes(voter.dayzId)) {
      return "not-in-electorate" as const;
    }

    const inserted = await tx.insert(factionVoteBallots)
      .values({ voteId: v.id, dayzId: voter.dayzId, castAt: a.at })
      .onConflictDoNothing({ target: [factionVoteBallots.voteId, factionVoteBallots.dayzId] })
      .returning({ id: factionVoteBallots.id });
    // The index decides, not a prior read: two connections casting the same
    // ballot cannot both be told "ok".
    if (!inserted[0]) return "already-voted" as const;

    return (await evaluateVoteTx(tx, v.id, a.at)) === "passed" ? ("passed" as const) : ("ok" as const);
  });
}

/** The open vote on a clan, with everything the page needs to render it. */
export async function openVoteFor(db: Database, factionId: number): Promise<OpenVote | null> {
  // One snapshot for the vote and its ballot count: read separately, a
  // ballot landing between the two renders "3 of 4" against a threshold the
  // vote has in fact already met.
  return db.transaction(async (tx) => {
    const [v] = await tx.select().from(factionVotes)
      .where(and(eq(factionVotes.factionId, factionId), isNull(factionVotes.closedAt)));
    if (!v) return null;
    const [b] = await tx.select({ n: sql<number>`count(*)::int` }).from(factionVoteBallots)
      .where(eq(factionVoteBallots.voteId, v.id));
    return {
      id: v.id,
      nomineeDayzId: v.nomineeDayzId,
      nomineeGamertag: await gamertagOrId(tx, v.nomineeDiscordId),
      leaderGamertag: await gamertagOrId(tx, v.leaderDiscordId),
      openedAt: v.openedAt,
      closesAt: v.closesAt,
      electorateSize: v.electorateSize,
      ballots: b!.n,
      threshold: voteThreshold(v.electorateSize),
      electorateDayzIds: v.electorateDayzIds,
    };
  });
}

/**
 * A member of the electorate has left the clan (leave, kick, guild removal).
 * Their slot goes with them and so does their ballot, so the threshold moves
 * DOWN — which can carry a vote that was one short. Called from inside
 * `leave`/`kick`'s own transaction, which already holds the clan's row.
 *
 * A no-op when there is no open vote or the leaver was never in the
 * electorate. Removing them from `electorate_dayz_ids` as well as
 * decrementing the size keeps the two in step and makes a second call for
 * the same player harmless.
 */
export async function applyElectorateLeaveTx(
  tx: Tx, a: { factionId: number; dayzId: string; at: Date },
): Promise<void> {
  const [v] = await tx.select({ id: factionVotes.id, electorateDayzIds: factionVotes.electorateDayzIds })
    .from(factionVotes)
    .where(and(eq(factionVotes.factionId, a.factionId), isNull(factionVotes.closedAt))).for("update");
  if (!v || !v.electorateDayzIds.includes(a.dayzId)) return;

  await tx.update(factionVotes).set({
    electorateDayzIds: sql`array_remove(${factionVotes.electorateDayzIds}, ${a.dayzId})`,
    electorateSize: sql`${factionVotes.electorateSize} - 1`,
  }).where(eq(factionVotes.id, v.id));

  await tx.delete(factionVoteBallots)
    .where(and(eq(factionVoteBallots.voteId, v.id), eq(factionVoteBallots.dayzId, a.dayzId)));

  await evaluateVoteTx(tx, v.id, a.at);
}

/**
 * The vote clock (spec §7). Same shape as `resolveSuccessionClaims`: an
 * unlocked read of what is due, then one transaction per vote.
 */
export async function closeExpiredVotes(db: Database, now: Date): Promise<{ passed: number; failed: number }> {
  // Holding clans only — see `resolveSuccessionClaims`'s note.
  const due = await db.select({ id: factionVotes.id, factionId: factionVotes.factionId })
    .from(factionVotes)
    .innerJoin(factions, eq(factions.id, factionVotes.factionId))
    .where(and(isNull(factionVotes.closedAt), lte(factionVotes.closesAt, now), inArray(factions.status, HOLDING)))
    .orderBy(asc(factionVotes.id));

  let passed = 0;
  let failed = 0;
  for (const row of due) {
    const state = await db.transaction(async (tx) => {
      await lockFactionTx(tx, row.factionId);
      return evaluateVoteTx(tx, row.id, now, true);
    });
    if (state === "passed") passed += 1;
    if (state === "failed") failed += 1;
  }
  return { passed, failed };
}

/**
 * Close whatever leadership business a clan has open, saying nothing.
 *
 * Used when the SUBJECT of that business has left the building — a leader
 * removed from the Discord (ruling 11). The claim was about their absence
 * and the vote was about their fitness; neither question survives them, so
 * the rows are closed with no cooldown and no notice. Called inside the
 * caller's transaction, which already holds the clan's row.
 */
export async function closeLeadershipSilentlyTx(tx: Tx, factionId: number, at: Date): Promise<void> {
  await tx.update(successionClaims).set({ outcome: "voided", closedAt: at })
    .where(and(eq(successionClaims.factionId, factionId), isNull(successionClaims.closedAt)));
  const [v] = await tx.select({ id: factionVotes.id }).from(factionVotes)
    .where(and(eq(factionVotes.factionId, factionId), isNull(factionVotes.closedAt)));
  if (v) await closeVoteSilentlyTx(tx, v.id, at);
}
