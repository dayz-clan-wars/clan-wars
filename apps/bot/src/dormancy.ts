import { DORMANT_AFTER_MS, DISBAND_AFTER_DORMANT_MS, FLAG_DOWN_MS, DISBAND_WARNING_LEAD_MS } from "@factions/domain";

/** Re-exported under the names the bot has used since dormancy shipped; the value lives in rules.ts. */
export const DEFAULT_DORMANT_AFTER_MS = DORMANT_AFTER_MS;
export const DEFAULT_DISBAND_AFTER_DORMANT_MS = DISBAND_AFTER_DORMANT_MS;

export type DormancyWindows = { dormantAfterMs: number; disbandAfterDormantMs: number };

/** Everything the decision needs. Deliberately not a faction row: this is pure. */
export type FactionClock = {
  status: string;
  /** Last raise of THIS faction's texture at THIS faction's pole. */
  lastRaiseAt: Date | null;
  dormantSince: Date | null;
  /**
   * Newest `events` row for THIS faction's server, of any type. The only
   * evidence the tick has that ingest is even running. Distinct from
   * `lastRaiseAt`: a faction can go quiet while its server is still very much
   * alive — that is ordinary dormancy — but if the SERVER has gone quiet, no
   * faction on it can be trusted to be truly abandoned rather than merely
   * un-ingested. See the disband gate below.
   */
  serverLastEventAt: Date | null;
  /**
   * §5.8: when this faction's own flag was last observed down at its own
   * pole, `null` when it is currently up (or was never observed down). The
   * raid consumer starts this clock; the raise consumer (a defense) and the
   * dormancy store's own transitions (goDormant, revive) clear it.
   */
  flagDownSince: Date | null;
  /** When the "N days until disband" warning was sent, `null` if it hasn't been. */
  disbandWarnedAt: Date | null;
};

/**
 * `pause` re-stamps `dormant_since` to now, restarting the disband countdown.
 *
 * It fires while the faction's SERVER looks dark, and it exists because the
 * countdown is supposed to measure *observed* silence. A `dormant_since`
 * stamped during an ingest outage was stamped from evidence that did not exist
 * yet, and letting it age through the blind window disbands a faction on less
 * proven silence than the window promises — see the inbox-26 replay in
 * dormancy.test.ts, which disbanded on 11 days rather than 14.
 */
export type Transition = "revive" | "dormant" | "dormant-raided" | "warn" | "disband" | "stamp" | "pause" | null;

/**
 * What should happen to one faction, given its clock.
 *
 * Pure so every boundary is testable without a database — and so the store
 * applies decisions rather than making them.
 *
 * ⚠️ Revive is evaluated BEFORE disband. A faction that raises its flag on day
 * 20 of dormancy must be rescued by the tick that could otherwise have
 * disbanded it: disband is the only transition here that destroys identity,
 * and its outcome must not depend on when the tick happened to run.
 */
export function decide(c: FactionClock, now: Date, w: DormancyWindows): Transition {
  // Strictly greater: a raise exactly at the window boundary is already stale,
  // because the server's own decay has begun by then.
  const fresh = c.lastRaiseAt !== null
    && c.lastRaiseAt.getTime() > now.getTime() - w.dormantAfterMs;

  if (c.status === "dormant") {
    // A dormant row with no timestamp cannot be aged. Start its clock now
    // rather than guessing, and let it disband 14 days from here.
    //
    // ⚠️ Checked BEFORE the revive and pause below. Revive now compares against
    // `dormant_since`, so it needs the stamp to exist; and though `stamp` and
    // `pause` both write `dormant_since = now`, the store guards them
    // differently — `stamp` requires IS NULL and `pause` requires IS NOT NULL —
    // so choosing the wrong one produces an update that matches no row and a
    // tick that reports having done something it did not.
    if (c.dormantSince === null) return "stamp";

    // ⚠️ A raise AFTER the clan went dormant, not merely a recent one. For the
    // inactive entrance this is equivalent to "fresh": `dormant_since` is
    // stamped precisely when `lastRaiseAt` went stale, so any newer raise
    // satisfies it. For the raided entrance (§5.8) it is the whole point — a
    // raided clan was, by construction, raising its flag right up to the raid,
    // so "fresh" would revive it on the very next tick with nobody having
    // raised anything.
    if (c.lastRaiseAt !== null && c.lastRaiseAt.getTime() > c.dormantSince.getTime()) return "revive";

    // ⚠️ Liveness gate: disband is the one transition here that destroys
    // identity, and its only evidence of a faction's silence is rows in
    // `events`. If the SERVER itself has produced no event in the last
    // `dormantAfterMs`, ingest is presumably down (crash loop, expired
    // Nitrado credentials, a stalled ADM fetch) and every faction on it
    // reads as stale regardless of what its players actually did. Going
    // dormant is still allowed above — it is reversible and only cuts
    // supplies — but disband must wait for the server to prove it is
    // watching again.
    const serverLive = c.serverLastEventAt !== null
      && c.serverLastEventAt.getTime() > now.getTime() - w.dormantAfterMs;

    // ⚠️ Ahead of the `due` check, not after it, and that ordering is the
    // whole fix. Withholding the disband while blind was never enough: the
    // clock kept running through the outage, so the faction disbanded on the
    // first tick after recovery having been *watched* for less than the full
    // window. Pausing restarts the countdown from the moment observation
    // resumed, which is the only interval the window can honestly claim.
    //
    // The cost is a write per dormant faction per tick for as long as the
    // outage lasts. That is a handful of rows on a table with a handful of
    // rows, and only while something is already badly wrong.
    if (!serverLive) return "pause";

    const age = now.getTime() - c.dormantSince.getTime();
    // >=, matching `fresh`'s boundary convention: the store's own guard uses
    // the same operator (`lte`), so a row exactly at the cutoff is not left
    // in limbo — counted as due here but refused there for one extra tick.
    if (age >= w.disbandAfterDormantMs) return "disband";
    // The guide's "4 days until…" warning, once. Same liveness gate as
    // disband: an unobserved week must not warn early, because the age we're
    // measuring is only as trustworthy as the server proving it's still
    // watched (checked above).
    if (c.disbandWarnedAt === null && age >= w.disbandAfterDormantMs - DISBAND_WARNING_LEAD_MS) return "warn";
    return null;
  }

  // `reserved` has its own 24h reservation lapse and has not raised a flag by
  // definition; `disbanded` and `lapsed` are terminal.
  if (c.status !== "active") return null;

  // ⚠️ The raided entrance first (spec §5.8): a flag down for FLAG_DOWN_MS is
  // dormant even if the 7-day clock is fresh. Checked before `fresh` is
  // consulted below, because a raid can knock a flag down well inside a
  // week of otherwise-normal upkeep raises.
  if (c.flagDownSince !== null && now.getTime() - c.flagDownSince.getTime() >= FLAG_DOWN_MS) {
    return "dormant-raided";
  }

  return fresh ? null : "dormant";
}
