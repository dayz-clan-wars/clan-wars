import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks, rosterCooldowns, servers } from "@factions/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

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
}
