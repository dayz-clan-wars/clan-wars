import { type Database } from "@factions/db";
import { RESTART_PERIOD_MS } from "@factions/domain";
import { sql } from "drizzle-orm";

/**
 * Players connected at `instant`, from the session spans (spec §2's
 * reconstruction, as a single statement per instant set).
 */
export async function popsAt(db: Database, serverId: number, instants: Date[]): Promise<number[]> {
  if (instants.length === 0) return [];
  const rows = await db.execute<{ t: Date; c: number }>(sql`
    select t, (
      select count(*)::int from player_sessions s
      where s.server_id = ${serverId}
        and s.connected_at <= t
        and (s.disconnected_at is null or s.disconnected_at > t)
    ) as c
    from unnest(array[${sql.join(instants.map((d) => sql`${d.toISOString()}::timestamptz`), sql`, `)}]) as t
  `);
  return [...rows].map((r) => Number(r.c));
}

/**
 * The trailing history on the slot grid.
 * ⚠️ STRICTLY before `decisionInstant`. With a max rather than a percentile, a
 * window containing the current sample makes `pop >= max` true of every pop that
 * is its own maximum, and the rule fires on any new record, including a record of 1.
 * Shared by the airdrop and KotH triggers so both read one definition.
 */
export function historyInstants(decisionInstant: Date, windowMs: number): Date[] {
  const out: Date[] = [];
  for (let t = decisionInstant.getTime() - windowMs; t < decisionInstant.getTime(); t += RESTART_PERIOD_MS) out.push(new Date(t));
  return out;
}

export async function onlineNow(db: Database, serverId: number, now: Date): Promise<number> {
  return (await popsAt(db, serverId, [now]))[0] ?? 0;
}
