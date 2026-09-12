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

/** `<active>` value an `events.xml` event should carry. */
export type ActiveFlag = 0 | 1;

/**
 * Truck wipe (level-triggered): the `<active>` value the events.xml entries
 * should carry for the server about to boot into `slotStart`. `0` inside
 * [offHour, onHour), `1` everywhere else; a window whose `onHour` is less than
 * its `offHour` wraps past midnight.
 *
 * ⚠️ Deliberately a total function of the slot, not a reaction to the two
 * boundary hours. An edge-triggered version — write 0 at 08:00, write 1 at
 * 10:00 — leaves the trucks disabled for a full day the first time the 10:00
 * write fails or the bot is down for that slot, with nothing to put them back.
 * Because every slot computes the state it wants and the caller skips a write
 * that would change nothing, the 10 daily no-op slots are what makes the wipe
 * self-healing.
 */
export function truckWipeActive(slotStart: Date, offHour: number, onHour: number): ActiveFlag {
  const h = slotStart.getUTCHours();
  const inWindow = offHour <= onHour
    ? h >= offHour && h < onHour
    : h >= offHour || h < onHour; // wraps past midnight
  return inWindow ? 0 : 1;
}
