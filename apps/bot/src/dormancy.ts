/** 7 days — the server's FlagRefreshMaxDuration. See the design's §7. */
export const DEFAULT_DORMANT_AFTER_MS = 604_800_000;
/** 14 further days before the flag, tag and pole return to the pool. */
export const DEFAULT_DISBAND_AFTER_DORMANT_MS = 1_209_600_000;

export type DormancyWindows = { dormantAfterMs: number; disbandAfterDormantMs: number };

/** Everything the decision needs. Deliberately not a faction row: this is pure. */
export type FactionClock = {
  status: string;
  /** Last raise of THIS faction's texture at THIS faction's pole. */
  lastRaiseAt: Date | null;
  dormantSince: Date | null;
};

export type Transition = "revive" | "dormant" | "disband" | "stamp" | null;

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
    if (fresh) return "revive";
    // A dormant row with no timestamp cannot be aged. Start its clock now
    // rather than guessing, and let it disband 14 days from here.
    if (c.dormantSince === null) return "stamp";
    return now.getTime() - c.dormantSince.getTime() >= w.disbandAfterDormantMs ? "disband" : null;
  }

  // `reserved` has its own 24h reservation lapse and has not raised a flag by
  // definition; `disbanded` and `lapsed` are terminal.
  if (c.status !== "active") return null;

  return fresh ? null : "dormant";
}
