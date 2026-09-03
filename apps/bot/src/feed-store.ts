import type { Database } from "@factions/db";
import { factionEvents } from "@factions/db";
import type { FactionEventKind } from "@factions/domain";
import { asc, eq, isNull, sql } from "drizzle-orm";

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The display fields an embed needs, frozen at write time.
 *
 * ⚠️ No coordinates, ever. `faction_events_no_coordinates` will reject the
 * insert, but the type is the first line of defence and the one that fails
 * at compile time rather than inside a transition's transaction.
 */
export type FeedPayload = {
  name: string;
  tag: string;
  texture: string;
  /** Gamertag. Absent on the clock-driven kinds, which have no protagonist. */
  actor?: string;
  /** `renamed` only. */
  previousName?: string;
  /** `dormant` only. ISO 8601 — jsonb has no timestamp type. */
  disbandAt?: string;
};

export type FactionEventInput = {
  serverId: number;
  factionId: number;
  kind: FactionEventKind;
  occurredAt: Date;
  payload: FeedPayload;
};

/**
 * Append one transition.
 *
 * ⚠️ Takes a `Tx`, not a `Database`, and that is the point. Called from
 * inside the transaction that performs the state change, so a crash between
 * the two is impossible. A transition with no row would never be announced
 * and nothing anywhere would notice — the transition's own evidence
 * (`dormant_since` nulled on revive, a name overwritten by a rename) is
 * exactly what this log exists to preserve, so it is gone by the time
 * anyone could look.
 *
 * ⚠️ Lock order: `factions` → `faction_members` → `faction_invites` →
 * `faction_events`. Always last. It is insert-only and nothing references
 * it, so no writer ever needs it locked before touching the roster tables.
 */
export async function appendFactionEventTx(tx: Tx, e: FactionEventInput): Promise<void> {
  await tx.insert(factionEvents).values({
    serverId: e.serverId,
    factionId: e.factionId,
    kind: e.kind,
    occurredAt: e.occurredAt,
    payload: e.payload,
  });
}

export type QueuedFactionEvent = {
  id: number;
  kind: FactionEventKind;
  occurredAt: Date;
  payload: FeedPayload;
};

export interface FeedStore {
  readUnposted(limit: number): Promise<QueuedFactionEvent[]>;
  markPosted(id: number, at: Date): Promise<void>;
}

export class PgFeedStore implements FeedStore {
  constructor(private readonly db: Database) {}

  /** ⚠️ Ascending id, always. The channel's order is the feed's whole value. */
  async readUnposted(limit: number): Promise<QueuedFactionEvent[]> {
    const rows = await this.db.select({
      id: factionEvents.id,
      kind: factionEvents.kind,
      occurredAt: factionEvents.occurredAt,
      payload: factionEvents.payload,
    })
      .from(factionEvents)
      .where(isNull(factionEvents.postedAt))
      .orderBy(asc(factionEvents.id))
      .limit(limit);

    return rows.map((r) => ({ ...r, payload: r.payload as FeedPayload }));
  }

  async markPosted(id: number, at: Date): Promise<void> {
    await this.db.update(factionEvents)
      .set({ postedAt: at })
      .where(eq(factionEvents.id, id));
  }
}

/** For the startup log when no channel is configured. See config.ts. */
export async function countUnposted(db: Database): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` })
    .from(factionEvents)
    .where(isNull(factionEvents.postedAt));
  return rows[0]?.n ?? 0;
}
