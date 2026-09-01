import type { Database } from "@factions/db";
import { factions, factionInvites, factionMembers, identityLinks, rosterCooldowns, servers } from "@factions/db";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";

const HOLDING = ["reserved", "active", "dormant"];

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
export type CreateInviteOutcome = "ok" | "already-member" | "cooldown" | "not-holding";
export type PendingInvite = {
  id: number; factionId: number; factionName: string; tag: string;
  serverId: number; serverName: string; expiresAt: Date;
};
export type AcceptInviteOutcome = "ok" | "gone" | "already-member" | "cooldown" | "not-holding";
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
  factionByName(name: string): Promise<FactionCard | null>;
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
 * transaction — it does not roll back. Returning "not-holding" or "cooldown"
 * directly, after the invite row was already updated to `accepted_at = now`,
 * would consume the invite while adding no member: the player permanently
 * loses the offer and gains nothing, with no error anywhere. Throwing here
 * instead makes Drizzle roll the whole transaction back, and the catch below
 * translates the sentinel back into the outcome the caller expects.
 */
class RosterAbort extends Error {
  constructor(public readonly outcome: AcceptInviteOutcome) {
    super(`roster-abort:${outcome}`);
  }
}

/**
 * Read methods only. Write methods (createInvite through rename) land in
 * Tasks 4-7 — this class deliberately does NOT `implements RosterStore` yet,
 * because a partial implementation would either need unreachable
 * `throw new Error("not implemented")` stubs (a defect in their own right) or
 * a false claim of completeness. Task 7 adds the last write method and the
 * `implements` clause together.
 */
export class PgRosterStore {
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

  async factionByName(name: string): Promise<FactionCard | null> {
    return this.factionCard(eq(sql`lower(${factions.name})`, name.toLowerCase()));
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

      const [row] = await tx.insert(factionInvites)
        .values({
          factionId: a.factionId, serverId: a.serverId,
          inviteeDiscordId: a.inviteeDiscordId, inviteeDayzId: a.inviteeDayzId,
          invitedByDiscordId: a.invitedByDiscordId,
          createdAt: a.at, expiresAt: a.expiresAt,
        })
        .onConflictDoUpdate({
          target: [factionInvites.factionId, factionInvites.inviteeDayzId],
          targetWhere: sql`accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
          set: { expiresAt: a.expiresAt, createdAt: a.at, invitedByDiscordId: a.invitedByDiscordId },
        })
        .returning({ id: factionInvites.id });
      return { outcome: "ok" as const, inviteId: row!.id };
    });
  }

  /** Invites still open and not yet expired, soonest-expiring first. */
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
   * The faction-holding and cooldown checks run AFTER the invite is claimed
   * (it must be claimed first so a concurrent accept cannot double-spend it)
   * but must abort via `throw`, not `return`, or the claim they just made
   * would commit with no membership row to show for it. See `RosterAbort`.
   */
  async acceptInvite(inviteId: number, discordId: string, at: Date): Promise<AcceptInviteOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const claimed = await tx.update(factionInvites)
          .set({ acceptedAt: at })
          .where(and(
            eq(factionInvites.id, inviteId),
            eq(factionInvites.inviteeDiscordId, discordId),
            isNull(factionInvites.acceptedAt),
            isNull(factionInvites.declinedAt),
            isNull(factionInvites.revokedAt),
            gt(factionInvites.expiresAt, at),
          ))
          .returning();
        const inv = claimed[0];
        if (!inv) return "gone" as const;

        const [f] = await tx.select({ id: factions.id }).from(factions)
          .where(and(eq(factions.id, inv.factionId), inArray(factions.status, HOLDING)));
        if (!f) throw new RosterAbort("not-holding");

        const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
          .where(and(eq(rosterCooldowns.serverId, inv.serverId), eq(rosterCooldowns.dayzId, inv.inviteeDayzId)));
        if (cd && cd.until > at) throw new RosterAbort("cooldown");

        await tx.insert(factionMembers).values({
          factionId: inv.factionId, serverId: inv.serverId,
          dayzId: inv.inviteeDayzId, discordId, role: "member", joinedAt: at,
        });
        return "ok" as const;
      });
    } catch (err) {
      if (err instanceof RosterAbort) return err.outcome;
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
  async kick(a: KickArgs): Promise<KickOutcome> {
    if (a.actorDiscordId === a.targetDiscordId) return "cannot-kick-self";

    return this.db.transaction(async (tx) => {
      const [actor] = await tx.select({ role: factionMembers.role }).from(factionMembers)
        .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.actorDiscordId)));
      const [target] = await tx.select({
        role: factionMembers.role, dayzId: factionMembers.dayzId, serverId: factionMembers.serverId,
      }).from(factionMembers)
        .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.targetDiscordId)));

      if (!target) return "target-not-member" as const;
      if (!actor || actor.role === "member") return "not-permitted" as const;
      if (target.role === "leader") return "cannot-kick-leader" as const;
      if (actor.role === "officer" && target.role === "officer") return "cannot-kick-officer" as const;

      await tx.delete(factionMembers)
        .where(and(
          eq(factionMembers.factionId, a.factionId),
          eq(factionMembers.discordId, a.targetDiscordId),
          ne(factionMembers.role, "leader"),
        ));

      await tx.insert(rosterCooldowns)
        .values({ serverId: target.serverId, dayzId: target.dayzId, until: a.until })
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
}
