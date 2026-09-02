import type { Database } from "@factions/db";
import { factions } from "@factions/db";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { FactionClock } from "./dormancy.js";
import { disbandFactionTx } from "./roster-store.js";

export type FactionClockRow = FactionClock & {
  id: number;
  name: string;
  tag: string;
  leaderDiscordId: string;
};

export interface DormancyStore {
  clocks(): Promise<FactionClockRow[]>;
  goDormant(factionId: number, at: Date): Promise<boolean>;
  revive(factionId: number): Promise<boolean>;
  stampDormantSince(factionId: number, at: Date): Promise<boolean>;
  /**
   * Restart the disband countdown on a dormant row whose clock is already
   * running, because this tick could not observe the faction's server.
   *
   * ⚠️ The mirror of `stampDormantSince`, and the guards are complementary on
   * purpose: that one requires `dormant_since IS NULL`, this one requires IS
   * NOT NULL. Neither will touch a row the other owns, so `decide()` picking
   * the wrong transition produces a no-op the tick reports honestly rather
   * than a double write.
   */
  pauseDormancyClock(factionId: number, at: Date): Promise<boolean>;
  /**
   * ⚠️ Does not check server liveness. The caller — `decide()` in
   * dormancy.ts, routed through dormancy-tick.ts — is responsible for
   * confirming the server's ingest hasn't gone silent before calling this.
   * Call it directly (an admin reap command, a backfill script) and it will
   * happily disband factions on a server whose events have stopped arriving.
   */
  disbandDormant(factionId: number, dormantBefore: Date): Promise<boolean>;
}

/**
 * ⚠️ Read from `events`, NOT from `flag_changes`. The projector that fills
 * `flag_changes` does not run against the live database — it holds zero rows
 * there — so the read model would report every faction as never having raised
 * a flag. `ceremony-tick` reads the event log directly for the same reason.
 */
export const LAST_RAISE = sql<Date | null>`(
  select max(e.occurred_at)
  from events e
  where e.type = 'flag.raised'
    and e.server_id = ${factions.serverId}
    and e.payload->>'poleKey' = ${factions.poleKey}
    and e.payload->>'texture' = ${factions.texture}
)`;

/**
 * The server's newest `events` row of ANY type — the disband liveness gate's
 * evidence that ingest is still running. Deliberately not filtered to
 * `flag.raised`: a server with a live ADM feed but a faction that genuinely
 * never raises again is exactly the case disband should still catch.
 */
const SERVER_LAST_EVENT = sql<Date | null>`(
  select max(e.occurred_at)
  from events e
  where e.server_id = ${factions.serverId}
)`;

/** Statuses whose clock is worth reading. See dormancy.ts's decide(). */
export const EXAMINED = ["active", "dormant"];

export class PgDormancyStore implements DormancyStore {
  constructor(private readonly db: Database) {}

  async clocks(): Promise<FactionClockRow[]> {
    const rows = await this.db.select({
      id: factions.id,
      name: factions.name,
      tag: factions.tag,
      leaderDiscordId: factions.leaderDiscordId,
      status: factions.status,
      dormantSince: factions.dormantSince,
      // ⚠️ COALESCE, and the order matters. A faction is activated BY its flag
      // going up, so a raise normally exists; activated_at covers one whose
      // activating raise predates the ingested window, and created_at covers a
      // row with neither. Without this a faction with no ingested raise reads
      // as infinitely stale and is dormant on the first tick.
      lastRaiseAt: sql<Date | null>`coalesce(${LAST_RAISE}, ${factions.activatedAt}, ${factions.createdAt})`,
      serverLastEventAt: SERVER_LAST_EVENT,
    }).from(factions).where(inArray(factions.status, EXAMINED));

    return rows.map((r) => ({
      ...r,
      // postgres.js returns timestamptz as Date, but the value arrives through
      // a raw SQL expression rather than a typed column, so normalise rather
      // than trust the driver's mapping.
      lastRaiseAt: r.lastRaiseAt === null ? null : new Date(r.lastRaiseAt as unknown as string),
      dormantSince: r.dormantSince === null ? null : new Date(r.dormantSince as unknown as string),
      serverLastEventAt: r.serverLastEventAt === null ? null : new Date(r.serverLastEventAt as unknown as string),
    }));
  }

  /**
   * ⚠️ Every transition is guarded on the status it expects and reports
   * whether it actually moved a row. That boolean is what makes the DM
   * at-most-once: only the tick that performed the transition sends, so two
   * overlapping ticks cannot both warn the same leader.
   */
  async goDormant(factionId: number, at: Date): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ status: "dormant", dormantSince: at })
      .where(and(eq(factions.id, factionId), eq(factions.status, "active")))
      .returning({ id: factions.id });
    return rows.length > 0;
  }

  async revive(factionId: number): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ status: "active", dormantSince: null })
      .where(and(eq(factions.id, factionId), eq(factions.status, "dormant")))
      .returning({ id: factions.id });
    return rows.length > 0;
  }

  /**
   * Start the clock on a dormant row that has none. Reachable only if
   * something outside this tick set the status; see decide()'s "stamp".
   */
  async stampDormantSince(factionId: number, at: Date): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ dormantSince: at })
      .where(and(
        eq(factions.id, factionId),
        eq(factions.status, "dormant"),
        isNull(factions.dormantSince),
      ))
      .returning({ id: factions.id });
    return rows.length > 0;
  }

  /**
   * ⚠️ Guarded on `isNotNull`, the complement of `stampDormantSince`'s
   * `isNull`. A row with no timestamp belongs to that method; matching it here
   * too would let a mis-routed transition start a clock this method is only
   * supposed to restart.
   */
  async pauseDormancyClock(factionId: number, at: Date): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ dormantSince: at })
      .where(and(
        eq(factions.id, factionId),
        eq(factions.status, "dormant"),
        isNotNull(factions.dormantSince),
      ))
      .returning({ id: factions.id });
    return rows.length > 0;
  }

  /**
   * ⚠️ `isNotNull` is not redundant. `dormant_since <= cutoff` is NULL — not
   * false — for a row with no timestamp, and a guard that silently fails to
   * match is the right outcome here only by accident. Stating it makes the
   * rule "a faction is never disbanded without an observed dormancy start"
   * explicit rather than emergent from SQL three-valued logic.
   *
   * ⚠️ `lte`, matching `decide()`'s `>=` on the same boundary. `dormancyTick`
   * calls this with `dormantBefore = now - disbandAfterDormantMs`, the exact
   * instant `decide()` treats as due; a mismatched operator here (`lt`) would
   * make `decide()` say "disband" while this guard refused the row, so a row
   * exactly at the cutoff would silently sit for one extra tick before
   * disbanding anyway.
   *
   * ⚠️ This method enforces none of the server-liveness precondition. It
   * will disband a dormant row on a server whose ingest has gone silent
   * just as readily as one that's healthy — the liveness guard lives in
   * `decide()` (dormancy.ts), called through dormancy-tick.ts, not here.
   * A caller that invokes this directly (an admin reap command, a backfill
   * script) bypasses that guard and can permanently disband factions during
   * an outage.
   */
  async disbandDormant(factionId: number, dormantBefore: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => disbandFactionTx(tx, factionId, and(
      eq(factions.status, "dormant"),
      isNotNull(factions.dormantSince),
      lte(factions.dormantSince, dormantBefore),
    )!));
  }
}
