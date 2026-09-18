import type { BaseDamageWindow } from "@factions/roster";
import { RESTART_PERIOD_MS } from "@factions/domain";

/**
 * The two-column timer bar under the server-name marquee: the raid window on
 * the left, the next scheduled restart on the right. Both columns are a pure
 * function of a window and a clock, so the server can render the first frame
 * and the client can go on ticking from the same arithmetic.
 */

export type RaidTone = "live" | "muted" | "warn";

export type RaidColumn = {
  /** "Ends in", "Starts in", "Skipped", "Opening", "Closing". */
  label: string;
  /** The countdown, or the words that stand in for one. */
  value: string;
  /** A muted aside beside the value — today only a skip's reason. "" when there is none. */
  detail: string;
  /**
   * The instant `value` counts down to, as ISO, or null when the value is not a
   * clock at all. ⚠️ null is what stops the client ticking a column whose value is
   * words: a skipped weekend and an unconfirmed flip have nothing to count to, and
   * a countdown there would invent one.
   */
  target: string | null;
  tone: RaidTone;
  /** 0–1 of the rule under the column, filling left to right as the window is used up. */
  fill: number;
};

export type RestartColumn = {
  /** mm:ss. The minutes field is not bounded by 99 — a period is 120 minutes. */
  value: string;
  /** Inside the last ten minutes: the column and its rule go gold. */
  soon: boolean;
  /** 0–1 of the rule, DRAINING — this one is time left, not time spent. */
  fill: number;
};

/**
 * Ten minutes out, the column starts shouting.
 *
 * ⚠️ Deliberately its own constant and not `RESTART_GRACE_MS`, which happens to
 * be ten minutes too. That one is how late the tick may fire; this one is how
 * long a player has to get somewhere safe. Two facts, and tying them together
 * would move this the next time the grace window is tuned.
 */
export const RESTART_SOON_MS = 10 * 60_000;

/** "14h", "2d 0h", "38m" — coarse on purpose; a raid window is days long and a ticking clock invites reloading. */
export function humanizeUntil(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/** How far `now` has travelled from `from` to `to`, never off either end of the rule. */
function span(from: Date, to: Date, now: Date): number {
  const total = to.getTime() - from.getTime();
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - from.getTime()) / total));
}

/**
 * The left column.
 *
 * ⚠️ `w.boundaryAt` is the last boundary passed — this window's open while it is
 * open, the PREVIOUS close while it is closed — and it is read as given. The rule
 * fills from there to the instant ahead, and re-deriving the midweek case here as
 * "a week before closesAt" is the drift `base-damage-window.ts` has a ⚠️ about.
 */
export function raidColumn(w: BaseDamageWindow, now: Date): RaidColumn {
  switch (w.status) {
    case "live":
      return {
        label: "Ends in",
        value: humanizeUntil(now, w.closesAt),
        detail: "",
        target: w.closesAt.toISOString(),
        tone: "live",
        fill: span(w.boundaryAt, w.closesAt, now),
      };
    case "closed":
      return {
        label: "Starts in",
        value: humanizeUntil(now, w.opensAt),
        detail: "",
        target: w.opensAt.toISOString(),
        tone: "muted",
        fill: span(w.boundaryAt, w.opensAt, now),
      };
    case "skipped":
      return { label: "Skipped", value: "this week", detail: w.skipReason ?? "", target: null, tone: "muted", fill: 0 };
    case "unconfirmed":
      // ⚠️ Never the live styling and never a countdown. The boundary passed with
      // no confirmed flip, so whether base damage is on is genuinely unknown —
      // and "Opening" on a missing CLOSE would be the wrong word in the
      // reassuring direction, which is the direction this bar never takes.
      return {
        label: w.pending === "close" ? "Closing" : "Opening",
        value: "unconfirmed",
        detail: "",
        target: null,
        tone: "warn",
        fill: 0,
      };
  }
}

/** The right column: mm:ss to `nextAt`, its rule draining as the slot approaches. */
export function restartColumn(nextAt: Date, now: Date): RestartColumn {
  const left = Math.max(0, nextAt.getTime() - now.getTime());
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return {
    value: `${mm}:${ss}`,
    soon: left <= RESTART_SOON_MS,
    fill: Math.min(1, left / RESTART_PERIOD_MS),
  };
}
