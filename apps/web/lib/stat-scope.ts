import type { StatScope } from "@factions/roster";

/**
 * `?season=` is attacker-supplied. `"all"` is all-time, a positive integer is
 * that season, and anything else — absent, repeated, zero, negative,
 * fractional, or garbage — is `"default"`: the caller decides the default
 * scope itself (the open season when one exists, else all-time), because
 * that decision needs the roster's own `seasons` list, which this function
 * never sees. The raw value is never echoed back in either case.
 */
export function parseSeasonParam(raw: string | string[] | undefined): StatScope | "default" {
  if (typeof raw !== "string" || raw.length === 0) return "default";
  if (raw === "all") return { kind: "all" };
  if (!/^[1-9]\d*$/u.test(raw)) return "default";
  return { kind: "season", number: Number(raw) };
}
