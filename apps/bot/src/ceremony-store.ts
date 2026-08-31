import type { Database } from "@factions/db";
import { whiteRaises, ceremonies, ceremonyParticipants, factions, identityLinks, events } from "@factions/db";
import type { QualifyingRaise, SettledWindow } from "@factions/ceremony";
import { parsePoleKey } from "@factions/domain";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";

export type PoleRef = { serverId: number; poleKey: string };
export type RecordedRaise = PoleRef & {
  dayzId: string; gamertag: string; occurredAt: Date; eventId: number;
};
export type Participant = { dayzId: string; discordId: string; gamertag: string };
export type CeremonyDraft = { detectedAt: Date; expiresAt: Date; participants: Participant[] };

const HOLDING = ["reserved", "active", "dormant"];

export interface CeremonyStore {
  highWaterMark(serverId: number): Promise<Date | null>;
  isPoleBound(p: PoleRef): Promise<boolean>;
  linkedDiscordId(dayzId: string): Promise<string | null>;
  recordRaise(r: RecordedRaise): Promise<void>;
  polesWithPendingRaises(): Promise<PoleRef[]>;
  pendingRaises(p: PoleRef): Promise<QualifyingRaise[]>;
  hasOpenCeremony(p: PoleRef): Promise<boolean>;
  settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null>;
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
}
