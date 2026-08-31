import type { Vec3 } from "@factions/domain";

const V3 = "<\\s*(-?[\\d.]+),\\s*(-?[\\d.]+),\\s*(-?[\\d.]+)\\s*>";

/**
 * Player position: `pos=<x, z, altitude>` — the two horizontals come FIRST.
 *
 * CRITICAL: anchored INSIDE the identity parenthetical `(id=<40 hex> ... pos=<...>)`.
 * The gamertag is attacker-controlled and sits earlier on the line, so an
 * unanchored pattern took a `pos=<...>` worn in the name instead of the real
 * one. `[^)]*?` cannot cross the closing paren, which keeps the match within
 * the identity block. The projector binds a fold to its nearest pole by player
 * position, so a spoofed pos moves a fold onto someone else's pole.
 */
const PLAYER_POS_RE = new RegExp(`\\(id=[0-9A-F]{40}[^)]*?pos=${V3}`, "u");

/**
 * Flagpole position: `on TerritoryFlag at <x, altitude, z>` — altitude is in the MIDDLE.
 *
 * CRITICAL: anchored AFTER the identity parenthetical, for the same reason.
 * Unanchored, it took the LEFTMOST match, so a crafted gamertag substituted a
 * fake pole identity on an otherwise genuine line — crediting the wrong faction.
 * The tail is matched with `.*?` rather than `[^)]*?`: a stray `)` after the
 * identity block must not silently drop a real flag change, which is the only
 * raid signal the ADM log provides.
 */
const POLE_AT_RE = new RegExp(
  `\\(id=[0-9A-F]{40}[^)]*\\).*?on TerritoryFlag at ${V3}`,
  "u",
);

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
