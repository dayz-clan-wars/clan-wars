import type { Database } from "@factions/db";
import { clanNotices, factionMembers, factions, warLogEvents } from "@factions/db";
import type { ClanNoticeKind, NoticeTarget, WarLogKind } from "@factions/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Named display fields, frozen at write time. Never a coordinate — the check is the second line of defence. */
export type NoticePayload = Record<string, string | number | boolean | null>;

export type ClanNoticeInput = {
  serverId: number;
  factionId: number | null;
  target: NoticeTarget;
  discordTargetId: string | null;
  kind: ClanNoticeKind;
  occurredAt: Date;
  payload: NoticePayload;
};

/**
 * Append one notice. Takes a Tx on purpose (see feed-store.ts): written in
 * the transaction that performs the transition, so a transition without its
 * notice is impossible. Lock order (§4.12): last, after faction_events.
 */
export async function appendClanNoticeTx(tx: Tx, n: ClanNoticeInput): Promise<void> {
  await tx.insert(clanNotices).values({
    serverId: n.serverId,
    factionId: n.factionId,
    target: n.target,
    discordTargetId: n.discordTargetId,
    kind: n.kind,
    occurredAt: n.occurredAt,
    payload: n.payload,
  });
}

/**
 * A clan-channel notice. The channel id is copied from the faction row when
 * it has one; otherwise the row queues with a null target and the poster
 * resolves it later (increment 3b creates the channels). Read with a plain
 * select — the caller already holds whatever faction lock its transition
 * needed, and this is after it in the order.
 */
export async function noticeClanTx(
  tx: Tx,
  a: { serverId: number; factionId: number; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload },
): Promise<void> {
  const [f] = await tx.select({ channel: factions.discordTextChannelId }).from(factions).where(eq(factions.id, a.factionId));
  await appendClanNoticeTx(tx, { ...a, target: "channel", discordTargetId: f?.channel ?? null });
}

/** A DM: target 'dm', discord_target_id = the user. */
export async function noticeUserTx(
  tx: Tx,
  a: { serverId: number; factionId: number | null; discordId: string; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload },
): Promise<void> {
  const { discordId, ...rest } = a;
  await appendClanNoticeTx(tx, { ...rest, target: "dm", discordTargetId: discordId });
}

/** The same DM to every FULL member of a clan (reserved/pending members get nothing). Returns how many. */
export async function noticeFullMembersTx(
  tx: Tx,
  a: { serverId: number; factionId: number; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload },
): Promise<number> {
  const members = await tx
    .select({ discordId: factionMembers.discordId })
    .from(factionMembers)
    .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.status, "full")));
  for (const m of members) await noticeUserTx(tx, { ...a, discordId: m.discordId });
  return members.length;
}

export type WarLogInput = { serverId: number; kind: WarLogKind; occurredAt: Date; payload: NoticePayload };

export async function appendWarLogTx(tx: Tx, e: WarLogInput): Promise<void> {
  await tx.insert(warLogEvents).values({ serverId: e.serverId, kind: e.kind, occurredAt: e.occurredAt, payload: e.payload });
}

export const NOTICE_MAX_ATTEMPTS = 3;

export type QueuedNotice = {
  id: number;
  factionId: number | null;
  target: NoticeTarget;
  discordTargetId: string | null;
  kind: ClanNoticeKind;
  occurredAt: Date;
  payload: NoticePayload;
  attempts: number;
};

export interface NoticeStore {
  /**
   * Unposted, unfailed rows in id order; channel rows with a null target are
   * resolved through factions.discord_text_channel_id and returned with it
   * filled, or SKIPPED (not returned) while the clan has no channel.
   */
  readUnposted(limit: number): Promise<QueuedNotice[]>;
  markPosted(id: number, at: Date): Promise<void>;
  /** attempts += 1; failed_at set when attempts reaches NOTICE_MAX_ATTEMPTS. Returns the new attempts count. */
  markAttempt(id: number, at: Date): Promise<number>;
}

export class PgNoticeStore implements NoticeStore {
  constructor(private readonly db: Database) {}

  /**
   * Ascending id. A channel row whose clan still has no text channel is not
   * returned: it is neither posted nor failed, it waits. Rows whose own
   * discord_target_id is set are returned as they are (a DM, or a channel id
   * frozen at write time).
   */
  async readUnposted(limit: number): Promise<QueuedNotice[]> {
    const rows = await this.db
      .select({
        id: clanNotices.id,
        factionId: clanNotices.factionId,
        target: clanNotices.target,
        discordTargetId: sql<string | null>`coalesce(${clanNotices.discordTargetId}, ${factions.discordTextChannelId})`,
        kind: clanNotices.kind,
        occurredAt: clanNotices.occurredAt,
        payload: clanNotices.payload,
        attempts: clanNotices.attempts,
      })
      .from(clanNotices)
      .leftJoin(factions, eq(factions.id, clanNotices.factionId))
      .where(
        and(
          isNull(clanNotices.postedAt),
          isNull(clanNotices.failedAt),
          // In SQL, not in JS: `limit` must count deliverable rows only, or a
          // backlog of channel rows with no channel yet (the steady state until
          // increment 3b) starves every DM queued behind it.
          sql`coalesce(${clanNotices.discordTargetId}, ${factions.discordTextChannelId}) is not null`,
        ),
      )
      .orderBy(asc(clanNotices.id))
      .limit(limit);
    // The filter is type narrowing only; the WHERE above already excludes them.
    return rows.filter((r) => r.discordTargetId !== null).map((r) => ({ ...r, payload: r.payload as NoticePayload }));
  }

  async markPosted(id: number, at: Date): Promise<void> {
    await this.db.update(clanNotices).set({ postedAt: at }).where(eq(clanNotices.id, id));
  }

  async markAttempt(id: number, at: Date): Promise<number> {
    const [row] = await this.db
      .update(clanNotices)
      .set({
        attempts: sql`${clanNotices.attempts} + 1`,
        // The ::timestamptz cast is required: drizzle passes the parameter untyped
        // inside a CASE, and Postgres cannot infer the branch type without it.
        failedAt: sql`case when ${clanNotices.attempts} + 1 >= ${NOTICE_MAX_ATTEMPTS} then ${at.toISOString()}::timestamptz else null end`,
      })
      .where(eq(clanNotices.id, id))
      .returning({ attempts: clanNotices.attempts });
    return row!.attempts;
  }
}

export type QueuedWarLog = { id: number; kind: WarLogKind; occurredAt: Date; payload: NoticePayload };

export interface WarLogStore {
  readUnposted(limit: number): Promise<QueuedWarLog[]>;
  markPosted(id: number, at: Date): Promise<void>;
}

export class PgWarLogStore implements WarLogStore {
  constructor(private readonly db: Database) {}

  async readUnposted(limit: number): Promise<QueuedWarLog[]> {
    const rows = await this.db
      .select({ id: warLogEvents.id, kind: warLogEvents.kind, occurredAt: warLogEvents.occurredAt, payload: warLogEvents.payload })
      .from(warLogEvents)
      .where(isNull(warLogEvents.postedAt))
      .orderBy(asc(warLogEvents.id))
      .limit(limit);
    return rows.map((r) => ({ ...r, payload: r.payload as NoticePayload }));
  }

  async markPosted(id: number, at: Date): Promise<void> {
    await this.db.update(warLogEvents).set({ postedAt: at }).where(eq(warLogEvents.id, id));
  }
}

/** For the startup log when no channel is configured. See config.ts / feed-store.ts's countUnposted. */
export async function countUnpostedNotices(db: Database): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clanNotices)
    .where(and(isNull(clanNotices.postedAt), isNull(clanNotices.failedAt)));
  return r!.n;
}

export async function countUnpostedWarLog(db: Database): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(warLogEvents).where(isNull(warLogEvents.postedAt));
  return r!.n;
}
