import { RAID_WINDOW } from "./rules";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RaidPhase = "open" | "closed" | "skipped";
export type SkippedWindow = { opensAt: Date; reason: string };

export type RaidWindowState = {
  phase: RaidPhase;
  /**
   * What GeneralData.disableBaseDamage should be at `when`.
   * ⚠️ The FILE's value, not the player-facing one — true means raiding is OFF.
   * Stated this way so no caller ever has to invert it at a write site.
   */
  baseDamageDisabled: boolean;
  /** The window containing `when`, or the next one if `when` is outside one. */
  opensAt: Date;
  closesAt: Date;
  /**
   * The most recent window boundary at or before `when` — the open instant while
   * the window is open, the previous close instant while it is closed.
   *
   * ⚠️ ALWAYS in the past. A flip record describes something that has already
   * happened, so every consumer keys on this and none of them derives it again.
   * Three independent derivations of it disagreed for midweek instants during the
   * pre-flight scan: the writer recorded the COMING Monday while the readers looked
   * for the PREVIOUS one, which would have left the website reading "unconfirmed"
   * every midweek forever and never posted a close announcement.
   */
  boundaryAt: Date;
  /** Set only when phase is "skipped". */
  skipReason?: string;
};

/** Midnight UTC on the most recent `dow` at or before `when` (0 = Sunday). */
function lastMidnightOn(when: Date, dow: number): Date {
  const d = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  const back = (d.getUTCDay() - dow + 7) % 7;
  return new Date(d.getTime() - back * DAY_MS);
}

/**
 * The raid window's state at `when`.
 *
 * ⚠️ The window is HALF-OPEN: [opensAt, closesAt). Monday 00:00:00.000 is closed,
 * not open. The guide promises "Friday 00:00 UTC to Monday 00:00 UTC", and a
 * window that included its own closing instant would leave base damage on for one
 * tick of the Monday — which is exactly the moment a clan stops watching.
 *
 * ⚠️ A skip suppresses the window it names, whether `when` is inside that window or
 * merely before it. Thursday's announcement and Saturday's website both have to say
 * "skipped", and they reach this function with very different `when` values.
 */
export function raidWindowAt(when: Date, skips: SkippedWindow[]): RaidWindowState {
  const lastOpen = lastMidnightOn(when, RAID_WINDOW.openDow);
  const closeOfLast = new Date(
    lastOpen.getTime() + ((RAID_WINDOW.closeDow - RAID_WINDOW.openDow + 7) % 7) * DAY_MS,
  );

  const inWindow = when >= lastOpen && when < closeOfLast;
  const opensAt = inWindow ? lastOpen : new Date(lastOpen.getTime() + 7 * DAY_MS);
  const closesAt = inWindow ? closeOfLast : new Date(closeOfLast.getTime() + 7 * DAY_MS);

  // ⚠️ The boundary already passed, never the one ahead. In the window that is
  // its open; outside it, the close that ended the PREVIOUS window — which is
  // `closesAt` shifted back one week, since closesAt is the next window's close.
  const boundaryAt = inWindow ? opensAt : new Date(closesAt.getTime() - 7 * DAY_MS);

  const skip = skips.find((s) => s.opensAt.getTime() === opensAt.getTime());
  if (skip) {
    return { phase: "skipped", baseDamageDisabled: true, opensAt, closesAt, boundaryAt, skipReason: skip.reason };
  }
  return inWindow
    ? { phase: "open", baseDamageDisabled: false, opensAt, closesAt, boundaryAt }
    : { phase: "closed", baseDamageDisabled: true, opensAt, closesAt, boundaryAt };
}
