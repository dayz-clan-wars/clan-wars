import { LINK_TO_PLAY_GRACE_MS, LINK_TO_PLAY_LIFT_MS } from "./rules";

/** One stretch of play. `to: null` means the session is still open. */
export type Interval = { from: Date; to: Date | null };

/**
 * Milliseconds of play inside [from, now]: only the overlap counts, so a
 * session that began before launch contributes just the part after it, and an
 * open session runs up to `now`.
 */
export function unlinkedPlayMs(sessions: Interval[], from: Date, now: Date): number {
  let total = 0;
  for (const s of sessions) {
    const start = Math.max(s.from.getTime(), from.getTime());
    const end = Math.min((s.to ?? now).getTime(), now.getTime());
    if (end > start) total += end - start;
  }
  return total;
}

/**
 * Whether a gamertag should be banned, lifted or closed for playing without a
 * linked Discord account.
 *
 * ⚠️ Level-triggered. Every pass recomputes what should be true from these
 * facts, like the PC gate did, so a ban never written or a lift lost on its
 * way to the database is repaired on the next tick.
 *
 * Why one lift per window (spec §4): a lift on every attempt would let
 * "start a link, get unbanned, never finish, repeat" be endless play time.
 * One lift per 24 h honours an honest attempt without that loop.
 *
 * Why losing a link is immediate (spec rule 5): an unlink would otherwise
 * hand out a fresh grace hour to anyone willing to re-link and drop.
 */
export type LinkGateFacts = {
  linked: boolean;
  /** unlinkedPlayMs since LINK_TO_PLAY_FROM. */
  playedMs: number;
  /** An identity_link_ends row after LINK_TO_PLAY_FROM. */
  linkEndedSinceFrom: boolean;
  /** Any unlinked ban row with banned_at >= FROM: the grace hour is already spent. */
  bannedSinceFrom: boolean;
  /** Unlinked rows only. */
  activeBan: "pending" | "applied" | "lift_pending" | null;
  /** Latest unlinked lifted_at. */
  lastLiftAt: Date | null;
  /** Unlinked rows lifted (or lift_pending) inside the last LINK_TO_PLAY_LIFT_WINDOW_MS. */
  liftsInWindow: number;
  /** A live verification challenge targets this dayz id. */
  attemptOpen: boolean;
  now: Date;
};

export type LinkGateAction = "none" | "ban" | "lift" | "close";

export function linkGateAction(f: LinkGateFacts): LinkGateAction {
  // Linked: the ban has done its job. Close one that is in force or queued; a
  // lift_pending row is already on its way out, so leave it alone.
  if (f.linked) return f.activeBan === "applied" || f.activeBan === "pending" ? "close" : "none";

  if (f.activeBan === "applied") {
    // ⚠️ The lift is spent per window, not per attempt (see the header).
    return f.attemptOpen && f.liftsInWindow === 0 ? "lift" : "none";
  }
  // Queued either way: the ban tick is mid-flight, wait for it.
  if (f.activeBan === "pending" || f.activeBan === "lift_pending") return "none";

  // ⚠️ Inside a lift hour with the attempt still live: no ban. Once the hour
  // ends, or the attempt is cancelled, falls through to the debt check below.
  const inLift = f.lastLiftAt !== null
    && f.lastLiftAt.getTime() + LINK_TO_PLAY_LIFT_MS > f.now.getTime();
  if (inLift && f.attemptOpen) return "none";

  // ⚠️ bannedSinceFrom keeps the hour spent: a re-rolled challenge after the
  // lift ran out must not buy a second grace hour.
  const owes = f.playedMs >= LINK_TO_PLAY_GRACE_MS || f.linkEndedSinceFrom || f.bannedSinceFrom;
  return owes ? "ban" : "none";
}
