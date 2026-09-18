import {
  BAN_BASE_MS, BAN_BREACH_MS, BAN_GATE_MS, BAN_PER_DISMANTLE_MS,
  BAN_FIRST_OFFENCE_CAP_MS, BAN_REPEAT_MULTIPLIER, BAN_PERMANENT_AT_OFFENCE,
  BOOST_STACK_MIN_ITEMS, BOOST_STACK_RADIUS_M, BOOST_STACK_MIN_RISE_M, BOOST_STACK_WINDOW_MS,
} from "./rules";

/** What one closed incident cost the base, as counted from the log. */
export type IncidentDamage = {
  partsDismantled: number;
  partsBuilt: number;
  stackItems: number;
  hasBreach: boolean;
  hasGate: boolean;
};

/**
 * The ban term for an incident, in ms. `null` means permanent.
 *
 * `priorOffences` is the number of upheld reports already standing against
 * this dayz_id THIS SEASON — 0 for a first offence.
 *
 * ⚠️ The cap applies BEFORE the repeat multiplier: the cap is a first-offence
 * mercy, not a ceiling on the whole ladder, so a second offence can reach
 * twice it.
 */
export function sentenceMsFor(damage: IncidentDamage, priorOffences: number): number | null {
  if (priorOffences >= BAN_PERMANENT_AT_OFFENCE - 1) return null;
  let ms = BAN_BASE_MS;
  if (damage.hasBreach) ms += BAN_BREACH_MS;
  if (damage.hasGate) ms += BAN_GATE_MS;
  ms += damage.partsDismantled * BAN_PER_DISMANTLE_MS;
  ms = Math.min(ms, BAN_FIRST_OFFENCE_CAP_MS);
  return priorOffences === 0 ? ms : ms * BAN_REPEAT_MULTIPLIER;
}

/**
 * One boost-item placement inside a zone, as recorded by the log.
 *
 * `eventId` is inert data for `boostStackFor` — it never reads it — carried
 * only so a caller can record one `zone_violations` row per cluster member,
 * keyed on that member's own event, once a stack forms.
 */
export type BoostPlacement = {
  dayzId: string;
  eventId: number;
  x: number;
  y: number;
  z: number;
  occurredAt: Date;
};

/**
 * The placements forming a boost stack with `latest`, chronologically, or
 * null if this is ordinary cooking or farming.
 *
 * `recent` is every boost placement already recorded in the same zone, and
 * must NOT include `latest`. Callers bound it by BOOST_STACK_WINDOW_MS at the
 * query; the filter here is belt-and-braces and also drops anything dated
 * after `latest` (a replayed or out-of-order event).
 */
export function boostStackFor(
  recent: readonly BoostPlacement[], latest: BoostPlacement,
): BoostPlacement[] | null {
  const end = latest.occurredAt.getTime();
  const near = recent.filter((p) => {
    const t = p.occurredAt.getTime();
    if (t > end || end - t > BOOST_STACK_WINDOW_MS) return false;
    return Math.hypot(p.x - latest.x, p.z - latest.z) <= BOOST_STACK_RADIUS_M;
  });
  const cluster = [...near, latest].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (cluster.length < BOOST_STACK_MIN_ITEMS) return null;
  // A RISE over time, not a spread: the player climbed as they stacked.
  const rise = cluster[cluster.length - 1]!.y - cluster[0]!.y;
  if (rise < BOOST_STACK_MIN_RISE_M) return null;
  return cluster;
}

export const VIOLATION_KINDS = ["dismantle", "build", "gate", "stack"] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

/**
 * ⚠️ `pending` means "not yet on the Nitrado list". A Nitrado error must move
 * the row to `failed`, never leave it `pending` — a stuck `pending` renders
 * as a ban that no query ever revisits and no tick can ever lift.
 * `lift_pending` is the only route to `lifted`: never short-circuit.
 */
export const BAN_STATUSES = ["pending", "applied", "lift_pending", "lifted", "expired", "failed"] as const;
export type BanStatus = (typeof BAN_STATUSES)[number];
/** A Nitrado error this many times moves the row to `failed`. */
export const BAN_MAX_ATTEMPTS = 3;

/**
 * Why a ban exists. ⚠️ Load-bearing: the PC-gate tick lifts a ban when the
 * player starts linking, and without this column it would also lift a ban
 * somebody earned by griefing inside another clan's base.
 */
export const BAN_REASONS = ["zone", "unlinked_pc"] as const;
export type BanReason = (typeof BAN_REASONS)[number];
