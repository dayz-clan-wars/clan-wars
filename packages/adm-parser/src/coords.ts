import type { Vec3 } from "@factions/domain";

/** Player position: `pos=<x, z, altitude>` — the two horizontals come FIRST. */
const PLAYER_POS_RE = /pos=<\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>/u;

/** Flagpole position: `on TerritoryFlag at <x, altitude, z>` — altitude is in the MIDDLE. */
const POLE_AT_RE = /on TerritoryFlag at <\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>/u;

/** Off-map sentinel; DayZ writes -3.4e38 for an unresolved position. */
const SENTINEL_RE = /<\s*-?\d*\.?\d+e/iu;

const MAP_MIN = -1000.0;
const MAP_MAX = 16360.0;

export function inMapBounds(x: number, z: number): boolean {
  return x >= MAP_MIN && x <= MAP_MAX && z >= MAP_MIN && z <= MAP_MAX;
}

export function parsePlayerPos(raw: string): Vec3 | null {
  if (SENTINEL_RE.test(raw)) return null;
  const m = PLAYER_POS_RE.exec(raw);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const z = parseFloat(m[2]!);
  const y = parseFloat(m[3]!);
  if (!inMapBounds(x, z)) return null;
  return { x, y, z };
}

export function parsePoleAt(raw: string): Vec3 | null {
  if (SENTINEL_RE.test(raw)) return null;
  const m = POLE_AT_RE.exec(raw);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const y = parseFloat(m[2]!);
  const z = parseFloat(m[3]!);
  if (!inMapBounds(x, z)) return null;
  return { x, y, z };
}
