import type { Database } from "@factions/db";
import { whiteRaises, ceremonies, ceremonyParticipants, declarations, factions, factionInvites, factionMembers, identityLinks, events } from "@factions/db";
import type { QualifyingRaise, SettledWindow } from "@factions/ceremony";
import { parsePoleKey } from "@factions/domain";
import { and, asc, eq, inArray, isNotNull, isNull, lte, max } from "drizzle-orm";
import { appendFactionEventTx } from "@factions/roster/internal";
import { lockDeclarations, releaseTx } from "@factions/declarations";

export type PoleRef = { serverId: number; poleKey: string };
export type RecordedRaise = PoleRef & {
  dayzId: string; gamertag: string; occurredAt: Date; eventId: number;
};
export type Participant = { dayzId: string; discordId: string; gamertag: string };
export type CeremonyDraft = { detectedAt: Date; expiresAt: Date; participants: Participant[] };

export interface CeremonyStore {
  highWaterMark(serverId: number): Promise<Date | null>;
  isPoleBound(p: PoleRef): Promise<boolean>;
  soloDeclarantAt(p: PoleRef): Promise<string | null>;
  linkedDiscordId(dayzId: string): Promise<string | null>;
  recordRaise(r: RecordedRaise): Promise<void>;
  polesWithPendingRaises(): Promise<PoleRef[]>;
  pendingRaises(p: PoleRef): Promise<QualifyingRaise[]>;
  hasOpenCeremony(p: PoleRef): Promise<boolean>;
  settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null>;
  openCeremonyServers(): Promise<number[]>;
  reservedFactionAt(p: PoleRef, texture: string): Promise<{ id: number } | null>;
  isRosterMember(factionId: number, dayzId: string): Promise<boolean>;
  activate(factionId: number, at: Date, actor?: string): Promise<boolean>;
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

  /** Bound to a CLAN. A solo declaration does not bind a pole for ceremony purposes — see settlePole. */
  async isPoleBound(p: PoleRef): Promise<boolean> {
    const [row] = await this.db.select({ id: declarations.id }).from(declarations)
      .where(and(
        eq(declarations.serverId, p.serverId),
        eq(declarations.poleKey, p.poleKey),
        isNotNull(declarations.ownerFactionId),
      ));
    return row !== undefined;
  }

  async soloDeclarantAt(p: PoleRef): Promise<string | null> {
    const [row] = await this.db.select({ dayzId: declarations.ownerDayzId }).from(declarations)
      .where(and(eq(declarations.serverId, p.serverId), eq(declarations.poleKey, p.poleKey)));
    return row?.dayzId ?? null;
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
      .innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
      .where(and(
        eq(factions.serverId, p.serverId),
        eq(declarations.serverId, p.serverId),
        eq(declarations.poleKey, p.poleKey),
        eq(factions.texture, texture),
        eq(factions.status, "reserved"),
      ));
    return row ?? null;
  }

  /** Activation counts a FULL member's raise only (spec §5.1). */
  async isRosterMember(factionId: number, dayzId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(
        eq(factionMembers.factionId, factionId),
        eq(factionMembers.dayzId, dayzId),
        eq(factionMembers.status, "full"),
      ));
    return row !== undefined;
  }

  /**
   * Guarded on `reserved`: a concurrent lapse must not be overwritten.
   *
   * ⚠️ Now a transaction, because the feed row must land with the status
   * change or not at all. The `.returning()` carries the identity fields so
   * the payload is frozen here rather than re-read at post time — by the
   * time a late post ran, a rename could already have changed the name.
   */
  async activate(factionId: number, at: Date, actor?: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(factions)
        .set({ status: "active", activatedAt: at, reservedUntil: null })
        .where(and(eq(factions.id, factionId), eq(factions.status, "reserved")))
        .returning({
          id: factions.id, serverId: factions.serverId,
          name: factions.name, tag: factions.tag, texture: factions.texture,
        });

      if (!row) return false;

      await appendFactionEventTx(tx, {
        serverId: row.serverId, factionId: row.id, kind: "activated", occurredAt: at,
        payload: { name: row.name, tag: row.tag, texture: row.texture, actor },
      });
      return true;
    });
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
        // name/tag/texture frozen here, at the moment of the transition —
        // the same reasoning as activate()'s and goDormant()'s own
        // .returning(): a late-posted feed row must not pick up a rename
        // that happened after the fact.
        .returning({ id: factions.id, serverId: factions.serverId, name: factions.name, tag: factions.tag, texture: factions.texture });
      if (done.length > 0) {
        const lapsed = done.map((d) => d.id);
        // Lock order (spec §4.12): factions → declarations → faction_members
        // → ... . The release must happen here, before the faction_members
        // delete below, or this transaction takes declarations after members
        // — the same ordering violation the controller ruled out for disband.
        //
        // Guide ch. 4: a lapsed pole gets the 3-day grace before going public.
        //
        // ⚠️ Take the server's declaration lock before releasing more than one
        // row. Without it, two lapses here (d1 then d2) against a concurrent
        // declareTx whose FOR UPDATE scan holds d2 and waits on d1 is a
        // deadlock — the advisory lock is what serialises us behind it.
        if (lapsed.length > 0) await lockDeclarations(tx, serverId);
        for (const id of lapsed) await releaseTx(tx, { factionId: id }, cutoff);
        await tx.delete(factionMembers)
          .where(inArray(factionMembers.factionId, lapsed));
        // Outstanding offers die with the faction. Left open they keep
        // appearing in the invitee's pending-invites list as offers that can
        // only ever answer "no longer active", and — capped at
        // MAX_LISTED_INVITES — they crowd live invites out of the list.
        await tx.update(factionInvites)
          .set({ revokedAt: cutoff })
          .where(and(
            inArray(factionInvites.factionId, lapsed),
            isNull(factionInvites.acceptedAt),
            isNull(factionInvites.declinedAt),
            isNull(factionInvites.revokedAt),
          ));
        // Lock order (§4.12): faction_events last, after every roster write
        // above. The frozen name/tag/texture came off the update's own
        // .returning(), so a rename racing this transaction cannot leak in.
        for (const f of done) {
          await appendFactionEventTx(tx, {
            serverId: f.serverId, factionId: f.id, kind: "lapsed", occurredAt: cutoff,
            payload: { name: f.name, tag: f.tag, texture: f.texture },
          });
        }
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
