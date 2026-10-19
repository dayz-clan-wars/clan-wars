import { HUB_COMBAT_FROM, HUB_POSITION, HUB_TRAP_CLASSES, HUB_ZONE_MIN_ALTITUDE_M, HUB_ZONE_RADIUS_M } from "./rules";
import type { Vec3 } from "./vec3";

/** A position as stored in an event payload (jsonb), or null. Never trusts the shape. */
export function readVec3(v: unknown): Vec3 | null {
  if (typeof v !== "object" || v === null) return null;
  const { x, y, z } = v as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof z === "number"
    && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

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

export type HubOffence = { offender: string; gamertag: string; victim: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const TRAPS: ReadonlySet<string> = new Set(HUB_TRAP_CLASSES);
/** Which payload keys name the attacker, per event type. */
const ATTACKER: Record<string, { id: string; name: string; pos: string }> = {
  "player.hit": { id: "attackerDayzId", name: "attackerGamertag", pos: "attackerPos" },
  "player.killed": { id: "killerDayzId", name: "killerGamertag", pos: "killerPos" },
};

/**
 * Who, if anyone, this one event makes an offender at the Hub. Pure: the
 * self-defence exemption needs the event log and is the caller's (hub-tick.ts).
 * `victim` is null for a placement — there is nobody to have hit first.
 */
export function hubOffence(type: string, payload: unknown): HubOffence | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (type === "item.placed") {
    const offender = str(p.dayzId);
    if (!offender || !TRAPS.has(String(p.itemClass)) || !atHub(readVec3(p.pos))) return null;
    return { offender, gamertag: str(p.gamertag) ?? offender, victim: null };
  }
  const keys = ATTACKER[type];
  if (!keys) return null;
  // ⚠️ A hit's attacker must be a PLAYER. An infected's hit carries no id, but say so rather than rely on it.
  if (type === "player.hit" && p.attackerType !== "player") return null;
  const offender = str(p[keys.id]); const victim = str(p.victimDayzId);
  if (!offender || !victim || offender === victim) return null;
  if (!atHub(readVec3(p[keys.pos])) && !atHub(readVec3(p.victimPos))) return null;
  return { offender, gamertag: str(p[keys.name]) ?? offender, victim };
}
