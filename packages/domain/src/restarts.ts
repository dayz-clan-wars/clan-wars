import { RESTART_PERIOD_MS, RESTART_GRACE_MS } from "./rules";
export { RESTART_PERIOD_MS, RESTART_GRACE_MS };

export type RestartSlot = {
  /** The newest slot boundary at or before `now` — an even UTC hour. */
  start: Date;
  /** Inside the grace window: a slot with no row yet should fire now. */
  due: boolean;
  /** Past the grace window: a slot with no row is missed, never fired late. */
  missedIfUnhandled: boolean;
};

/** ⚠️ Pure arithmetic on the epoch: no timezone, no DST, nothing to configure. */
export function restartSlot(now: Date): RestartSlot {
  const start = new Date(Math.floor(now.getTime() / RESTART_PERIOD_MS) * RESTART_PERIOD_MS);
  const due = now.getTime() < start.getTime() + RESTART_GRACE_MS;
  return { start, due, missedIfUnhandled: !due };
}
