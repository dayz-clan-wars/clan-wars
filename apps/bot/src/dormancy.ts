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
  /**
   * Newest `events` row for THIS faction's server, of any type. The only
   * evidence the tick has that ingest is even running. Distinct from
   * `lastRaiseAt`: a faction can go quiet while its server is still very much
   * alive — that is ordinary dormancy — but if the SERVER has gone quiet, no
   * faction on it can be trusted to be truly abandoned rather than merely
   * un-ingested. See the disband gate below.
   */
  serverLastEventAt: Date | null;
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
    // >=, matching `fresh`'s boundary convention: the store's own guard uses
    // the same operator (`lte`), so a row exactly at the cutoff is not left
    // in limbo — counted as due here but refused there for one extra tick.
    const due = now.getTime() - c.dormantSince.getTime() >= w.disbandAfterDormantMs;
    if (!due) return null;

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
    return serverLive ? "disband" : null;
  }

  // `reserved` has its own 24h reservation lapse and has not raised a flag by
  // definition; `disbanded` and `lapsed` are terminal.
  if (c.status !== "active") return null;

  return fresh ? null : "dormant";
}
