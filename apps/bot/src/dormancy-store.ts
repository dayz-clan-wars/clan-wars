import type { Database } from "@factions/db";
import { declarations, factions, seasons } from "@factions/db";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { FactionClock } from "./dormancy.js";
import type { DormantReason } from "@factions/domain";
import { DISBAND_WARNING_LEAD_MS } from "@factions/domain";
import { disbandFactionTx, appendFactionEventTx, noticeClanTx } from "@factions/roster/internal";

/** `DISBAND_WARNING_LEAD_MS`, in whole days — the number the warning DM names. */
const DAY_MS = 86_400_000;

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ReviveActor = { dayzId: string; gamertag: string };

/**
 * The dormant → active transition itself, shared by the dormancy clock's own
 * `PgDormancyStore.revive()` and raise-tick's "a full member raises at a
 * dormant clan's declaration" path (Task 4 brief, spec §7). Unconditional: it
 * does not check or lock `status` itself — the caller has already
 * established, inside the SAME transaction, that this faction is dormant
 * (`revive()` with a `SELECT … FOR UPDATE` immediately before calling this;
 * raise-tick with the `SELECT … FOR UPDATE` that read `status === "dormant"`
 * moments earlier in its own transaction). A `factionId` that doesn't exist
 * or isn't dormant by the time this runs is a caller bug, not a case to
 * silently ignore — hence no guard and no boolean return here; that decision
 * belongs entirely to the caller, which already made it.
 *
 * ⚠️ Clears every field a raid/dormancy cycle could have set: `dormantSince`
 * (the only thing the pre-Task-4 `revive()` cleared), plus `dormantReason`,
 * `disbandWarnedAt` and the flag-down clock (spec §5.8) — a raise-tick revive
 * can arrive with any of those set, and leaving one behind would corrupt the
 * clan's next lifecycle (a stale `disband_warned_at` suppressing a real future
 * warning, a stale `flag_down_since` reporting a siege that already ended).
 *
 * ⚠️ `actor` is optional and, when given, is spread into the `revived`
 * feed payload as `actor: <gamertag>` — exactly the raise path's shape.
 * Without one, the payload is exactly what the dormancy clock's own path
 * always produced: the clock observes a revival through `LAST_RAISE`, a
 * max(occurred_at) subquery, and never learns who made it.
 *
 * ⚠️ Also queues exactly one `revived` clan_notices row — moved here from
 * raise-tick's own call so the two callers (the dormancy clock's `revive()`
 * and raise-tick's dormant-clan raise path) cannot each queue one and
 * double-notify. The notice's payload carries `gamertag` only when an actor
 * is given, mirroring the feed row: the clock's own path has no name to
 * offer, and the renderer (Task 7) omits the name clause when it's absent.
 */
export async function reviveFactionTx(tx: Tx, factionId: number, at: Date, actor?: ReviveActor): Promise<void> {
  const [row] = await tx.update(factions)
    .set({ status: "active", dormantSince: null, dormantReason: null, disbandWarnedAt: null, flagDownSince: null, flagDownByDayzId: null })
    .where(eq(factions.id, factionId))
    .returning({ id: factions.id, serverId: factions.serverId, name: factions.name, tag: factions.tag, texture: factions.texture });
  if (!row) return;

  await appendFactionEventTx(tx, {
    serverId: row.serverId, factionId: row.id, kind: "revived", occurredAt: at,
    payload: { name: row.name, tag: row.tag, texture: row.texture, ...(actor ? { actor: actor.gamertag } : {}) },
  });
  await noticeClanTx(tx, {
    serverId: row.serverId, factionId: row.id, kind: "revived", occurredAt: at,
    payload: actor ? { gamertag: actor.gamertag } : {},
  });
}

export type FactionClockRow = FactionClock & {
  id: number;
  name: string;
  tag: string;
  leaderDiscordId: string;
};

export interface DormancyStore {
  clocks(): Promise<FactionClockRow[]>;
  goDormant(factionId: number, at: Date, reason: DormantReason, disbandAt?: Date): Promise<boolean>;
  revive(factionId: number): Promise<boolean>;
  stampDormantSince(factionId: number, at: Date): Promise<boolean>;
  /**
   * The guide's "4 days until disband" warning, once. Guarded on
   * `status = 'dormant' and disband_warned_at is null` so a second tick
   * (or a revive-then-re-dormant cycle that left the flag set) cannot
   * re-send it.
   */
  warnDisband(factionId: number, at: Date): Promise<boolean>;
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
 *
 * Joined to `declarations` for the pole, and — spec §5.1 — restricted to
 * raises by someone on the roster. Base-declaration §7: without the member
 * check any stranger could keep a dead clan's clock alive forever and its
 * flag out of the pool. The member predicate is a Filter, not an index
 * condition, and that is fine: the index has already narrowed to this pole
 * and texture; see dormancy-index-drift.test.ts.
 */
export const LAST_RAISE = sql<Date | null>`(
  select max(e.occurred_at)
  from events e
  where e.type = 'flag.raised'
    and e.server_id = ${factions.serverId}
    and e.payload->>'poleKey' = ${declarations.poleKey}
    and e.payload->>'texture' = ${factions.texture}
    and e.payload->>'dayzId' in (
      select m.dayz_id from faction_members m where m.faction_id = ${factions.id} and m.status = 'full'
    )
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

/**
 * The one query both `clocks()` and dormancy-index-drift.test.ts run. Sharing
 * the builder is what makes the drift test's EXPLAIN mean anything — a
 * hand-rolled copy in the test could drift from the real query and still
 * pass.
 */
export function clockQuery(db: Database) {
  return db.select({
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
    //
    // ⚠️ GREATEST against the server's open season's `started_at` (§5.1,
    // §8.5): the wipe clears every declaration but does not touch the clock
    // otherwise, so without this a clan whose last raise predates the wipe
    // would read as stale by the wipe's own age the instant the season
    // opens — dormant on day one of a new season through no fault of its
    // own. `greatest()` ignores nulls, so a server with no open season (or a
    // faction whose season hasn't started yet) falls straight through to the
    // coalesce, unchanged. A LEFT JOIN on `seasons`, not a correlated
    // subquery, per dormancy-index-drift.test.ts — that test's EXPLAIN
    // pins LAST_RAISE's own index usage, and a second correlated subquery
    // sitting next to it in the select list is a needless risk to that plan.
    lastRaiseAt: sql<Date | null>`greatest(coalesce(${LAST_RAISE}, ${factions.activatedAt}, ${factions.createdAt}), ${seasons.startedAt})`,
    serverLastEventAt: SERVER_LAST_EVENT,
    flagDownSince: factions.flagDownSince,
    disbandWarnedAt: factions.disbandWarnedAt,
  }).from(factions)
    // LEFT: a clan with no declaration (post-wipe, increment 4) still has a
    // clock; its LAST_RAISE is simply null and the coalesce falls through.
    .leftJoin(declarations, eq(declarations.ownerFactionId, factions.id))
    // LEFT: a server with no open season yet (before the runbook opens
    // season 1) still has a clock; seasons.started_at is simply null and
    // greatest() falls through to the coalesce.
    .leftJoin(seasons, and(eq(seasons.serverId, factions.serverId), isNull(seasons.endedAt)))
    .where(inArray(factions.status, EXAMINED));
}

export class PgDormancyStore implements DormancyStore {
  constructor(private readonly db: Database) {}

  async clocks(): Promise<FactionClockRow[]> {
    const rows = await clockQuery(this.db);

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
   *
   * ⚠️ A transaction now, so the feed row shares the guard. Without it two
   * overlapping ticks could announce the same transition twice even though
   * only one of them performed it.
   */
  async goDormant(factionId: number, at: Date, reason: DormantReason, disbandAt?: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(factions)
        .set({
          status: "dormant", dormantSince: at, dormantReason: reason,
          // §5.8: a raided clan can go dormant with the raided flag-down
          // clock still running (the raid consumer sets it, and nothing else
          // clears it once the 24h-down window has already fired). Clearing
          // it here means a later revive is not carrying a stale siege.
          flagDownSince: null, flagDownByDayzId: null,
        })
        .where(and(eq(factions.id, factionId), eq(factions.status, "active")))
        .returning({
          id: factions.id, serverId: factions.serverId,
          name: factions.name, tag: factions.tag, texture: factions.texture,
        });
      if (!row) return false;

      // Lock order (§4.12): faction_events before clan_notices.
      await appendFactionEventTx(tx, {
        serverId: row.serverId, factionId: row.id, kind: "dormant", occurredAt: at,
        // ISO 8601: jsonb has no timestamp type, and the embed parses it back.
        payload: {
          name: row.name, tag: row.tag, texture: row.texture,
          ...(disbandAt ? { disbandAt: disbandAt.toISOString() } : {}),
        },
      });
      await noticeClanTx(tx, {
        serverId: row.serverId, factionId: row.id,
        kind: reason === "raided" ? "dormant_raided" : "dormant_inactive",
        occurredAt: at, payload: {},
      });
      return true;
    });
  }

  /**
   * ⚠️ Guarded on `status = 'dormant' and disband_warned_at is null`, so only
   * the tick that actually sets the flag queues the notice — the same
   * at-most-once shape as every other transition here.
   */
  async warnDisband(factionId: number, at: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(factions)
        .set({ disbandWarnedAt: at })
        .where(and(
          eq(factions.id, factionId),
          eq(factions.status, "dormant"),
          isNull(factions.disbandWarnedAt),
        ))
        .returning({ id: factions.id, serverId: factions.serverId });
      if (!row) return false;

      await noticeClanTx(tx, {
        serverId: row.serverId, factionId: row.id, kind: "disband_warning", occurredAt: at,
        payload: { days: Math.round(DISBAND_WARNING_LEAD_MS / DAY_MS) },
      });
      return true;
    });
  }

  /**
   * ⚠️ No actor. The clock observes a revival through `LAST_RAISE`, a
   * max(occurred_at) subquery — it knows when the newest raise happened and
   * never who made it. Recovering the name means a second correlated lookup
   * per faction per tick against the index the dormancy design warns is the
   * clock's whole performance story.
   *
   * The guard (only a genuinely `dormant` row revives, and only once) is a
   * `SELECT … FOR UPDATE` in this same transaction, immediately before the
   * unconditional `reviveFactionTx` — the lock plus the status check IS the
   * guard `reviveFactionTx` itself deliberately does not perform.
   */
  async revive(factionId: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ status: factions.status }).from(factions)
        .where(eq(factions.id, factionId)).for("update");
      if (!row || row.status !== "dormant") return false;

      // The revival's own time is not recorded on the row, and the raise that
      // caused it is what the feed is announcing — but the clock only knows
      // it happened by this tick. `now` is the closest honest value, and it
      // is what `dormancy-tick` passes as `at` elsewhere.
      await reviveFactionTx(tx, factionId, new Date());
      return true;
    });
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
