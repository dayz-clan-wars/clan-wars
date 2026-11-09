import { RESTART_PERIOD_MS, nextRestartAt } from "@factions/domain";

/**
 * The timer bar under the server-name marquee: the next scheduled restart. A pure
 * function of a clock, so the server can render the first frame and the client
 * can go on ticking from the same arithmetic.
 *
 * Until raiding went 24/7 (unreleased after v2.21.0) a second column counted the
 * weekend raid window down; it went with the window.
 */

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

/** The restart column: mm:ss to `nextAt`, its rule draining as the slot approaches. */
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

/** The restart column's first frame, for the map's compact clock (map/map-timers.tsx). null is nothing to show. */
export type TimerColumns = { restart: RestartColumn | null };

/**
 * The bar's restart column as plain data, from one clock read — the map renders
 * it in its own bar, client-side. No scheduled restarts is no column, never a
 * confident clock.
 */
export function timerColumns(restartsScheduled: boolean, now: Date): TimerColumns {
  return { restart: restartsScheduled ? restartColumn(nextRestartAt(now), now) : null };
}
