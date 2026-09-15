import { and, eq, ne, gt, gte, lt, lte, isNull, isNotNull, or } from "drizzle-orm";
import { bans, type Database } from "@factions/db";
import { BAN_MAX_ATTEMPTS } from "@factions/domain";

/**
 * The Nitrado-facing surface this tick needs. `NitradoClient` satisfies it;
 * tests substitute a fake that records `addBans`/`removeBans` calls.
 */
export type BanTarget = {
  addBans(names: string[]): Promise<void>;
  removeBans(names: string[]): Promise<void>;
};

export type BanTickResult = { applied: number; expired: number; failed: number };

/**
 * Whether `dayzId` still needs its Nitrado ban-list entry, EXCLUDING one
 * specific row (the one the caller is currently closing out).
 *
 * ⚠️ Two simultaneously-active bans for one account share a SINGLE Nitrado
 * list entry (the entry is keyed on the identifier string, not on a ban row),
 * so removing it the moment the FIRST one expires or is lifted silently frees
 * the SECOND — the account walks free while our own `bans` table still shows
 * an `applied` row for it. One Life shipped the naive "just remove it" version
 * (CODE-REVIEW-2026-08-04.md, finding on phantom re-bans / reference counting)
 * and it failed open. Both the expire arm and the lift arm MUST call this
 * before ever touching Nitrado.
 *
 * ⚠️ `serverId`-scoped. `banTick` is called once per server, each time
 * holding that ONE server's `NitradoClient` — a ban on a DIFFERENT server for
 * the same `dayzId` is not a reason to keep THIS server's list entry, and
 * without this filter it would be counted as one anyway, producing exactly
 * the unliftable ban this whole function exists to prevent (found in review:
 * server 1's tick would see server 2's still-active row and refuse to ever
 * remove server 1's entry).
 *
 * Only counts rows that actually reached Nitrado (`dryRun = false`) and are
 * still active (`applied`, and either permanent or not yet expired) — a
 * dry-run row never put an entry on the list in the first place, so it can
 * never be a reason to keep one there.
 */
async function stillBanned(db: Database, dayzId: string, now: Date, excludingBanId: number, serverId: number): Promise<boolean> {
  const rows = await db.select({ id: bans.id }).from(bans).where(and(
    eq(bans.serverId, serverId),
    eq(bans.dayzId, dayzId),
    eq(bans.status, "applied"),
    eq(bans.dryRun, false),
    ne(bans.id, excludingBanId),
    or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
  ));
  return rows.length > 0;
}

/**
 * Reconciles ONE server's `bans` rows against ITS Nitrado ban list: applies
 * pending bans, expires bans past `expiresAt`, and lifts bans marked
 * `lift_pending`.
 *
 * ⚠️ `opts.serverId` scopes every query in this function. `client` is a
 * single server's `NitradoClient`; a query that reached across servers would
 * apply another server's ban to THIS server's list (an innocent player banned
 * from a server they never entered) and, via `stillBanned`, could count a
 * ban on a different server as a reason to never lift THIS server's entry —
 * an unliftable ban, exactly the failure mode reference-counting exists to
 * prevent. Callers run this once per registered server.
 *
 * ⚠️ `opts.dryRun` is the mode that actually ran THIS tick — callers pass
 * `config.banDryRun`, which defaults true. A dry-run row is still written and
 * still transitions status, so the audit trail shows exactly what would have
 * happened; only the Nitrado call is skipped.
 *
 * ⚠️ Every Nitrado mutation in this function is ONE batched call per arm per
 * tick, never a loop calling `addBans`/`removeBans` once per row.
 * `packages/nitrado`'s client says outright why: every mutation is a
 * whole-field read-modify-write of one `\r\n`-joined string, so N per-row
 * calls is N round trips with a lost-update window between each, silently
 * dropping entries under any concurrent writer (the restart tick shares this
 * same Nitrado service). Closing that gap was the entire point of Task 8's
 * batched `addBans`/`removeBans` pair.
 */
export async function banTick(db: Database, client: BanTarget, opts: { now?: Date; dryRun: boolean; since: Date; serverId: number }): Promise<BanTickResult> {
  const now = opts.now ?? new Date();
  const { serverId } = opts;
  const out: BanTickResult = { applied: 0, expired: 0, failed: 0 };

  // ── Age-out arm ──────────────────────────────────────────────────────
  //
  // ⚠️ Runs BEFORE the apply arm, and unconditionally (not gated on
  // `dryRun`, not limited by `BAN_MAX_ATTEMPTS`). A `pending` row with
  // `bannedAt` older than `since` (`now - BAN_APPLY_LOOKBACK_MS`, callers
  // pass a fixed lookback rather than process start time — see rules.ts) is
  // EXCLUDED from the apply query below by the `gte(bans.bannedAt, since)`
  // predicate, and without this arm such a row would sit `pending` forever:
  // never sent to Nitrado, never revisited, while `reportIncidentDb`'s prior
  // query still counts it as a standing prior offence — a ban that silently
  // never happens while still making the player's next report harsher. Aging
  // it out to `failed` makes that honest: the row stops looking like an
  // active, soon-to-apply ban and starts looking like what it is.
  const agedOut = await db.update(bans).set({
    status: "failed",
    lastError: `aged out: bannedAt was older than the ${Math.round((now.getTime() - opts.since.getTime()) / 3_600_000)}h apply lookback`,
  }).where(and(
    eq(bans.serverId, serverId),
    eq(bans.status, "pending"),
    lt(bans.bannedAt, opts.since),
  )).returning({ id: bans.id });
  out.failed += agedOut.length;

  // ── Apply arm ────────────────────────────────────────────────────────
  //
  // ⚠️ `since` BOUNDS this query. Without it, the moment BAN_DRY_RUN flips to
  // "false" the entire historical backlog of intended bans — every pending
  // row ever written, going back to the feature's first day — fires at
  // Nitrado in a single tick. One Life's unbounded detect query did exactly
  // this. Callers pass `now - BAN_APPLY_LOOKBACK_MS` (24h), NOT the bot's
  // process start time — see the comment on `BAN_APPLY_LOOKBACK_MS` in
  // `rules.ts` for why process start time is wrong. Rows older than `since`
  // are handled by the age-out arm above, not silently skipped.
  const pending = await db.select().from(bans).where(and(
    eq(bans.serverId, serverId),
    eq(bans.status, "pending"),
    gte(bans.bannedAt, opts.since),
    lt(bans.attempts, BAN_MAX_ATTEMPTS),
  ));
  if (pending.length > 0) {
    let failure: unknown;
    // A dry-run tick never reaches Nitrado, but every row IS still stamped
    // and closed, so the audit trail shows exactly what would have
    // happened. Both the dayzId and the gamertag are sent for every row —
    // the id is what survives a rename, the gamertag is what a human reads
    // on the list — both read off the FROZEN row, never re-resolved through
    // a join to the player's current name (an audit on the sister project
    // found accounts running under a different name during an active ban
    // window).
    if (!opts.dryRun) {
      const names = pending.flatMap((row) => [row.dayzId, row.gamertag]);
      try {
        await client.addBans(names);
      } catch (err) {
        failure = err;
      }
    }
    for (const row of pending) {
      if (failure === undefined) {
        await db.update(bans)
          .set({ status: "applied", appliedAt: now, dryRun: opts.dryRun, lastError: null })
          .where(and(eq(bans.id, row.id), eq(bans.status, "pending")));
        out.applied++;
      } else {
        const attempts = row.attempts + 1;
        // ⚠️ On the last permitted attempt the row must become `failed`, NOT
        // stay `pending`. A stuck `pending` renders as an active ban that no
        // later query revisits (the `attempts < BAN_MAX_ATTEMPTS` predicate
        // above excludes it forever) and no tick can ever lift — a ban that
        // is real in our database and never real on the server, with
        // nothing surfacing the gap.
        await db.update(bans).set({
          attempts,
          status: attempts >= BAN_MAX_ATTEMPTS ? "failed" : "pending",
          lastError: String(failure).slice(0, 500),
        }).where(eq(bans.id, row.id));
        if (attempts >= BAN_MAX_ATTEMPTS) out.failed++;
      }
    }
  }

  // ── Expire arm ───────────────────────────────────────────────────────
  //
  // ⚠️ `isNotNull(bans.expiresAt)` is explicit and load-bearing, not relied
  // on implicitly. `expiresAt` NULL means PERMANENT, never "unknown" (see
  // the schema comment on `bans`). A naive `expiresAt <= now` against NULL
  // is a no-match in SQL today (NULL comparisons are never true) — but this
  // predicate states the invariant outright rather than depending on that
  // behavior continuing to hold across a future rewrite of this query.
  const due = await db.select().from(bans).where(and(
    eq(bans.serverId, serverId),
    eq(bans.status, "applied"),
    isNotNull(bans.expiresAt),
    lte(bans.expiresAt, now),
  ));
  if (due.length > 0) {
    // Per row: does its OWN removal need to reach Nitrado at all? A dry-run
    // ban never put an entry on the list, and a still-referenced dayzId
    // (another active, non-dry-run ban on it) must keep its entry — decide
    // this BEFORE the batched call, then send only the names that actually
    // need to leave the list, in ONE removeBans.
    const toRemove: string[] = [];
    const removing = new Set<number>();
    for (const row of due) {
      if (!row.dryRun && !(await stillBanned(db, row.dayzId, now, row.id, serverId))) {
        toRemove.push(row.dayzId, row.gamertag);
        removing.add(row.id);
      }
    }
    let failure: unknown;
    if (toRemove.length > 0) {
      try {
        await client.removeBans(toRemove);
      } catch (err) {
        failure = err;
      }
    }
    for (const row of due) {
      if (removing.has(row.id) && failure !== undefined) {
        // Left `applied` on purpose: an expire that failed to reach Nitrado
        // must be retried next tick, not silently marked done. Only the
        // error is recorded here; the row is revisited because it still
        // matches the `applied` + past-due predicate above.
        await db.update(bans).set({ lastError: String(failure).slice(0, 500) }).where(eq(bans.id, row.id));
        continue;
      }
      await db.update(bans).set({ status: "expired" })
        .where(and(eq(bans.id, row.id), eq(bans.status, "applied")));
      out.expired++;
    }
  }

  // ── Lift arm ─────────────────────────────────────────────────────────
  //
  // ⚠️ `lift_pending` is the ONLY route to `lifted`, and only after Nitrado
  // confirms the removal (or, for a dry-run row, after this arm decides one
  // would have happened). Nothing else in this file — or anywhere else —
  // may write `status: "lifted"` directly. One Life's short-circuit left
  // players banned on the real server while the database said they were
  // free; that gap is exactly what routing every lift through this single
  // arm closes.
  const liftDue = await db.select().from(bans).where(and(
    eq(bans.serverId, serverId),
    eq(bans.status, "lift_pending"),
  ));
  if (liftDue.length > 0) {
    const toRemove: string[] = [];
    const removing = new Set<number>();
    for (const row of liftDue) {
      if (!row.dryRun && !(await stillBanned(db, row.dayzId, now, row.id, serverId))) {
        toRemove.push(row.dayzId, row.gamertag);
        removing.add(row.id);
      }
    }
    let failure: unknown;
    if (toRemove.length > 0) {
      try {
        await client.removeBans(toRemove);
      } catch (err) {
        failure = err;
      }
    }
    for (const row of liftDue) {
      if (removing.has(row.id) && failure !== undefined) {
        // Left `lift_pending` on purpose, for the same reason as the expire
        // arm: a failed Nitrado call must be retried, never silently marked
        // `lifted` (that would repeat One Life's short-circuit) and never
        // left to rot as `applied` either.
        await db.update(bans).set({ lastError: String(failure).slice(0, 500) }).where(eq(bans.id, row.id));
        continue;
      }
      await db.update(bans).set({ status: "lifted", liftedAt: now })
        .where(and(eq(bans.id, row.id), eq(bans.status, "lift_pending")));
    }
  }

  return out;
}
