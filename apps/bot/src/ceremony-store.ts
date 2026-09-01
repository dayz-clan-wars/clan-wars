import type { Database } from "@factions/db";
import { whiteRaises, ceremonies, ceremonyParticipants, factions, factionInvites, factionMembers, identityLinks, events } from "@factions/db";
import type { QualifyingRaise, SettledWindow } from "@factions/ceremony";
import { HOLDING_STATUSES, parsePoleKey } from "@factions/domain";
import { and, asc, eq, inArray, isNull, lte, max } from "drizzle-orm";

export type PoleRef = { serverId: number; poleKey: string };
export type RecordedRaise = PoleRef & {
  dayzId: string; gamertag: string; occurredAt: Date; eventId: number;
};
export type Participant = { dayzId: string; discordId: string; gamertag: string };
export type CeremonyDraft = { detectedAt: Date; expiresAt: Date; participants: Participant[] };

// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

export interface CeremonyStore {
  highWaterMark(serverId: number): Promise<Date | null>;
  isPoleBound(p: PoleRef): Promise<boolean>;
  linkedDiscordId(dayzId: string): Promise<string | null>;
  recordRaise(r: RecordedRaise): Promise<void>;
  polesWithPendingRaises(): Promise<PoleRef[]>;
  pendingRaises(p: PoleRef): Promise<QualifyingRaise[]>;
  hasOpenCeremony(p: PoleRef): Promise<boolean>;
  settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null>;
  openCeremonyServers(): Promise<number[]>;
  reservedFactionAt(p: PoleRef, texture: string): Promise<{ id: number } | null>;
  isRosterMember(factionId: number, dayzId: string): Promise<boolean>;
  activate(factionId: number, at: Date): Promise<boolean>;
  lapseReservations(serverId: number, cutoff: Date): Promise<number>;
  reservedServers(): Promise<number[]>;
}

export class PgCeremonyStore implements CeremonyStore {
  constructor(private readonly db: Database) {}

  /**
   * ⚠️ The newest ingested event time for this server — NOT `Date.now()`. This
   * is the clock every settling decision is made against, because the ingest
   * worker is a one-shot batch nothing schedules and its lag is unbounded.
   */
  async highWaterMark(serverId: number): Promise<Date | null> {
    const [row] = await this.db.select({ hw: max(events.occurredAt) })
      .from(events).where(eq(events.serverId, serverId));
    return row?.hw ?? null;
  }

  async isPoleBound(p: PoleRef): Promise<boolean> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .where(and(
        eq(factions.serverId, p.serverId),
        eq(factions.poleKey, p.poleKey),
        inArray(factions.status, HOLDING),
      ));
    return row !== undefined;
  }

  async linkedDiscordId(dayzId: string): Promise<string | null> {
    const [row] = await this.db.select({ discordId: identityLinks.discordId })
      .from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
    return row?.discordId ?? null;
  }

  /**
   * Idempotent on `event_id`: a replayed event must not add a second raise.
   * `onConflictDoNothing` is correct here rather than load-bearing-returning —
   * there is no decision downstream, the row either exists or is created.
   */
  async recordRaise(r: RecordedRaise): Promise<void> {
    await this.db.insert(whiteRaises).values({
      serverId: r.serverId, poleKey: r.poleKey, dayzId: r.dayzId,
      gamertag: r.gamertag, occurredAt: r.occurredAt, eventId: r.eventId,
    }).onConflictDoNothing();
  }

  async polesWithPendingRaises(): Promise<PoleRef[]> {
    return this.db.selectDistinct({ serverId: whiteRaises.serverId, poleKey: whiteRaises.poleKey })
      .from(whiteRaises).where(isNull(whiteRaises.settledAt));
  }

  async pendingRaises(p: PoleRef): Promise<QualifyingRaise[]> {
    return this.db.select({
      eventId: whiteRaises.eventId, dayzId: whiteRaises.dayzId,
      gamertag: whiteRaises.gamertag, occurredAt: whiteRaises.occurredAt,
    }).from(whiteRaises)
      .where(and(
        eq(whiteRaises.serverId, p.serverId),
        eq(whiteRaises.poleKey, p.poleKey),
        isNull(whiteRaises.settledAt),
      ))
      .orderBy(asc(whiteRaises.occurredAt), asc(whiteRaises.eventId));
  }

  async hasOpenCeremony(p: PoleRef): Promise<boolean> {
    const [row] = await this.db.select({ id: ceremonies.id }).from(ceremonies)
      .where(and(
        eq(ceremonies.serverId, p.serverId),
        eq(ceremonies.poleKey, p.poleKey),
        eq(ceremonies.status, "provisional"),
      ));
    return row !== undefined;
  }

  /**
   * Servers with at least one outstanding (provisional) ceremony — including
   * ones at a pole with no pending raises, e.g. a ceremony gone quiet after
   * detection. Expiry must sweep these too, not just poles still accumulating
   * raises.
   */
  async openCeremonyServers(): Promise<number[]> {
    const rows = await this.db.selectDistinct({ serverId: ceremonies.serverId })
      .from(ceremonies).where(eq(ceremonies.status, "provisional"));
    return rows.map((r) => r.serverId);
  }

  /**
   * Consume a settled window, and create its ceremony when it qualified.
   *
   * ⚠️ One transaction. Marking the raises settled without creating the
   * ceremony loses a real ritual; creating the ceremony without consuming the
   * raises re-settles the same window forever. A window that produced no
   * ceremony still consumes its raises — that is what keeps windows
   * non-overlapping in the database as well as in the pure function.
   *
   * ⚠️ `x`/`y`/`z` are NOT NULL on `ceremonies`. `poleKey` is exactly
   * `${x}:${y}:${z}` (see `@factions/domain`'s `poleKey`/`parsePoleKey`), so
   * the coordinates are recovered from `p.poleKey` rather than duplicated
   * elsewhere. A pole key that fails to parse is an upstream data defect, not
   * something to paper over with a placeholder — this throws instead of
   * inserting a ceremony with bogus coordinates.
   */
  async settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null> {
    const eventIds = w.raises.map((r) => r.eventId);
    return this.db.transaction(async (tx) => {
      let ceremonyId: number | null = null;
      if (create) {
        const at = parsePoleKey(p.poleKey);
        if (!at) throw new Error(`settle: malformed pole key "${p.poleKey}"`);
        const [row] = await tx.insert(ceremonies).values({
          serverId: p.serverId, poleKey: p.poleKey,
          x: at.x.toFixed(2), y: at.y.toFixed(2), z: at.z.toFixed(2),
          windowStart: w.start, windowEnd: w.end, status: "provisional",
          detectedAt: create.detectedAt, expiresAt: create.expiresAt,
        }).returning({ id: ceremonies.id });
        ceremonyId = row!.id;
        await tx.insert(ceremonyParticipants).values(
          create.participants.map((x) => ({ ceremonyId: ceremonyId!, ...x })),
        );
      }
      if (eventIds.length > 0) {
        // Guarded on `settledAt IS NULL` so this write is a no-op on an
        // already-settled raise rather than a pre-read-then-write race.
        await tx.update(whiteRaises)
          .set({ settledAt: create?.detectedAt ?? w.end })
          .where(and(inArray(whiteRaises.eventId, eventIds), isNull(whiteRaises.settledAt)));
      }
      return ceremonyId;
    });
  }

  async reservedFactionAt(p: PoleRef, texture: string): Promise<{ id: number } | null> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .where(and(
        eq(factions.serverId, p.serverId),
        eq(factions.poleKey, p.poleKey),
        eq(factions.texture, texture),
        eq(factions.status, "reserved"),
      ));
    return row ?? null;
  }

  async isRosterMember(factionId: number, dayzId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, dayzId)));
    return row !== undefined;
  }

  /** Guarded on `reserved`: a concurrent lapse must not be overwritten. */
  async activate(factionId: number, at: Date): Promise<boolean> {
    const done = await this.db.update(factions)
      .set({ status: "active", activatedAt: at, reservedUntil: null })
      .where(and(eq(factions.id, factionId), eq(factions.status, "reserved")))
      .returning({ id: factions.id });
    return done.length > 0;
  }

  /**
   * Lapse expired reservations and RELEASE their rosters.
   *
   * ⚠️ The delete is not cleanup. `faction_members_server_player_uniq` carries
   * no status predicate, so a membership row surviving its faction's hold bars
   * that player from every future faction on the server, permanently, with no
   * command able to clear it. One transaction: a faction never exists in the
   * state "lapsed but still rostered".
   */
  async lapseReservations(serverId: number, cutoff: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const done = await tx.update(factions)
        .set({ status: "lapsed" })
        .where(and(
          eq(factions.serverId, serverId),
          eq(factions.status, "reserved"),
          lte(factions.reservedUntil, cutoff),
        ))
        .returning({ id: factions.id });
      if (done.length > 0) {
        const lapsed = done.map((d) => d.id);
        await tx.delete(factionMembers)
          .where(inArray(factionMembers.factionId, lapsed));
        // Outstanding offers die with the faction. Left open they keep
        // appearing in `/faction invites` with buttons that can only ever
        // answer "no longer active", and — capped at MAX_LISTED_INVITES —
        // they crowd live invites out of the list.
        await tx.update(factionInvites)
          .set({ revokedAt: cutoff })
          .where(and(
            inArray(factionInvites.factionId, lapsed),
            isNull(factionInvites.acceptedAt),
            isNull(factionInvites.declinedAt),
            isNull(factionInvites.revokedAt),
          ));
      }
      return done.length;
    });
  }

  async reservedServers(): Promise<number[]> {
    const rows = await this.db.selectDistinct({ serverId: factions.serverId })
      .from(factions).where(eq(factions.status, "reserved"));
    return rows.map((r) => r.serverId);
  }
}
