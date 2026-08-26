import type { Vec3 } from "@factions/domain";

/** Player position: `pos=<x, z, altitude>` — the two horizontals come FIRST. */
const PLAYER_POS_RE = /pos=<\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>/u;

/** Flagpole position: `on TerritoryFlag at <x, altitude, z>` — altitude is in the MIDDLE. */
const POLE_AT_RE = /on TerritoryFlag at <\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>/u;

/**
 * The accepted horizontal window for a world coordinate, in metres.
 *
 * MAP_MAX is 16384 — the terrain size of the largest DayZ map this system
 * supports (Sakhal and Chernarus are both 16384m; Livonia is 12800m). The
 * previous 16360 left the outer 24m of Sakhal as a silent-drop band, since a
 * rejected parsePoleAt makes parseFlagChange discard the whole event.
 *
 * ⚠️ inMapBounds is the SOLE guard that rejects DayZ's off-map sentinel. DayZ
 * writes that sentinel in full decimal expansion —
 * `-340282346638528859811704183484516925440.0`, not `e`-notation — and there
 * is no pattern match for it anywhere: it is rejected purely because it falls
 * far below MAP_MIN. Widening the lower bound (or removing this check) would
 * silently admit sentinel coordinates as real positions. Do not touch MAP_MIN
 * casually.
 */
const MAP_MIN = -1000.0;
const MAP_MAX = 16384.0;

export function inMapBounds(x: number, z: number): boolean {
  return x >= MAP_MIN && x <= MAP_MAX && z >= MAP_MIN && z <= MAP_MAX;
}

export function parsePlayerPos(raw: string): Vec3 | null {
  const m = PLAYER_POS_RE.exec(raw);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const z = parseFloat(m[2]!);
  const y = parseFloat(m[3]!);
  if (!inMapBounds(x, z)) return null;
  return { x, y, z };
}

export function parsePoleAt(raw: string): Vec3 | null {
  const m = POLE_AT_RE.exec(raw);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const y = parseFloat(m[2]!);
  const z = parseFloat(m[3]!);
  if (!inMapBounds(x, z)) return null;
  return { x, y, z };
}
