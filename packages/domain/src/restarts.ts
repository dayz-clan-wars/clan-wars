import {
  RESTART_PERIOD_MS,
  RESTART_GRACE_MS,
  WEEKLY_WIPE_VEHICLES,
  ROTATION_ANCHOR_MS,
  ANNOUNCE_LEAD_MS,
} from "./rules";
export { RESTART_PERIOD_MS, RESTART_GRACE_MS, WEEKLY_WIPE_VEHICLES, ROTATION_ANCHOR_MS };

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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type WipeVehicle = { event: string; name: string };

/** UTC midnight of the Monday of `d`'s week. */
function mondayMidnightUtc(d: Date): number {
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(utc).getUTCDay(); // 0=Sun
  const backToMonday = (dow + 6) % 7;    // Mon->0, Sun->6
  return utc - backToMonday * 24 * 60 * 60 * 1000;
}

/**
 * This week's vehicle, derived from the calendar alone.
 *
 * ⚠️ Deliberately stateless. The Sunday announcement and the Monday wipe each call
 * this, minutes or a day apart, and must never disagree — a stored pointer read at two
 * moments is exactly how a bot announces Olga and wipes Gunter.
 */
export function weeklyWipeVehicle(when: Date): WipeVehicle {
  const weeks = Math.floor((mondayMidnightUtc(when) - ROTATION_ANCHOR_MS) / WEEK_MS);
  const n = WEEKLY_WIPE_VEHICLES.length;
  // ⚠️ Double modulo: JS `%` keeps the sign, so a date before the anchor would index
  // negatively and throw at runtime rather than wrapping.
  return WEEKLY_WIPE_VEHICLES[((weeks % n) + n) % n]!;
}

/**
 * The next wipe Monday at `offHour`:00Z STRICTLY after `now`.
 *
 * ⚠️ Strictly after, so that during the Monday wipe itself this already points at next
 * week. Otherwise the announce tick, seeing no row for the in-progress wipe past its
 * cutoff, would keep re-evaluating a wipe that is already happening.
 */
export function wipeMondayFor(now: Date, offHour: number): Date {
  let monday = mondayMidnightUtc(now) + offHour * 60 * 60 * 1000;
  while (monday <= now.getTime()) monday += WEEK_MS;
  return new Date(monday);
}

export function announceAtFor(wipeMonday: Date): Date {
  return new Date(wipeMonday.getTime() - ANNOUNCE_LEAD_MS);
}

/**
 * The `<active>` value one rotation event should carry for the server booting into
 * `slotStart`: 0 only if it is that week's vehicle and the slot is a Monday inside the
 * wipe window, 1 otherwise.
 *
 * ⚠️ Returns 1 for the other four on purpose — the caller converges ALL five every
 * slot. See the test: a bot down across Monday 10:00 otherwise strands that week's
 * vehicle at 0 permanently, because the rotation has moved on by the time it returns.
 */
export function rotationActiveFor(
  slotStart: Date, offHour: number, onHour: number, event: string,
): ActiveFlag {
  if (slotStart.getUTCDay() !== 1) return 1; // not a Monday
  if (weeklyWipeVehicle(slotStart).event !== event) return 1;
  const h = slotStart.getUTCHours();
  return h >= offHour && h < onHour ? 0 : 1;
}
