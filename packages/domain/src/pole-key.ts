import type { Vec3 } from "./vec3.js";

/** Decimal places retained in a pole identity key. 2 == 1cm. */
export const POLE_KEY_PRECISION = 2;

/**
 * Stable identity for a flagpole.
 *
 * Observed `at <...>` coordinates were byte-identical across five weeks of production
 * events, but float formatting is not a contract. Rounding to 1cm makes the key robust
 * without merging genuinely distinct poles — DayZ will not let two flagpoles stand 1cm apart.
 *
 * Normalizes negative zero to positive zero to ensure stability across the zero boundary:
 * coordinates within 1cm on opposite sides of zero produce the same key.
 */
export function poleKey(at: Vec3): string {
  const f = (n: number): string => {
    const r = Number(n.toFixed(POLE_KEY_PRECISION));
    return (r === 0 ? 0 : r).toFixed(POLE_KEY_PRECISION);
  };
  return `${f(at.x)}:${f(at.y)}:${f(at.z)}`;
}

/**
 * The inverse of `poleKey`. Returns null rather than throwing on a malformed
 * key — parsing sits on a read path (e.g. reconstituting a ceremony's
 * coordinates), and a bad key is the caller's data problem to decide how to
 * handle, not a control-flow exception forced on every caller.
 */
export function parsePoleKey(key: string): Vec3 | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [x, y, z] = parts.map(Number);
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return { x: x!, y: y!, z: z! };
}
