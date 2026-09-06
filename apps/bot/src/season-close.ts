import type { Database } from "@factions/db";
import { seasonResults, seasons } from "@factions/db";
import { appendWarLogTx } from "@factions/roster/internal";
import { and, eq, isNull } from "drizzle-orm";
import { seasonTable } from "./standings.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type SeasonCloseResult = {
  seasonId: number;
  number: number;
  champion: { factionId: number; name: string; points: number } | null;
};

/**
 * Season close (spec §8, §9.2): snapshot `season_results` from
 * `season_standings` in §8.1 order (rank 1..n over EVERY standings row,
 * ranked or not — a dormant or disbanded clan still gets a final rank), set
 * `ended_at` and the champion (rank 1 IF its points are > 0, otherwise no
 * champion — a season nobody scored crowns nobody even though rank 1 still
 * exists), and queue the `season_closed` #war-log line.
 *
 * Idempotent: locks the server's OPEN season (`ended_at IS NULL`) FOR
 * UPDATE, so a season that is already closed matches nothing and this
 * returns null with no side effects — the second of two concurrent or
 * replayed calls (the wipe script re-run, `wipeTx`'s own no-op guard racing
 * this) neither duplicates the results set nor queues a second line.
 */
export async function closeSeasonTx(tx: Tx, serverId: number, at: Date): Promise<SeasonCloseResult | null> {
  const [season] = await tx.select({ id: seasons.id, number: seasons.number })
    .from(seasons)
    .where(and(eq(seasons.serverId, serverId), isNull(seasons.endedAt)))
    .for("update");
  if (!season) return null;

  const table = await seasonTable(tx, season.id);
  if (table.length > 0) {
    await tx.insert(seasonResults).values(table.map((row, i) => ({
      seasonId: season.id,
      factionId: row.factionId,
      rank: i + 1,
      points: row.points,
      raids: row.raids,
      timesRaided: row.timesRaided,
      defenses: row.defenses,
      statusAtClose: row.status,
    })));
  }

  const top = table[0];
  const champion = top && top.points > 0 ? { factionId: top.factionId, name: top.name, points: top.points } : null;

  await tx.update(seasons)
    .set({ endedAt: at, championFactionId: champion?.factionId ?? null })
    .where(eq(seasons.id, season.id));

  await appendWarLogTx(tx, {
    serverId, kind: "season_closed", occurredAt: at,
    payload: { number: season.number, clan: champion?.name ?? null, points: champion?.points ?? null },
  });

  return { seasonId: season.id, number: season.number, champion };
}
