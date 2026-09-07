import type { Database } from "@factions/db";
import { declarations, factions, factionInvites, factionMembers, identityLinks, players, rosterCooldowns, servers } from "@factions/db";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { CLAN_SIZE_CAP, HOLDING_STATUSES, type MemberStatus } from "@factions/domain";
import { appendFactionEventTx } from "./feed-store";
import { actorGamertagTx, gamertagOrId } from "./feed-actor";
import { noticeClanTx, noticeUserTx } from "./notices";
import { releaseTx } from "@factions/declarations";
import { identityTakenTx, lockIdentity, writeHoldsTx } from "./holds";
import { applyElectorateLeaveTx, closeLeadershipSilentlyTx, lockFactionTx, voteIsOpenTx } from "./leadership-store";

// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

export type Role = "leader" | "officer" | "member";

export type Membership = {
  factionId: number; serverId: number; serverName: string;
  factionName: string; tag: string; role: Role; status: MemberStatus;
};

export type RosterEntry = {
  dayzId: string; discordId: string; gamertag: string | null; role: Role; joinedAt: Date; status: MemberStatus;
};

export type FactionCard = {
  id: number; serverId: number; serverName: string;
  name: string; tag: string; texture: string; status: string;
  /**
   * Null when the clan holds no declaration — a reservation that has not yet
   * claimed a pole, or a clan whose pole was released. The binding lives in
   * `declarations`, not on the faction row, so it is legitimately absent.
   */
  poleKey: string | null;
  memberCount: number; pendingCount: number; leaderDiscordId: string; createdAt: Date;
};

/**
 * "Full" is what a plain membership read means everywhere except uniqueness
 * and the `/unlink` refusal (spec §4.5): a member has been SEEN AT THE BASE
 * since accepting their invite, not merely rostered. Exported so other
 * writers — `rebind-store`'s roster-membership subquery, the dormancy
 * clock's `LAST_RAISE` — filter on the same predicate rather than a second
 * one that could drift from it.
 */
export const FULL_MEMBER = sql`${factionMembers.status} = 'full'`;

export type CreateInviteArgs = {
  factionId: number; serverId: number;
  inviteeDiscordId: string; inviteeDayzId: string; invitedByDiscordId: string;
  at: Date; expiresAt: Date;
  /** For the `invited` DM's `link` — the site's own base URL. See `inviteDb`, which supplies it from `siteBaseUrl()`. */
  siteBaseUrl: string;
};
export type CreateInviteOutcome = "ok" | "not-permitted" | "already-member" | "cooldown" | "not-holding" | "cap";
export type PendingInvite = {
  id: number; factionId: number; factionName: string; tag: string;
  serverId: number; serverName: string; expiresAt: Date;
};
export type AcceptInviteOutcome = "ok" | "gone" | "already-member" | "cooldown" | "not-holding" | "link-changed" | "cap";
export type KickArgs = { factionId: number; actorDiscordId: string; targetDiscordId: string; at: Date; until: Date };
export type KickOutcome = "ok" | "not-permitted" | "target-not-member" | "cannot-kick-self" | "cannot-kick-officer" | "cannot-kick-leader" | "vote-open";
export type LeaveArgs = { factionId: number; discordId: string; at: Date; until: Date };
export type LeaveOutcome = "ok" | "not-member" | "leader-must-transfer";
export type SetRoleArgs = {
  factionId: number; actorDiscordId: string; targetDiscordId: string; role: "officer" | "member";
  /**
   * The notice's `occurredAt`. Optional because neither current caller
   * (`writes.ts`'s `promoteDb`/`demoteDb`) has a timestamp to hand in —
   * unlike every other write in this file, which threads one through from a
   * `now` its own caller already carries. Defaults to `new Date()` so this
   * row's timestamp is still close to real time; pass one explicitly once a
   * caller has one to give.
   */
  at?: Date;
};
export type SetRoleOutcome = "ok" | "not-leader" | "target-not-member" | "cannot-target-leader";
export type TransferArgs = { factionId: number; fromDiscordId: string; toDiscordId: string; at: Date };
export type TransferOutcome = "ok" | "not-leader" | "target-not-member" | "vote-open";
export type RenameArgs = { factionId: number; discordId: string; name: string; tag?: string; at: Date; notBefore: Date };
export type RenameOutcome = "ok" | "not-leader" | "cooldown" | "name-taken" | "tag-taken" | "name-held" | "tag-held" | "unchanged";

export interface RosterStore {
  // Reads (Task 3)
  membershipsFor(discordId: string): Promise<Membership[]>;
  linkFor(discordId: string): Promise<{ dayzId: string; gamertag: string } | null>;
  linkForDayzId(dayzId: string): Promise<{ discordId: string; gamertag: string } | null>;
  memberOf(factionId: number, discordId: string): Promise<{ dayzId: string; role: Role } | null>;
  rosterOf(factionId: number): Promise<RosterEntry[]>;
  factionById(factionId: number): Promise<FactionCard | null>;
  factionByName(name: string, serverId?: number | null): Promise<FactionCard | null>;
  cooldownUntil(serverId: number, dayzId: string): Promise<Date | null>;

  // Writes (Tasks 4-7)
  createInvite(a: CreateInviteArgs): Promise<{ outcome: CreateInviteOutcome; inviteId: number | null }>;
  pendingInvitesFor(dayzId: string, at: Date): Promise<PendingInvite[]>;
  acceptInvite(inviteId: number, discordId: string, at: Date): Promise<AcceptInviteOutcome>;
  declineInvite(inviteId: number, discordId: string, at: Date): Promise<boolean>;
  kick(a: KickArgs): Promise<KickOutcome>;
  leave(a: LeaveArgs): Promise<LeaveOutcome>;
  setRole(a: SetRoleArgs): Promise<SetRoleOutcome>;
  transfer(a: TransferArgs): Promise<TransferOutcome>;
  disband(factionId: number, discordId: string): Promise<"ok" | "not-leader">;
  rename(a: RenameArgs): Promise<RenameOutcome>;
  revokeInvite(a: { inviteId: number; factionId: number; actorDiscordId: string; at: Date }): Promise<"ok" | "not-permitted" | "gone">;
  invitesOut(factionId: number, at: Date): Promise<(PendingInvite & { inviteeDiscordId: string; inviteeGamertag: string | null })[]>;
  setRecruitingPost(a: { factionId: number; actorDiscordId: string; recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }): Promise<"ok" | "not-permitted">;
}

// Leader, then officer, then member — matches the ordering rosterOf promises.
const ROLE_ORDER = sql<number>`case ${factionMembers.role} when 'leader' then 0 when 'officer' then 1 else 2 end`;

// Full before pending, within a role tier — 'full' < 'pending' alphabetically
// is not the order we want, so this is explicit rather than a plain desc().
const STATUS_ORDER = sql<number>`case ${factionMembers.status} when 'full' then 0 else 1 end`;

/**
 * Thrown from inside `acceptInvite`'s transaction to abort it with a
 * non-"ok" outcome.
 *
 * ⚠️ A bare early `return` from a Drizzle transaction callback COMMITS the
 * transaction — it does not roll back. Returning "cooldown" or "link-changed"
 * directly, after the invite row was already updated to `accepted_at = now`,
 * would consume the invite while adding no member: the player permanently
 * loses the offer and gains nothing, with no error anywhere. Throwing here
 * instead makes Drizzle roll the whole transaction back, and the catch below
 * translates the sentinel back into the outcome the caller expects.
 *
 * A `return` is only safe for an outcome decided before the claim UPDATE
 * runs — "gone" and "not-holding" both are.
 */
class RosterAbort extends Error {
  constructor(public readonly outcome: string) {
    super(`roster-abort:${outcome}`);
  }
}

/**
 * The actor currently holds the `leader` seat on this faction's roster.
 *
 * ⚠️ `faction_members.role = 'leader'` is the SINGLE AUTHORITY for every
 * leader-only permission. `factions.leader_discord_id` is DISPLAY PROVENANCE
 * ONLY — `FactionCard` exposes it and `/faction info` prints it, and
 * `transfer()` keeps it current, but nothing may ever authorise on it. It is
 * a denormalised copy and copies drift; the roster row is the one
 * `faction_members_leader_uniq` actually protects, so it cannot. Guarding
 * `disband`/`rename` on the copy is exactly how a demoted ex-leader kept the
 * power to destroy a faction they no longer led.
 *
 * A correlated subquery, not a pre-read: the check rides inside the
 * statement's own WHERE, the way `kick`'s does.
 *
 * Exported so `rebind-store.ts` guards on the same authority rather than
 * writing a second leader check that could drift from this one.
 */
export const leaderIs = (factionId: number, discordId: string) =>
  sql`(select role from faction_members where faction_id = ${factionId} and discord_id = ${discordId} and status = 'full') = 'leader'`;

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Roster slots in use — BOTH statuses (spec §4.5): a pending member still
 * occupies a slot. Every cap check (invite, accept, request decision) runs
 * this as its own statement AFTER the faction row lock, so a resumed lock
 * waiter counts against a fresh snapshot rather than the one its lock
 * statement started with.
 */
export async function countMembersTx(tx: Tx, factionId: number): Promise<number> {
  const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(factionMembers)
    .where(eq(factionMembers.factionId, factionId));
  return n!.n;
}

/**
 * Everything disbanding a faction does, minus who is allowed to do it.
 *
 * ⚠️ Shared with the dormancy tick's auto-disband rather than reimplemented.
 * The status write is the least of it: membership rows left behind point at a
 * disbanded faction, invisible to their owners because the membership lookup
 * filters on HOLDING_STATUSES, yet still able to collide with
 * `faction_members_server_player_uniq` when those players join elsewhere.
 *
 * ⚠️ Lock order (spec §4.12): `factions`, then `declarations`, then
 * `faction_members`, then `faction_invites`. Inbox item 19 records a
 * deadlock built out of two separately-correct changes taking two of these
 * tables in opposite orders. Any new writer to this set follows this order —
 * which is why the pole release below runs BEFORE the roster delete, not
 * after: `declarations` sits between `factions` and `faction_members` in the
 * order, and `releaseTx` itself takes `declarations` then `poles`.
 *
 * `guard` is the caller's authority to do it — a leader check for
 * `/faction disband`, a dormancy-window check for the tick.
 *
 * One transaction, five writes: the status update (carrying `guard` and a
 * holding-status check), then the identity holds, then the pole release,
 * then the roster delete, then the outstanding invite revocation. §6 is
 * explicit that disbanding is not betrayal — no cooldown is written for
 * anyone, unlike `kick`/`leave`.
 *
 * The status update must land first and the rest must be conditioned on
 * it succeeding: a bare `return false` after the update fails writes
 * nothing, so that path is safe to return from directly. There is no
 * non-boolean outcome to unwind here, so `RosterAbort` never comes into play
 * — unlike `acceptInvite`, this function has nothing left to report once the
 * update has matched a row.
 */
export async function disbandFactionTx(tx: Tx, factionId: number, guard: SQL): Promise<boolean> {
  const [updated] = await tx.update(factions)
    .set({ status: "disbanded" })
    .where(and(eq(factions.id, factionId), guard, inArray(factions.status, HOLDING)))
    .returning({
      id: factions.id, serverId: factions.serverId,
      name: factions.name, tag: factions.tag, texture: factions.texture,
    });

  if (!updated) return false;

  // Holds first (guide ch. 8: "so nobody can impersonate you") — before the
  // release and the roster delete, per this function's own docblock. Nothing
  // else references `identity_holds`, so it needs no place in the §4.12 lock
  // order beyond "after factions".
  await writeHoldsTx(tx, { serverId: updated.serverId, factionId: updated.id, name: updated.name, tag: updated.tag, reason: "disbanded" });

  // Guide ch. 8: the base goes public after its 3-day grace. Released here,
  // before the roster delete, per the lock order above (declarations comes
  // between factions and faction_members) — not because releaseTx itself
  // reads the roster.
  await releaseTx(tx, { factionId }, new Date());

  await tx.delete(factionMembers).where(eq(factionMembers.factionId, factionId));

  // Outstanding offers die with the faction, for the reason spelled out
  // on `pendingInvitesFor`.
  await tx.update(factionInvites)
    .set({ revokedAt: sql`now()` })
    .where(and(
      eq(factionInvites.factionId, factionId),
      isNull(factionInvites.acceptedAt),
      isNull(factionInvites.declinedAt),
      isNull(factionInvites.revokedAt),
    ));

  // Open leadership business dies with the clan, and it dies SILENTLY: there
  // is no seat left to succeed to and no leader left to depose, so a
  // `succession_voided`/`vote_failed` notice would post to a channel that is
  // about to be deleted, and a cooldown would be stamped on a clan that can
  // never vote again. Placed here, after `faction_invites` and before
  // `faction_events`, because that is where `faction_votes` →
  // `faction_vote_ballots` → `succession_claims` sit in the §4.12 order.
  await closeLeadershipSilentlyTx(tx, factionId, new Date());

  // ⚠️ Last, per the lock order this function documents. Identity is frozen
  // here because by the time the post goes out the flag, tag and pole are
  // back in the pool and may already belong to somebody else.
  //
  // ⚠️ In the SHARED function, not in its two callers. `/faction disband` and
  // the dormancy tick's auto-disband both ride this; logging in one caller
  // is how one path announces and the other goes silent.
  await appendFactionEventTx(tx, {
    serverId: updated.serverId, factionId: updated.id, kind: "disbanded",
    occurredAt: new Date(),
    payload: { name: updated.name, tag: updated.tag, texture: updated.texture },
  });

  return true;
}

export class PgRosterStore implements RosterStore {
  constructor(private readonly db: Database) {}

  /**
   * Any status — the bot's `/faction leave` and the site's pending banner
   * both need to see a pending row, not just a full member's.
   */
  async membershipsFor(discordId: string): Promise<Membership[]> {
    const rows = await this.db.select({
      factionId: factions.id,
      serverId: factions.serverId,
      serverName: servers.name,
      factionName: factions.name,
      tag: factions.tag,
      role: factionMembers.role,
      status: factionMembers.status,
    }).from(factionMembers)
      .innerJoin(factions, eq(factionMembers.factionId, factions.id))
      .innerJoin(servers, eq(factions.serverId, servers.id))
      .where(and(
        eq(factionMembers.discordId, discordId),
        inArray(factions.status, HOLDING),
      ))
      .orderBy(asc(servers.name));
    return rows.map((r) => ({ ...r, role: r.role as Role, status: r.status as MemberStatus }));
  }

  async linkFor(discordId: string): Promise<{ dayzId: string; gamertag: string } | null> {
    const [row] = await this.db.select({
      dayzId: identityLinks.dayzId,
      gamertag: identityLinks.gamertag,
    }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
    return row ?? null;
  }

  async linkForDayzId(dayzId: string): Promise<{ discordId: string; gamertag: string } | null> {
    const [row] = await this.db.select({
      discordId: identityLinks.discordId,
      gamertag: identityLinks.gamertag,
    }).from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
    return row ?? null;
  }

  async memberOf(factionId: number, discordId: string): Promise<{ dayzId: string; role: Role } | null> {
    const [row] = await this.db.select({
      dayzId: factionMembers.dayzId,
      role: factionMembers.role,
    }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.discordId, discordId)));
    return row ? { dayzId: row.dayzId, role: row.role as Role } : null;
  }

  /**
   * Left-joined to `identity_links`, not inner-joined: `/unlink` can remove a
   * link, and the roster must still render that member with a null gamertag
   * rather than silently dropping them.
   */
  async rosterOf(factionId: number): Promise<RosterEntry[]> {
    const rows = await this.db.select({
      dayzId: factionMembers.dayzId,
      discordId: factionMembers.discordId,
      gamertag: identityLinks.gamertag,
      role: factionMembers.role,
      status: factionMembers.status,
      joinedAt: factionMembers.joinedAt,
    }).from(factionMembers)
      .leftJoin(identityLinks, eq(identityLinks.dayzId, factionMembers.dayzId))
      .where(eq(factionMembers.factionId, factionId))
      // Full members before pending ones, matching ROLE_ORDER's leader-first
      // shape — a pending member sits at the bottom of their role tier.
      .orderBy(ROLE_ORDER, STATUS_ORDER, asc(factionMembers.joinedAt));
    return rows.map((r) => ({ ...r, gamertag: r.gamertag ?? null, role: r.role as Role, status: r.status as MemberStatus }));
  }

  async factionById(factionId: number): Promise<FactionCard | null> {
    return this.factionCard(eq(factions.id, factionId));
  }

  /**
   * Scoped to a server when one is given: faction names are unique per
   * server, not globally, so `/faction info name:Bears server:2` must not be
   * answered with server 1's Bears. Without a server the first match stands,
   * which is what an unqualified lookup can honestly promise.
   */
  async factionByName(name: string, serverId?: number | null): Promise<FactionCard | null> {
    const byName = eq(sql`lower(${factions.name})`, name.toLowerCase());
    return this.factionCard(
      serverId == null ? byName : and(byName, eq(factions.serverId, serverId))!,
    );
  }

  private async factionCard(where: ReturnType<typeof eq>): Promise<FactionCard | null> {
    const [row] = await this.db.select({
      id: factions.id,
      serverId: factions.serverId,
      serverName: servers.name,
      name: factions.name,
      tag: factions.tag,
      texture: factions.texture,
      status: factions.status,
      poleKey: declarations.poleKey,
      leaderDiscordId: factions.leaderDiscordId,
      createdAt: factions.createdAt,
      memberCount: sql<number>`count(*) filter (where ${factionMembers.status} = 'full')`,
      pendingCount: sql<number>`count(*) filter (where ${factionMembers.status} = 'pending')`,
    }).from(factions)
      .innerJoin(servers, eq(factions.serverId, servers.id))
      .leftJoin(factionMembers, eq(factionMembers.factionId, factions.id))
      // LEFT, not INNER: a clan with no declaration (a fresh reservation, or
      // one whose pole was released) must still have a card to show. An inner
      // join would make `/faction info` answer "no such clan" for a clan that
      // plainly exists.
      .leftJoin(declarations, eq(declarations.ownerFactionId, factions.id))
      .where(where)
      .groupBy(factions.id, servers.name, declarations.poleKey);
    if (!row) return null;
    return { ...row, memberCount: Number(row.memberCount), pendingCount: Number(row.pendingCount) };
  }

  /**
   * The `until` instant only when it is still in the future — an expired row
   * returns null, so no caller ever compares dates itself.
   */
  async cooldownUntil(serverId: number, dayzId: string): Promise<Date | null> {
    const [row] = await this.db.select({ until: rosterCooldowns.until })
      .from(rosterCooldowns)
      .where(and(
        eq(rosterCooldowns.serverId, serverId),
        eq(rosterCooldowns.dayzId, dayzId),
        gt(rosterCooldowns.until, new Date()),
      ));
    return row?.until ?? null;
  }

  /**
   * Upserts on the pending index rather than inserting blindly: the index
   * has no expiry term (a partial index predicate must be IMMUTABLE, and
   * `now()` is not), so a lapsed offer still occupies the slot. Re-inviting
   * someone whose earlier offer expired must REFRESH that row, not collide
   * with it.
   *
   * The faction-holding, already-member and cooldown reads are advisory —
   * they let us report a precise reason here. They are not the binding
   * checks; `acceptInvite` re-checks everything that matters at write time,
   * because the truth can change between this call and that one.
   */
  async createInvite(a: CreateInviteArgs): Promise<{ outcome: CreateInviteOutcome; inviteId: number | null }> {
    return this.db.transaction(async (tx) => {
      const [f] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag }).from(factions)
        .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING)));
      if (!f) return { outcome: "not-holding" as const, inviteId: null };

      const [existing] = await tx.select({ id: factionMembers.id }).from(factionMembers)
        .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.inviteeDayzId)));
      if (existing) return { outcome: "already-member" as const, inviteId: null };

      const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, a.serverId), eq(rosterCooldowns.dayzId, a.inviteeDayzId)));
      if (cd && cd.until > a.at) return { outcome: "cooldown" as const, inviteId: null };

      // Advisory, like the checks above — the binding check is in
      // `acceptInvite`, which re-counts at write time. The cap counts BOTH
      // statuses (spec §4.5): a pending member still occupies a roster slot.
      if ((await countMembersTx(tx, a.factionId)) >= CLAN_SIZE_CAP) return { outcome: "cap" as const, inviteId: null };

      // ⚠️ The actor's leader-or-officer check rides in this statement, not in
      // the handler — §5: every write carries its own guard. A pre-read here
      // would let an officer racing their own demotion still issue the
      // invite. INSERT ... SELECT is what gives an INSERT a WHERE; the
      // ON CONFLICT arm inherits it, so a demoted actor cannot refresh an
      // existing offer either. Zero rows means the actor may not invite.
      const rows = await tx.execute(sql`
        insert into faction_invites
          (faction_id, server_id, invitee_discord_id, invitee_dayz_id, invited_by_discord_id, created_at, expires_at)
        select ${a.factionId}::bigint, ${a.serverId}::integer,
               ${a.inviteeDiscordId}::text, ${a.inviteeDayzId}::text, ${a.invitedByDiscordId}::text,
               ${a.at.toISOString()}::timestamptz, ${a.expiresAt.toISOString()}::timestamptz
        where (select role from faction_members
               where faction_id = ${a.factionId}::bigint and discord_id = ${a.invitedByDiscordId}::text and status = 'full')
              in ('leader', 'officer')
        on conflict (faction_id, invitee_dayz_id)
          where accepted_at is null and declined_at is null and revoked_at is null
        do update set expires_at = excluded.expires_at,
                      created_at = excluded.created_at,
                      invited_by_discord_id = excluded.invited_by_discord_id
        returning id
      `);
      const row = (rows as unknown as { id: string | number }[])[0];
      if (!row) return { outcome: "not-permitted" as const, inviteId: null };

      await noticeUserTx(tx, {
        serverId: a.serverId, factionId: a.factionId, discordId: a.inviteeDiscordId,
        kind: "invited", occurredAt: a.at,
        payload: { clan: f.name, tag: f.tag, link: `${a.siteBaseUrl}/me` },
      });

      return { outcome: "ok" as const, inviteId: Number(row.id) };
    });
  }

  /**
   * Invites still open and not yet expired, soonest-expiring first.
   *
   * Filtered to a HOLDING faction: an invite to a disbanded or lapsed one can
   * only ever answer "that faction is no longer active", and since the
   * listing is capped at `MAX_LISTED_INVITES` a dead offer would push a live
   * one off the end. `disband()` and `lapseReservations()` revoke outstanding
   * invites too; this filter is what covers a faction that went dormant or
   * was released by a path that did not.
   */
  async pendingInvitesFor(dayzId: string, at: Date): Promise<PendingInvite[]> {
    const rows = await this.db.select({
      id: factionInvites.id,
      factionId: factionInvites.factionId,
      factionName: factions.name,
      tag: factions.tag,
      serverId: factionInvites.serverId,
      serverName: servers.name,
      expiresAt: factionInvites.expiresAt,
    }).from(factionInvites)
      .innerJoin(factions, eq(factionInvites.factionId, factions.id))
      .innerJoin(servers, eq(factionInvites.serverId, servers.id))
      .where(and(
        eq(factionInvites.inviteeDayzId, dayzId),
        isNull(factionInvites.acceptedAt),
        isNull(factionInvites.declinedAt),
        isNull(factionInvites.revokedAt),
        gt(factionInvites.expiresAt, at),
        inArray(factions.status, HOLDING),
      ))
      .orderBy(asc(factionInvites.expiresAt));
    return rows;
  }

  /**
   * Every precondition is part of the write, not a pre-check followed by an
   * unconditional write: the invite id travels in a Discord button custom
   * id, which is guessable, so the invitee-match clause below is a security
   * guard, not a convenience — without it anyone who can guess an id could
   * join a faction they were never offered.
   *
   * The faction-holding check runs BEFORE the invite is claimed — see the
   * lock-order note on the `FOR UPDATE` below, which is what keeps this path
   * from deadlocking against `disband`/`lapseReservations`. Everything after
   * the claim (the cooldown floor, the identity-link equality) must abort via
   * `throw`, not `return`, or the claim just made would commit with no
   * membership row to show for it. See `RosterAbort`.
   */
  async acceptInvite(inviteId: number, discordId: string, at: Date): Promise<AcceptInviteOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        // Which faction row to lock. Unlocked, and it decides nothing: the
        // claim UPDATE below carries the same faction id in its own WHERE, so
        // an invite that somehow moved between the two yields zero rows and
        // "gone". A plain SELECT takes no ROW lock, so this read is not part
        // of any lock cycle.
        const [target] = await tx.select({ factionId: factionInvites.factionId })
          .from(factionInvites).where(eq(factionInvites.id, inviteId));
        if (!target) return "gone" as const;

        // ⚠️ `FOR UPDATE`, not a plain read (and not `FOR SHARE` — see
        // below), and it must come BEFORE the claim UPDATE. Three separate
        // reasons, all load-bearing:
        //
        // 1. An unlocked SELECT is not a check at all under READ COMMITTED.
        //    `disband()` and `lapseReservations()` both UPDATE this row and
        //    then DELETE the roster, and that DELETE cannot see the
        //    membership row this transaction has not inserted yet. Read
        //    status, watch a disband commit in the gap, insert anyway — and
        //    the row outlives its faction. `faction_members_server_player_uniq`
        //    has no status predicate, so that row then bars the player from
        //    every future faction on the server and NO command can clear it
        //    (§4.1). The row lock makes both writers wait for this
        //    transaction instead, so their DELETE always runs after this
        //    INSERT.
        //
        // 2. LOCK ORDER: `factions` before `faction_invites`. Both writers
        //    update the faction row FIRST and only then revoke its
        //    outstanding invites. Claiming the invite before taking this lock
        //    closes a cycle — this transaction holding the invite row and
        //    waiting on the faction row, the writer holding the faction row
        //    and waiting on the invite row — and Postgres resolves that by
        //    aborting one side with 40P01, surfacing as a raw error to a
        //    player who merely pressed Accept. Acquiring in the same order as
        //    the writers makes the deadlock impossible rather than rare.
        //
        // 3. `FOR UPDATE`, not `FOR SHARE`: the cap count just below must be
        //    serialized against a CONCURRENT accept for the SAME faction, not
        //    just against disband/lapse. Two accepts both holding a shared
        //    lock can both read the same count, both pass the cap check, and
        //    both insert — overshooting CLAN_SIZE_CAP. An exclusive lock on
        //    this row makes the second accept block here until the first has
        //    committed its insert (or rolled back), so the second one's count
        //    always sees the first one's member.
        //
        // Nothing has been written at this point, which is why "not-holding"
        // can return directly instead of needing a `RosterAbort`.
        const [f] = await tx.select({ id: factions.id }).from(factions)
          .where(and(eq(factions.id, target.factionId), inArray(factions.status, HOLDING)))
          .for("update");
        if (!f) return "not-holding" as const;

        // Nothing has been written yet on this path — a bare return is safe,
        // same reasoning as "not-holding" above. Both statuses count (spec
        // §4.5): a pending member still occupies a roster slot.
        if ((await countMembersTx(tx, target.factionId)) >= CLAN_SIZE_CAP) return "cap" as const;

        const claimed = await tx.update(factionInvites)
          .set({ acceptedAt: at })
          .where(and(
            eq(factionInvites.id, inviteId),
            eq(factionInvites.factionId, target.factionId),
            eq(factionInvites.inviteeDiscordId, discordId),
            isNull(factionInvites.acceptedAt),
            isNull(factionInvites.declinedAt),
            isNull(factionInvites.revokedAt),
            gt(factionInvites.expiresAt, at),
          ))
          .returning();
        const inv = claimed[0];
        if (!inv) return "gone" as const;

        const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
          .where(and(eq(rosterCooldowns.serverId, inv.serverId), eq(rosterCooldowns.dayzId, inv.inviteeDayzId)));
        if (cd && cd.until > at) throw new RosterAbort("cooldown");

        // ⚠️ INSERT ... SELECT, not VALUES: the UID comes from the accepter's
        // CURRENT `identity_links` row and the invite's stored UID has to
        // agree with it. A player who unlinks and relinks a different
        // character between invite and accept would otherwise be rostered
        // under a UID they no longer own — misattributed raid credit (§7),
        // and, because this table's uniqueness and the cooldown key on
        // `dayz_id` while `membershipsFor` keys on `discord_id`, a second
        // membership row for one Discord user on one server, after which
        // `resolveServerContext` silently picks whichever came first.
        // Zero rows means the link moved (or is gone); roll the claim back.
        const inserted = await tx.execute(sql`
          insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at, status, pending_since)
          select ${inv.factionId}::bigint, ${inv.serverId}::integer, il.dayz_id, ${discordId}::text, 'member', ${at.toISOString()}::timestamptz,
                 'pending', ${at.toISOString()}::timestamptz
          from identity_links il
          where il.discord_id = ${discordId} and il.dayz_id = ${inv.inviteeDayzId}
          returning id
        `);
        if ((inserted as unknown as unknown[]).length === 0) throw new RosterAbort("link-changed");

        await noticeClanTx(tx, {
          serverId: inv.serverId, factionId: inv.factionId, kind: "joined", occurredAt: at,
          payload: { gamertag: await gamertagOrId(tx, discordId) },
        });

        return "ok" as const;
      });
    } catch (err) {
      if (err instanceof RosterAbort) return err.outcome as AcceptInviteOutcome;
      if (String(err).includes("faction_members_server_player_uniq")) return "already-member";
      throw err;
    }
  }

  /**
   * No expiry gate: declining a lapsed offer is still a legitimate way to
   * close it out, and an expired-but-undeclined row would otherwise linger
   * forever with no harm done by letting the invitee dismiss it.
   */
  async declineInvite(inviteId: number, discordId: string, at: Date): Promise<boolean> {
    const rows = await this.db.update(factionInvites)
      .set({ declinedAt: at })
      .where(and(
        eq(factionInvites.id, inviteId),
        eq(factionInvites.inviteeDiscordId, discordId),
        isNull(factionInvites.acceptedAt),
        isNull(factionInvites.declinedAt),
        isNull(factionInvites.revokedAt),
      ))
      .returning({ id: factionInvites.id });
    return rows.length > 0;
  }

  /**
   * Every non-"ok" outcome here is decided by reads alone, before any write
   * happens — self-kick, missing target, insufficient role, and the two
   * untouchable-target cases all return directly with nothing to roll back.
   * Only the success path writes (the delete and the cooldown upsert), so
   * `RosterAbort` is not needed here: there is no committed side effect to
   * undo on the way to a non-"ok" outcome.
   *
   * Target-leader is checked before officer-vs-officer so an officer trying
   * to kick the leader gets "cannot-kick-leader", not "cannot-kick-officer"
   * — the leader is untouchable regardless of who is doing the kicking.
   */
  /**
   * The permission logic lives entirely inside the DELETE's own WHERE — a
   * correlated subquery for the actor's *current* role, plus the target-role
   * exclusions — so the outcome is decided from `.returning()`, exactly like
   * `leave` below. Nothing here pre-reads roles and then acts on a stale
   * belief about them.
   *
   * ⚠️ A version that instead pre-read the actor's and target's roles,
   * decided the outcome from that read, and then ran the delete
   * unconditionally (or only guarded by `role <> 'leader'`, without
   * checking how many rows it actually removed) has a real TOCTOU gap: if
   * the target's role changes between the read and the delete — a
   * concurrent leadership transfer, say — the delete can match zero rows
   * while the code still reports "ok" and still writes the cooldown. The
   * row count from `.returning()` is the only trustworthy source for the
   * decision; the follow-up read below runs only on zero rows, and only to
   * choose which failure message to show — it decides nothing.
   */
  async kick(a: KickArgs): Promise<KickOutcome> {
    if (a.actorDiscordId === a.targetDiscordId) return "cannot-kick-self";

    return this.db.transaction(async (tx) => {
      // ⚠️ FIRST statement of the transaction. `kick` now touches
      // `faction_votes` (the freeze below, and the electorate decrement
      // after the delete), so it must take `factions` before
      // `faction_members` like every other writer that spans the two — see
      // `transfer`'s note on spec §4.12.
      await lockFactionTx(tx, a.factionId);

      // §5.7: the roster freezes while a no-confidence vote is open. A
      // leader who could kick the electorate could win any vote, so this is
      // enforced in the store, never in a page.
      if (await voteIsOpenTx(tx, a.factionId)) return "vote-open" as const;

      const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;

      const deleted = await tx.delete(factionMembers)
        .where(and(
          eq(factionMembers.factionId, a.factionId),
          eq(factionMembers.discordId, a.targetDiscordId),
          ne(factionMembers.role, "leader"),
          sql`${actorRole} in ('leader', 'officer')`,
          sql`not (${actorRole} = 'officer' and ${factionMembers.role} = 'officer')`,
        ))
        .returning({ dayzId: factionMembers.dayzId, serverId: factionMembers.serverId });

      const row = deleted[0];
      if (!row) {
        const [actor] = await tx.select({ role: factionMembers.role }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.actorDiscordId)));
        const [target] = await tx.select({ role: factionMembers.role }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.targetDiscordId)));

        if (!target) return "target-not-member" as const;
        if (!actor || actor.role === "member") return "not-permitted" as const;
        if (target.role === "leader") return "cannot-kick-leader" as const;
        return "cannot-kick-officer" as const;
      }

      await tx.insert(rosterCooldowns)
        .values({ serverId: row.serverId, dayzId: row.dayzId, until: a.until })
        .onConflictDoUpdate({
          target: [rosterCooldowns.serverId, rosterCooldowns.dayzId],
          // The later of the two: a cooldown is a floor, never shortened.
          set: { until: sql`greatest(${rosterCooldowns.until}, excluded.until)` },
        });

      // The kicked player leaves the electorate of any open vote with them —
      // unreachable here (the freeze above refuses the kick), but the call
      // keeps the two departure paths identical rather than relying on one
      // of them being unreachable.
      await applyElectorateLeaveTx(tx, { factionId: a.factionId, dayzId: row.dayzId, at: a.at });

      const [clan] = await tx.select({ name: factions.name }).from(factions).where(eq(factions.id, a.factionId));

      await noticeClanTx(tx, {
        serverId: row.serverId, factionId: a.factionId, kind: "kicked", occurredAt: a.at,
        payload: { gamertag: await gamertagOrId(tx, a.targetDiscordId), officer: await gamertagOrId(tx, a.actorDiscordId) },
      });
      await noticeUserTx(tx, {
        serverId: row.serverId, factionId: a.factionId, discordId: a.targetDiscordId, kind: "kicked", occurredAt: a.at,
        payload: { clan: clan?.name ?? "your clan", until: a.until.toISOString() },
      });

      return "ok" as const;
    });
  }

  /**
   * The leader is refused by excluding `role = 'leader'` from the delete's
   * own WHERE — the delete's row count IS the decision. The follow-up read
   * below only distinguishes "not a member at all" from "is the untouchable
   * leader" for the sake of the message; it plays no part in what got
   * written, so there is nothing here that a `RosterAbort` would need to
   * unwind.
   */
  async leave(a: LeaveArgs): Promise<LeaveOutcome> {
    return this.db.transaction(async (tx) => {
      // ⚠️ FIRST statement, for the same reason as `kick`'s: the electorate
      // decrement below writes `faction_votes`, which sits after
      // `faction_members` in the lock order (spec §4.12).
      await lockFactionTx(tx, a.factionId);

      const deleted = await tx.delete(factionMembers)
        .where(and(
          eq(factionMembers.factionId, a.factionId),
          eq(factionMembers.discordId, a.discordId),
          ne(factionMembers.role, "leader"),
        ))
        .returning({ dayzId: factionMembers.dayzId, serverId: factionMembers.serverId });

      const row = deleted[0];
      if (!row) {
        const [existing] = await tx.select({ role: factionMembers.role }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.discordId)));
        return existing ? ("leader-must-transfer" as const) : ("not-member" as const);
      }

      await tx.insert(rosterCooldowns)
        .values({ serverId: row.serverId, dayzId: row.dayzId, until: a.until })
        .onConflictDoUpdate({
          target: [rosterCooldowns.serverId, rosterCooldowns.dayzId],
          set: { until: sql`greatest(${rosterCooldowns.until}, excluded.until)` },
        });

      // §5.7: a leaver takes their electorate slot AND their ballot with
      // them, so an open vote's threshold moves down — which can carry a
      // vote that was one short. The freeze does not refuse a leaver; nobody
      // is trapped in a clan by a vote.
      await applyElectorateLeaveTx(tx, { factionId: a.factionId, dayzId: row.dayzId, at: a.at });

      await noticeClanTx(tx, {
        serverId: row.serverId, factionId: a.factionId, kind: "left", occurredAt: a.at,
        payload: { gamertag: await gamertagOrId(tx, a.discordId) },
      });

      return "ok" as const;
    });
  }

  /**
   * The permission check (actor must currently be the leader) and the
   * untouchable-target guard (the leader can't be re-roled by this path —
   * use `transfer`) both live in the UPDATE's own WHERE, exactly like
   * `kick`/`leave` above: the outcome comes from `.returning()`, never from
   * a prior read. The follow-up reads only run on zero rows, and only to
   * pick which failure message to show.
   */
  async setRole(a: SetRoleArgs): Promise<SetRoleOutcome> {
    const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;

    return this.db.transaction(async (tx) => {
      const updated = await tx.update(factionMembers)
        .set({ role: a.role })
        .where(and(
          eq(factionMembers.factionId, a.factionId),
          eq(factionMembers.discordId, a.targetDiscordId),
          ne(factionMembers.role, "leader"),
          // The TARGET must be a full member — a pending member is not yet on
          // the roster (spec §4.5).
          eq(factionMembers.status, "full"),
          sql`${actorRole} = 'leader'`,
        ))
        .returning({ id: factionMembers.id, serverId: factionMembers.serverId });

      if (updated[0]) {
        await noticeClanTx(tx, {
          serverId: updated[0].serverId, factionId: a.factionId,
          kind: a.role === "officer" ? "promoted" : "demoted", occurredAt: a.at ?? new Date(),
          payload: { gamertag: await gamertagOrId(tx, a.targetDiscordId) },
        });
        return "ok" as const;
      }

      const [target] = await tx.select({ role: factionMembers.role, status: factionMembers.status }).from(factionMembers)
        .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.targetDiscordId)));
      if (!target || target.status === "pending") return "target-not-member" as const;
      if (target.role === "leader") return "cannot-target-leader" as const;
      return "not-leader" as const;
    });
  }

  /**
   * Demotes the old leader before promoting the target — both inside this
   * one transaction. `faction_members_leader_uniq` is a partial unique
   * index permitting exactly one leader per faction at a time; promoting
   * the target first, while `fromDiscordId` is still seated as leader,
   * would collide with that index. Demoting first frees the slot the
   * promote then claims. This ordering looks arbitrary but is not — a
   * later refactor that "tidies" it into promote-then-demote reintroduces
   * the collision.
   */
  async transfer(a: TransferArgs): Promise<TransferOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        // Lock order (spec §4.12): `factions` before `faction_members`. This
        // `FOR UPDATE` exists purely for that ordering — nothing here reads
        // the row's columns — so a concurrent `disband`/dormancy-tick, which
        // takes `factions` first too, cannot interleave with this
        // transaction's own `faction_members` writes below and deadlock
        // against it (the same reasoning as `acceptInvite`'s note on lock
        // order).
        await tx.execute(sql`select id from factions where id = ${a.factionId}::bigint for update`);

        // §5.7: no handing the seat to an ally to dodge a vote on it.
        if (await voteIsOpenTx(tx, a.factionId)) return "vote-open" as const;

        const demoted = await tx.update(factionMembers)
          .set({ role: "officer" })
          .where(and(
            eq(factionMembers.factionId, a.factionId),
            eq(factionMembers.discordId, a.fromDiscordId),
            eq(factionMembers.role, "leader"),
            eq(factionMembers.status, "full"),
          ))
          .returning({ id: factionMembers.id, serverId: factionMembers.serverId });
        // Nothing has been written yet on this path — a bare return is safe.
        if (!demoted[0]) return "not-leader" as const;

        const promoted = await tx.update(factionMembers)
          .set({ role: "leader" })
          .where(and(
            eq(factionMembers.factionId, a.factionId),
            eq(factionMembers.discordId, a.toDiscordId),
            ne(factionMembers.role, "leader"),
            // The TARGET must be a full member — a pending member is not yet
            // on the roster (spec §4.5); zero rows here reports the same
            // "target-not-member" outcome either way.
            eq(factionMembers.status, "full"),
          ))
          .returning({ id: factionMembers.id });
        if (!promoted[0]) {
          // The demote above already wrote. A bare `return` here would
          // COMMIT it, leaving the faction leaderless. Throw so the whole
          // transaction rolls back instead. See `RosterAbort`.
          throw new RosterAbort("target-not-member");
        }

        // Keep the denormalised copy true. It is DISPLAY PROVENANCE ONLY —
        // never an authority. See the note on `leaderDiscordId` above
        // `disband`; leaving it stale here is what let a demoted ex-leader
        // disband the faction.
        await tx.update(factions)
          .set({ leaderDiscordId: a.toDiscordId })
          .where(eq(factions.id, a.factionId));

        await noticeClanTx(tx, {
          serverId: demoted[0].serverId, factionId: a.factionId, kind: "transferred", occurredAt: a.at,
          payload: { gamertag: await gamertagOrId(tx, a.toDiscordId), old: await gamertagOrId(tx, a.fromDiscordId) },
        });

        return "ok" as const;
      });
    } catch (err) {
      if (err instanceof RosterAbort) return err.outcome as TransferOutcome;
      throw err;
    }
  }

  /**
   * The leader-only entry point. Everything disbanding actually does — the
   * status write, the roster delete, the invite revocation, the lock order —
   * lives in `disbandFactionTx` above, shared with the dormancy tick's
   * auto-disband; this just supplies the leadership check as that function's
   * `guard`.
   */
  async disband(factionId: number, discordId: string): Promise<"ok" | "not-leader"> {
    return this.db.transaction(async (tx) =>
      await disbandFactionTx(tx, factionId, leaderIs(factionId, discordId)) ? "ok" as const : "not-leader" as const);
  }

  /**
   * A single guarded UPDATE, like `setRole`/`kick`/`leave`: leadership,
   * holding status, and the cooldown floor on `renamed_at` all live in the
   * WHERE, so the outcome comes from `.returning()`. `renamed_at` is null
   * for a faction that has never been renamed, and a null must always be
   * allowed — the `isNull` arm of the `or` covers that case.
   *
   * The follow-up read on zero rows only distinguishes "not the leader"
   * from "still on cooldown" for the message; it decides nothing.
   *
   * ⚠️ A transaction now, and the old name is read INSIDE it before the
   * update. UPDATE ... RETURNING yields the new values, and the feed post is
   * "X, formerly Y" — read Y at post time and both halves resolve to X. The
   * read-then-write is not a race worth guarding: a second concurrent rename
   * is barred by the 7-day cooldown, and the update's own guard rejects it
   * regardless.
   */
  async rename(a: RenameArgs): Promise<RenameOutcome> {
    const outcome = await this.db.transaction(async (tx) => {
      const [before] = await tx.select({ name: factions.name, tag: factions.tag, serverId: factions.serverId })
        .from(factions).where(eq(factions.id, a.factionId)).for("update");
      if (!before) return "not-leader" as const;

      const newTag = a.tag ?? before.tag;
      if (before.name === a.name && before.tag === newTag) return "unchanged" as const;

      // The identity lock (spec §4.4) before the taken/held check: names have
      // no unique index, so this transaction and every other renamer or
      // reserver on this server must serialise through it before either one
      // reads a row. Lock order: right after the `factions` row lock above.
      await lockIdentity(tx, before.serverId);
      const taken = await identityTakenTx(tx, { serverId: before.serverId, name: a.name, tag: newTag, exceptFactionId: a.factionId });
      if (taken) return taken;

      const [updated] = await tx.update(factions)
        .set({ name: a.name, tag: newTag, renamedAt: a.at })
        .where(and(
          eq(factions.id, a.factionId),
          leaderIs(a.factionId, a.discordId),
          inArray(factions.status, HOLDING),
          or(isNull(factions.renamedAt), lte(factions.renamedAt, a.notBefore)),
        ))
        .returning({
          id: factions.id, serverId: factions.serverId,
          tag: factions.tag, texture: factions.texture,
        });

      if (!updated) return null;

      // Hold only what was actually given up (guide ch. 8: "so nobody can
      // impersonate you") — a rename that only changes the tag must not also
      // stamp a hold on the unchanged name, and vice versa. `exceptFactionId`
      // above already let this same clan rename back into a name or tag it
      // once held itself.
      await writeHoldsTx(tx, {
        serverId: updated.serverId, factionId: updated.id,
        name: before.name === a.name ? null : before.name,
        tag: before.tag === newTag ? null : before.tag,
        reason: "renamed",
      });

      await appendFactionEventTx(tx, {
        serverId: updated.serverId, factionId: updated.id, kind: "renamed", occurredAt: a.at,
        payload: {
          name: a.name, previousName: before.name,
          tag: updated.tag, texture: updated.texture,
          actor: await actorGamertagTx(tx, a.discordId),
        },
      });
      await noticeClanTx(tx, {
        serverId: updated.serverId, factionId: updated.id, kind: "renamed", occurredAt: a.at,
        payload: { name: a.name, tag: updated.tag },
      });
      return "ok" as const;
    });

    if (outcome) return outcome;

    const [seat] = await this.db.select({ role: factionMembers.role }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.discordId)));
    if (seat?.role !== "leader") return "not-leader" as const;
    return "cooldown" as const;
  }

  /** Officer+ withdraws an outstanding offer. The role check rides in the UPDATE's WHERE. */
  async revokeInvite(a: { inviteId: number; factionId: number; actorDiscordId: string; at: Date }): Promise<"ok" | "not-permitted" | "gone"> {
    const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;
    const rows = await this.db.update(factionInvites).set({ revokedAt: a.at })
      .where(and(eq(factionInvites.id, a.inviteId), eq(factionInvites.factionId, a.factionId),
        isNull(factionInvites.acceptedAt), isNull(factionInvites.declinedAt), isNull(factionInvites.revokedAt),
        sql`${actorRole} in ('leader','officer')`))
      .returning({ id: factionInvites.id });
    if (rows.length > 0) return "ok";
    const [actor] = await this.db.select({ role: factionMembers.role }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.actorDiscordId), eq(factionMembers.status, "full")));
    return actor && actor.role !== "member" ? "gone" : "not-permitted";
  }

  /** Open, unexpired invites this clan has out — the officer's view. */
  async invitesOut(factionId: number, at: Date) {
    return this.db.select({
      id: factionInvites.id, factionId: factionInvites.factionId, factionName: factions.name, tag: factions.tag,
      serverId: factionInvites.serverId, serverName: servers.name, expiresAt: factionInvites.expiresAt,
      inviteeDiscordId: factionInvites.inviteeDiscordId, inviteeGamertag: players.gamertag,
    }).from(factionInvites)
      .innerJoin(factions, eq(factions.id, factionInvites.factionId))
      .innerJoin(servers, eq(servers.id, factionInvites.serverId))
      .leftJoin(players, eq(players.dayzId, factionInvites.inviteeDayzId))
      .where(and(eq(factionInvites.factionId, factionId), isNull(factionInvites.acceptedAt), isNull(factionInvites.declinedAt), isNull(factionInvites.revokedAt), gt(factionInvites.expiresAt, at)))
      .orderBy(asc(factionInvites.expiresAt));
  }

  /** Officer+ edits the recruiting post (guide ch. 8). One guarded UPDATE. */
  async setRecruitingPost(a: { factionId: number; actorDiscordId: string; recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }): Promise<"ok" | "not-permitted"> {
    const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;
    const rows = await this.db.update(factions)
      .set({ recruiting: a.recruiting, playWindow: a.playWindow, language: a.language, pitch: a.pitch })
      .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING), sql`${actorRole} in ('leader','officer')`))
      .returning({ id: factions.id });
    return rows.length > 0 ? "ok" : "not-permitted";
  }
}
