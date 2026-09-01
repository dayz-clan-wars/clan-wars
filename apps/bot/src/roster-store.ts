import type { Database } from "@factions/db";
import { factions, factionInvites, factionMembers, identityLinks, rosterCooldowns, servers } from "@factions/db";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { HOLDING_STATUSES } from "@factions/domain";

// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

export type Role = "leader" | "officer" | "member";

export type Membership = {
  factionId: number; serverId: number; serverName: string;
  factionName: string; tag: string; role: Role;
};

export type RosterEntry = {
  dayzId: string; discordId: string; gamertag: string | null; role: Role; joinedAt: Date;
};

export type FactionCard = {
  id: number; serverId: number; serverName: string;
  name: string; tag: string; texture: string; status: string;
  poleKey: string; memberCount: number; leaderDiscordId: string; createdAt: Date;
};

export type CreateInviteArgs = {
  factionId: number; serverId: number;
  inviteeDiscordId: string; inviteeDayzId: string; invitedByDiscordId: string;
  at: Date; expiresAt: Date;
};
export type CreateInviteOutcome = "ok" | "not-permitted" | "already-member" | "cooldown" | "not-holding";
export type PendingInvite = {
  id: number; factionId: number; factionName: string; tag: string;
  serverId: number; serverName: string; expiresAt: Date;
};
export type AcceptInviteOutcome = "ok" | "gone" | "already-member" | "cooldown" | "not-holding" | "link-changed";
export type KickArgs = { factionId: number; actorDiscordId: string; targetDiscordId: string; at: Date; until: Date };
export type KickOutcome = "ok" | "not-permitted" | "target-not-member" | "cannot-kick-self" | "cannot-kick-officer" | "cannot-kick-leader";
export type LeaveArgs = { factionId: number; discordId: string; at: Date; until: Date };
export type LeaveOutcome = "ok" | "not-member" | "leader-must-transfer";
export type SetRoleArgs = { factionId: number; actorDiscordId: string; targetDiscordId: string; role: "officer" | "member" };
export type SetRoleOutcome = "ok" | "not-leader" | "target-not-member" | "cannot-target-leader";
export type TransferArgs = { factionId: number; fromDiscordId: string; toDiscordId: string; at: Date };
export type TransferOutcome = "ok" | "not-leader" | "target-not-member";
export type RenameArgs = { factionId: number; discordId: string; name: string; at: Date; notBefore: Date };
export type RenameOutcome = "ok" | "not-leader" | "cooldown";

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
}

// Leader, then officer, then member — matches the ordering rosterOf promises.
const ROLE_ORDER = sql<number>`case ${factionMembers.role} when 'leader' then 0 when 'officer' then 1 else 2 end`;

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
 */
const leaderIs = (factionId: number, discordId: string) =>
  sql`(select role from faction_members where faction_id = ${factionId} and discord_id = ${discordId}) = 'leader'`;

export class PgRosterStore implements RosterStore {
  constructor(private readonly db: Database) {}

  async membershipsFor(discordId: string): Promise<Membership[]> {
    const rows = await this.db.select({
      factionId: factions.id,
      serverId: factions.serverId,
      serverName: servers.name,
      factionName: factions.name,
      tag: factions.tag,
      role: factionMembers.role,
    }).from(factionMembers)
      .innerJoin(factions, eq(factionMembers.factionId, factions.id))
      .innerJoin(servers, eq(factions.serverId, servers.id))
      .where(and(
        eq(factionMembers.discordId, discordId),
        inArray(factions.status, HOLDING),
      ))
      .orderBy(asc(servers.name));
    return rows.map((r) => ({ ...r, role: r.role as Role }));
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
      joinedAt: factionMembers.joinedAt,
    }).from(factionMembers)
      .leftJoin(identityLinks, eq(identityLinks.dayzId, factionMembers.dayzId))
      .where(eq(factionMembers.factionId, factionId))
      .orderBy(ROLE_ORDER, asc(factionMembers.joinedAt));
    return rows.map((r) => ({ ...r, gamertag: r.gamertag ?? null, role: r.role as Role }));
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
      poleKey: factions.poleKey,
      leaderDiscordId: factions.leaderDiscordId,
      createdAt: factions.createdAt,
      memberCount: sql<number>`count(${factionMembers.id})`,
    }).from(factions)
      .innerJoin(servers, eq(factions.serverId, servers.id))
      .leftJoin(factionMembers, eq(factionMembers.factionId, factions.id))
      .where(where)
      .groupBy(factions.id, servers.name);
    if (!row) return null;
    return { ...row, memberCount: Number(row.memberCount) };
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
      const [f] = await tx.select({ id: factions.id }).from(factions)
        .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING)));
      if (!f) return { outcome: "not-holding" as const, inviteId: null };

      const [existing] = await tx.select({ id: factionMembers.id }).from(factionMembers)
        .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.inviteeDayzId)));
      if (existing) return { outcome: "already-member" as const, inviteId: null };

      const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, a.serverId), eq(rosterCooldowns.dayzId, a.inviteeDayzId)));
      if (cd && cd.until > a.at) return { outcome: "cooldown" as const, inviteId: null };

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
               where faction_id = ${a.factionId}::bigint and discord_id = ${a.invitedByDiscordId}::text)
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
   * lock-order note on the `FOR SHARE` below, which is what keeps this path
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

        // ⚠️ `FOR SHARE`, not a plain read, and it must come BEFORE the claim
        // UPDATE below. Two separate reasons, both load-bearing:
        //
        // 1. An unlocked SELECT is not a check at all under READ COMMITTED.
        //    `disband()` and `lapseReservations()` both UPDATE this row and
        //    then DELETE the roster, and that DELETE cannot see the
        //    membership row this transaction has not inserted yet. Read
        //    status, watch a disband commit in the gap, insert anyway — and
        //    the row outlives its faction. `faction_members_server_player_uniq`
        //    has no status predicate, so that row then bars the player from
        //    every future faction on the server and NO command can clear it
        //    (§4.1). The share lock makes both writers wait for this
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
        // Nothing has been written at this point, which is why "not-holding"
        // can return directly instead of needing a `RosterAbort`.
        const [f] = await tx.select({ id: factions.id }).from(factions)
          .where(and(eq(factions.id, target.factionId), inArray(factions.status, HOLDING)))
          .for("share");
        if (!f) return "not-holding" as const;

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
          insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at)
          select ${inv.factionId}::bigint, ${inv.serverId}::integer, il.dayz_id, ${discordId}::text, 'member', ${at.toISOString()}::timestamptz
          from identity_links il
          where il.discord_id = ${discordId} and il.dayz_id = ${inv.inviteeDayzId}
          returning id
        `);
        if ((inserted as unknown as unknown[]).length === 0) throw new RosterAbort("link-changed");
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
      const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId})`;

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
    const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId})`;

    const updated = await this.db.update(factionMembers)
      .set({ role: a.role })
      .where(and(
        eq(factionMembers.factionId, a.factionId),
        eq(factionMembers.discordId, a.targetDiscordId),
        ne(factionMembers.role, "leader"),
        sql`${actorRole} = 'leader'`,
      ))
      .returning({ id: factionMembers.id });

    if (updated[0]) return "ok" as const;

    const [target] = await this.db.select({ role: factionMembers.role }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.targetDiscordId)));
    if (!target) return "target-not-member" as const;
    if (target.role === "leader") return "cannot-target-leader" as const;
    return "not-leader" as const;
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
        const demoted = await tx.update(factionMembers)
          .set({ role: "officer" })
          .where(and(
            eq(factionMembers.factionId, a.factionId),
            eq(factionMembers.discordId, a.fromDiscordId),
            eq(factionMembers.role, "leader"),
          ))
          .returning({ id: factionMembers.id });
        // Nothing has been written yet on this path — a bare return is safe.
        if (!demoted[0]) return "not-leader" as const;

        const promoted = await tx.update(factionMembers)
          .set({ role: "leader" })
          .where(and(
            eq(factionMembers.factionId, a.factionId),
            eq(factionMembers.discordId, a.toDiscordId),
            ne(factionMembers.role, "leader"),
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

        return "ok" as const;
      });
    } catch (err) {
      if (err instanceof RosterAbort) return err.outcome as TransferOutcome;
      throw err;
    }
  }

  /**
   * One transaction, two writes: the status update (guarded on leadership
   * and a holding status, exactly like the other permission checks in this
   * file) then the roster delete. §6 is explicit that disbanding is not
   * betrayal — no cooldown is written for anyone, unlike `kick`/`leave`.
   *
   * The status update must land first and the delete must be conditioned on
   * it succeeding: a bare `return "not-leader"` after the update fails
   * writes nothing, so that path is safe to `return` from directly. But if
   * the update succeeds, this transaction still has to run the delete
   * before it can report "ok" — there is no non-"ok" outcome left to abort
   * on at that point, so `RosterAbort` never comes into play here.
   */
  async disband(factionId: number, discordId: string): Promise<"ok" | "not-leader"> {
    return this.db.transaction(async (tx) => {
      const updated = await tx.update(factions)
        .set({ status: "disbanded" })
        .where(and(
          eq(factions.id, factionId),
          leaderIs(factionId, discordId),
          inArray(factions.status, HOLDING),
        ))
        .returning({ id: factions.id });

      if (!updated[0]) return "not-leader" as const;

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

      return "ok" as const;
    });
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
   */
  async rename(a: RenameArgs): Promise<RenameOutcome> {
    const updated = await this.db.update(factions)
      .set({ name: a.name, renamedAt: a.at })
      .where(and(
        eq(factions.id, a.factionId),
        leaderIs(a.factionId, a.discordId),
        inArray(factions.status, HOLDING),
        or(isNull(factions.renamedAt), lte(factions.renamedAt, a.notBefore)),
      ))
      .returning({ id: factions.id });

    if (updated[0]) return "ok" as const;

    const [seat] = await this.db.select({ role: factionMembers.role }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.discordId)));
    if (seat?.role !== "leader") return "not-leader" as const;
    return "cooldown" as const;
  }
}
