import { HUB_COMBAT_FROM, HUB_POSITION, HUB_ZONE_MIN_ALTITUDE_M, HUB_ZONE_RADIUS_M } from "./rules";
import type { Vec3 } from "./vec3";

/** A position as stored in an event payload (jsonb), or null. Never trusts the shape. */
export function readVec3(v: unknown): Vec3 | null {
  if (typeof v !== "object" || v === null) return null;
  const { x, y, z } = v as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof z === "number"
    && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

// History, not a live rule. The Fast Travel Hub and its no-combat ban are gone
// (the ban tick, hub-tick.ts, went with them; `hub_combat` stays a ban reason for
// old rows). atHub and hubKillDiscredited stay so `rebuild:kills` reproduces the
// old `kills.at_hub` flags exactly; with no Hub in the sky they never match a new kill.

/**
 * Inside the Hub's no-combat cylinder. `y` is altitude (vec3.ts).
 * A missing position is never inside: an event we cannot place is not an
 * offence, and a kill we cannot place still scores.
 */
export function atHub(pos: Vec3 | null): boolean {
  if (pos === null) return false;
  return pos.y >= HUB_ZONE_MIN_ALTITUDE_M
    && Math.hypot(pos.x - HUB_POSITION.x, pos.z - HUB_POSITION.z) <= HUB_ZONE_RADIUS_M;
}

/**
 * Whether a kill scores nowhere because it was made at the Hub: in the zone
 * (either party, the caller's `atHub`) AND made once the rule existed.
 * Bans do not ask this — they are forward-only by their own cursor seed.
 */
export function hubKillDiscredited(inZone: boolean, at: Date): boolean {
  return inZone && at.getTime() >= HUB_COMBAT_FROM.getTime();
}
