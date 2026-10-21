import { events } from "@factions/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hit, Rule, RuleCtx } from "./types.js";

/** One `player.hit` event, flattened to what the hit-derived rules read. No coordinates, ever. */
export type HitRow = {
  id: number; at: Date; serverId: number;
  attackerLabel: string | null; attackerType: string | null; weapon: string | null; victimDayzId: string;
  /** A non-player hit's mechanism, the word after ` with ` ("BarbedWireHit"); null for a player hit or an animal. */
  cause: string | null;
};
export type HitSide = "victim" | "attacker";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Every hit the owner took (`victim`) or dealt (`attacker`), in time order, read once per owner
 * per side per pass. Each side is an equality on one payload key inside `player.hit`, which is
 * exactly what `events_hit_victim_idx` / `events_hit_attacker_idx` cover.
 *
 * ⚠️ The memo key carries the side AND the id: a constant key would hand the attacker rules the
 * victim rows (or a second owner the first owner's), silently.
 */
export const ownHits = (db: Parameters<Rule>[0], ctx: RuleCtx, dayzId: string, side: HitSide): Promise<HitRow[]> =>
  ctx.memo(`hits:${side}:${dayzId}`, async () => {
    // ⚠️ The key is spelled literally, not bound as a parameter: `payload->>$1` is not the
    // expression either partial index is built on, so the planner would scan every hit.
    const who = side === "victim" ? sql`${events.payload}->>'victimDayzId'` : sql`${events.payload}->>'attackerDayzId'`;
    const rows = await db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId, payload: events.payload }).from(events)
      .where(and(eq(events.type, "player.hit"), sql`${who} = ${dayzId}`))
      .orderBy(asc(events.occurredAt), asc(events.id));
    return rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return { id: r.id, at: r.at, serverId: r.serverId, attackerLabel: str(p.attackerLabel), attackerType: str(p.attackerType), weapon: str(p.weapon), victimDayzId: str(p.victimDayzId) ?? "", cause: str(p.cause) };
    });
  });

/**
 * One row per incident: the first hit of each distinct (victim, second). A motorbike logs a burst
 * of 20–40 identical lines inside one second (spec §2.6), and that is one time you were hit, not 40.
 */
export function incidents(rows: readonly HitRow[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const r of rows) {
    const k = `${r.victimDayzId}:${Math.floor(r.at.getTime() / 1000)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ at: r.at, id: r.id, serverId: r.serverId });
  }
  return out;
}
