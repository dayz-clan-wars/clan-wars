import type { Database } from "@factions/db";
import { factions, factionJoinRequests, factionMembers, identityLinks, players, rosterCooldowns } from "@factions/db";
import { CLAN_SIZE_CAP, HOLDING_STATUSES } from "@factions/domain";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { countMembersTx } from "./roster-store";

const HOLDING: string[] = [...HOLDING_STATUSES];

export type JoinRequest = { id: number; factionId: number; serverId: number; dayzId: string; discordId: string; gamertag: string | null; createdAt: Date; expiresAt: Date };
export type RequestJoinOutcome = "ok" | "not-recruiting" | "not-holding" | "already-member" | "cooldown" | "cap" | "already-requested";
export type DecideRequestOutcome = "ok" | "not-permitted" | "gone" | "cap" | "cooldown" | "link-changed" | "not-recruiting";

/** Unwinds a decide transaction carrying an outcome — see roster-store's RosterAbort for why a bare return would commit the claim. */
class RequestAbort extends Error { constructor(readonly outcome: DecideRequestOutcome) { super(outcome); } }

const memberCount = (factionId: number) => sql<number>`(select count(*)::int from faction_members where faction_id = ${factionId})`;

/**
 * Ask to join a recruiting clan (spec §4.5, §5.3). The checks here are
 * advisory, as in `createInvite`; `decideRequestDb` re-checks everything
 * at write time. `faction_join_requests_open_uniq` is the binding "one open
 * request per player per clan".
 */
export async function requestJoinDb(db: Database, a: { factionId: number; serverId: number; dayzId: string; discordId: string; at: Date; expiresAt: Date }):
  Promise<{ outcome: RequestJoinOutcome; requestId: number | null }> {
  return db.transaction(async (tx) => {
    const [f] = await tx.select({ recruiting: factions.recruiting, n: memberCount(a.factionId) }).from(factions)
      .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING)));
    if (!f) return { outcome: "not-holding" as const, requestId: null };
    if (!f.recruiting) return { outcome: "not-recruiting" as const, requestId: null };
    const [existing] = await tx.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.dayzId)));
    if (existing) return { outcome: "already-member" as const, requestId: null };
    const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
      .where(and(eq(rosterCooldowns.serverId, a.serverId), eq(rosterCooldowns.dayzId, a.dayzId)));
    if (cd && cd.until > a.at) return { outcome: "cooldown" as const, requestId: null };
    if (f.n >= CLAN_SIZE_CAP) return { outcome: "cap" as const, requestId: null };
    const [row] = await tx.insert(factionJoinRequests)
      .values({ factionId: a.factionId, serverId: a.serverId, dayzId: a.dayzId, discordId: a.discordId, createdAt: a.at, expiresAt: a.expiresAt })
      .onConflictDoNothing().returning({ id: factionJoinRequests.id });
    return row ? { outcome: "ok" as const, requestId: row.id } : { outcome: "already-requested" as const, requestId: null };
  });
}

const openWhere = (at: Date) => and(isNull(factionJoinRequests.decidedAt), gt(factionJoinRequests.expiresAt, at));

export async function openRequestsFor(db: Database, factionId: number, at: Date): Promise<JoinRequest[]> {
  return db.select({
    id: factionJoinRequests.id, factionId: factionJoinRequests.factionId, serverId: factionJoinRequests.serverId,
    dayzId: factionJoinRequests.dayzId, discordId: factionJoinRequests.discordId, gamertag: players.gamertag,
    createdAt: factionJoinRequests.createdAt, expiresAt: factionJoinRequests.expiresAt,
  }).from(factionJoinRequests)
    .leftJoin(players, eq(players.dayzId, factionJoinRequests.dayzId))
    .where(and(eq(factionJoinRequests.factionId, factionId), openWhere(at)))
    .orderBy(asc(factionJoinRequests.createdAt));
}

export async function requestsBy(db: Database, dayzId: string, at: Date) {
  return db.select({
    id: factionJoinRequests.id, factionId: factionJoinRequests.factionId, serverId: factionJoinRequests.serverId,
    dayzId: factionJoinRequests.dayzId, discordId: factionJoinRequests.discordId, gamertag: players.gamertag,
    createdAt: factionJoinRequests.createdAt, expiresAt: factionJoinRequests.expiresAt,
    factionName: factions.name, tag: factions.tag,
  }).from(factionJoinRequests)
    .innerJoin(factions, eq(factions.id, factionJoinRequests.factionId))
    .leftJoin(players, eq(players.dayzId, factionJoinRequests.dayzId))
    .where(and(eq(factionJoinRequests.dayzId, dayzId), openWhere(at), inArray(factions.status, HOLDING)))
    .orderBy(asc(factionJoinRequests.createdAt));
}

/**
 * An officer decides. Accepting is `acceptInvite`'s write with a different
 * door: `FOR UPDATE` on the faction row first (lock order: factions before
 * the request row; the same deadlock reasoning as `acceptInvite`),
 * recruiting and cap re-checked under it, the request claimed with the
 * actor's role in the UPDATE's WHERE, then the pending member inserted from
 * the requester's CURRENT link. Every post-claim refusal throws so the claim
 * rolls back.
 *
 * ⚠️ `FOR UPDATE`, not `FOR SHARE` — mirroring `acceptInvite`'s own note on
 * this exact lock. `FOR SHARE` only bars a concurrent WRITER; it does not bar
 * a second reader from taking the same shared lock and reading the same
 * count. Two `decideRequestDb` calls approving two different requests for
 * the same faction could both take `FOR SHARE`, both read a count one below
 * `CLAN_SIZE_CAP`, and both insert — overshooting the cap. `FOR UPDATE`
 * makes the second decide block on the first one's commit, so its count
 * always sees the first one's inserted member.
 *
 * Notice (`request_accepted` / `request_declined` DM): increment 3.
 */
export async function decideRequestDb(db: Database, a: { requestId: number; actorDiscordId: string; decision: "accepted" | "declined"; at: Date }): Promise<DecideRequestOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [target] = await tx.select({ factionId: factionJoinRequests.factionId }).from(factionJoinRequests).where(eq(factionJoinRequests.id, a.requestId));
      if (!target) return "gone" as const;
      // ⚠️ The lock and the cap count are TWO separate statements, not one
      // combined SELECT — the same shape as `acceptInvite`'s two-step check.
      // Under READ COMMITTED, a `SELECT ... FOR UPDATE` that blocks and then
      // resumes only re-fetches the LOCKED row via EvalPlanQual; a member-count
      // subquery folded into that same statement does not get re-evaluated
      // against a fresh snapshot, so a losing racer would still see the
      // pre-insert count and wrongly pass the cap check. Running the count as
      // its own statement, strictly after the lock is granted, gives it a new
      // READ COMMITTED snapshot that includes whatever the lock holder just
      // committed.
      const [f] = await tx.select({ recruiting: factions.recruiting }).from(factions)
        .where(and(eq(factions.id, target.factionId), inArray(factions.status, HOLDING))).for("update");
      if (!f) return "gone" as const;
      if (a.decision === "accepted" && !f.recruiting) return "not-recruiting" as const;
      if (a.decision === "accepted") {
        if ((await countMembersTx(tx, target.factionId)) >= CLAN_SIZE_CAP) return "cap" as const;
      }
      const actorRole = sql`(select role from faction_members where faction_id = ${target.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;
      const [req] = await tx.update(factionJoinRequests)
        .set({ decidedAt: a.at, decidedByDiscordId: a.actorDiscordId, decision: a.decision })
        .where(and(eq(factionJoinRequests.id, a.requestId), isNull(factionJoinRequests.decidedAt), gt(factionJoinRequests.expiresAt, a.at), sql`${actorRole} in ('leader','officer')`))
        .returning();
      if (!req) {
        const [actor] = await tx.select({ role: factionMembers.role }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, target.factionId), eq(factionMembers.discordId, a.actorDiscordId), eq(factionMembers.status, "full")));
        return actor && actor.role !== "member" ? ("gone" as const) : ("not-permitted" as const);
      }
      if (a.decision === "declined") return "ok" as const;
      const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, req.serverId), eq(rosterCooldowns.dayzId, req.dayzId)));
      if (cd && cd.until > a.at) throw new RequestAbort("cooldown");
      const inserted = await tx.execute(sql`
        insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at, status, pending_since)
        select ${req.factionId}::bigint, ${req.serverId}::integer, il.dayz_id, ${req.discordId}::text, 'member',
               ${a.at.toISOString()}::timestamptz, 'pending', ${a.at.toISOString()}::timestamptz
        from identity_links il where il.discord_id = ${req.discordId} and il.dayz_id = ${req.dayzId}
        returning id`);
      if ((inserted as unknown as unknown[]).length === 0) throw new RequestAbort("link-changed");
      return "ok" as const;
    });
  } catch (err) {
    if (err instanceof RequestAbort) return err.outcome;
    if (String(err).includes("faction_members_server_player_uniq")) return "gone";
    throw err;
  }
}

/** The requester changes their mind. No expiry gate, like declineInvite. */
export async function withdrawRequestDb(db: Database, requestId: number, discordId: string, at: Date): Promise<boolean> {
  const rows = await db.update(factionJoinRequests).set({ decidedAt: at, decidedByDiscordId: discordId, decision: "declined" })
    .where(and(eq(factionJoinRequests.id, requestId), eq(factionJoinRequests.discordId, discordId), isNull(factionJoinRequests.decidedAt)))
    .returning({ id: factionJoinRequests.id });
  return rows.length > 0;
}
