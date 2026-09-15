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
 * Only counts rows that actually reached Nitrado (`dryRun = false`) and are
 * still active (`applied`, and either permanent or not yet expired) — a
 * dry-run row never put an entry on the list in the first place, so it can
 * never be a reason to keep one there.
 */
async function stillBanned(db: Database, dayzId: string, now: Date, excludingBanId: number): Promise<boolean> {
  const rows = await db.select({ id: bans.id }).from(bans).where(and(
    eq(bans.dayzId, dayzId),
    eq(bans.status, "applied"),
    eq(bans.dryRun, false),
    ne(bans.id, excludingBanId),
    or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
  ));
  return rows.length > 0;
}

/**
 * Reconciles the `bans` table against the Nitrado ban list: applies pending
 * bans, expires bans past `expiresAt`, and lifts bans marked `lift_pending`.
 *
 * ⚠️ `opts.dryRun` is the mode that actually ran THIS tick — callers pass
 * `config.banDryRun`, which defaults true. A dry-run row is still written and
 * still transitions status, so the audit trail shows exactly what would have
 * happened; only the Nitrado call is skipped.
 */
export async function banTick(db: Database, client: BanTarget, opts: { now?: Date; dryRun: boolean; since: Date }): Promise<BanTickResult> {
  const now = opts.now ?? new Date();
  const out: BanTickResult = { applied: 0, expired: 0, failed: 0 };

  // ── Apply arm ────────────────────────────────────────────────────────
  //
  // ⚠️ `since` BOUNDS this query. Without it, the moment BAN_DRY_RUN flips to
  // "false" the entire historical backlog of intended bans — every pending
  // row ever written, going back to the feature's first day — fires at
  // Nitrado in a single tick. One Life's unbounded detect query did exactly
  // this. Task 10 passes the bot's process start time as `since`, so only
  // bans that became pending after the bot itself came up this run are ever
  // candidates for a live Nitrado call.
  const pending = await db.select().from(bans).where(and(
    eq(bans.status, "pending"),
    gte(bans.bannedAt, opts.since),
    lt(bans.attempts, BAN_MAX_ATTEMPTS),
  ));
  for (const row of pending) {
    try {
      // A dry-run row never reaches Nitrado, but IS stamped and closed, so
      // the audit trail shows exactly what would have happened. Both the
      // dayzId and the gamertag are sent — the id is what survives a rename,
      // the gamertag is what a human reads on the list — both read off the
      // FROZEN row, never re-resolved through a join to the player's current
      // name (an audit on the sister project found accounts running under a
      // different name during an active ban window).
      if (!opts.dryRun) await client.addBans([row.dayzId, row.gamertag]);
      await db.update(bans)
        .set({ status: "applied", appliedAt: now, dryRun: opts.dryRun, lastError: null })
        .where(and(eq(bans.id, row.id), eq(bans.status, "pending")));
      out.applied++;
    } catch (err) {
      const attempts = row.attempts + 1;
      // ⚠️ On the last permitted attempt the row must become `failed`, NOT
      // stay `pending`. A stuck `pending` renders as an active ban that no
      // later query revisits (the `attempts < BAN_MAX_ATTEMPTS` predicate
      // above excludes it forever) and no tick can ever lift — a ban that is
      // real in our database and never real on the server, with nothing
      // surfacing the gap.
      await db.update(bans).set({
        attempts,
        status: attempts >= BAN_MAX_ATTEMPTS ? "failed" : "pending",
        lastError: String(err).slice(0, 500),
      }).where(eq(bans.id, row.id));
      if (attempts >= BAN_MAX_ATTEMPTS) out.failed++;
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
    eq(bans.status, "applied"),
    isNotNull(bans.expiresAt),
    lte(bans.expiresAt, now),
  ));
  for (const row of due) {
    try {
      // A dry-run ban never put an entry on Nitrado's list, so there is
      // nothing to remove — and reference-count first: another still-active
      // ban on this same dayzId may be relying on the very entry this row
      // would otherwise remove out from under it.
      if (!row.dryRun && !(await stillBanned(db, row.dayzId, now, row.id))) {
        await client.removeBans([row.dayzId, row.gamertag]);
      }
      await db.update(bans).set({ status: "expired" })
        .where(and(eq(bans.id, row.id), eq(bans.status, "applied")));
      out.expired++;
    } catch (err) {
      // Left `applied` on purpose: an expire that failed to reach Nitrado
      // must be retried next tick, not silently marked done. Only the error
      // is recorded here; the row is revisited because it still matches the
      // `applied` + past-due predicate above.
      await db.update(bans).set({ lastError: String(err).slice(0, 500) }).where(eq(bans.id, row.id));
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
  const liftDue = await db.select().from(bans).where(eq(bans.status, "lift_pending"));
  for (const row of liftDue) {
    try {
      if (!row.dryRun && !(await stillBanned(db, row.dayzId, now, row.id))) {
        await client.removeBans([row.dayzId, row.gamertag]);
      }
      await db.update(bans).set({ status: "lifted", liftedAt: now })
        .where(and(eq(bans.id, row.id), eq(bans.status, "lift_pending")));
    } catch (err) {
      // Left `lift_pending` on purpose, for the same reason as the expire
      // arm: a failed Nitrado call must be retried, never silently marked
      // `lifted` (that would repeat One Life's short-circuit) and never left
      // to rot as `applied` either.
      await db.update(bans).set({ lastError: String(err).slice(0, 500) }).where(eq(bans.id, row.id));
    }
  }

  return out;
}
