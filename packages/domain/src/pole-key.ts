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
