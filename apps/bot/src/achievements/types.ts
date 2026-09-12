import type { Database } from "@factions/db";

/** Who an achievement belongs to. A clan's id is the faction id as text, so both kinds share one column. */
export type Owner = { kind: "player"; id: string } | { kind: "clan"; id: string };
export type Evidence = Record<string, string | number | boolean | null>;

/**
 * What every rule reports. `count` is in the definition's unit (kills, hours,
 * days, metres). When `count >= target` the rule MUST also set `earnedAt` —
 * the timestamp of the row that crossed the line, never "now" — and may set
 * the evidence row id and a small evidence object (⚠️ never a coordinate).
 */
export type RuleResult = {
  count: number;
  target: number;
  earnedAt?: Date;
  evidenceId?: number | null;
  evidence?: Evidence;
  /** The server the evidence came from, for the notice rows. Optional; the tick falls back to the owner's clan's server. */
  serverId?: number;
};
export type Rule = (db: Database, owner: Owner, ctx: { now: Date }) => Promise<RuleResult>;

export type Hit = { at: Date; id?: number | null; evidence?: Evidence; serverId?: number };

/** A one-shot rule: earned by the first matching row. */
export function oneShot(hit: Hit | undefined): RuleResult {
  return hit
    ? { count: 1, target: 1, earnedAt: hit.at, evidenceId: hit.id ?? null, evidence: hit.evidence, serverId: hit.serverId }
    : { count: 0, target: 1 };
}

/** A counted rule over rows in ascending time: earned when the target-th row lands. */
export function nth(rows: readonly Hit[], target: number, evidence?: (rows: readonly Hit[]) => Evidence): RuleResult {
  const count = rows.length;
  if (count < target) return { count, target };
  const crossing = rows[target - 1]!;
  return { count, target, earnedAt: crossing.at, evidenceId: crossing.id ?? null, evidence: evidence?.(rows) ?? { count }, serverId: crossing.serverId };
}

export function clanId(owner: Owner): number {
  if (owner.kind !== "clan") throw new Error(`rule needs a clan owner, got ${owner.kind}`);
  return Number(owner.id);
}
