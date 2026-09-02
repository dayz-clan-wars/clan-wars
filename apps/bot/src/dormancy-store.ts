import type { Database } from "@factions/db";
import { factions } from "@factions/db";
import { inArray, sql } from "drizzle-orm";
import type { FactionClock } from "./dormancy.js";

export type FactionClockRow = FactionClock & {
  id: number;
  name: string;
  tag: string;
  leaderDiscordId: string;
};

export interface DormancyStore {
  clocks(): Promise<FactionClockRow[]>;
}

/**
 * ⚠️ Read from `events`, NOT from `flag_changes`. The projector that fills
 * `flag_changes` does not run against the live database — it holds zero rows
 * there — so the read model would report every faction as never having raised
 * a flag. `ceremony-tick` reads the event log directly for the same reason.
 */
const LAST_RAISE = sql<Date | null>`(
  select max(e.occurred_at)
  from events e
  where e.type = 'flag.raised'
    and e.server_id = ${factions.serverId}
    and e.payload->>'poleKey' = ${factions.poleKey}
    and e.payload->>'texture' = ${factions.texture}
)`;

/** Statuses whose clock is worth reading. See dormancy.ts's decide(). */
const EXAMINED = ["active", "dormant"];

export class PgDormancyStore implements DormancyStore {
  constructor(private readonly db: Database) {}

  async clocks(): Promise<FactionClockRow[]> {
    const rows = await this.db.select({
      id: factions.id,
      name: factions.name,
      tag: factions.tag,
      leaderDiscordId: factions.leaderDiscordId,
      status: factions.status,
      dormantSince: factions.dormantSince,
      // ⚠️ COALESCE, and the order matters. A faction is activated BY its flag
      // going up, so a raise normally exists; activated_at covers one whose
      // activating raise predates the ingested window, and created_at covers a
      // row with neither. Without this a faction with no ingested raise reads
      // as infinitely stale and is dormant on the first tick.
      lastRaiseAt: sql<Date | null>`coalesce(${LAST_RAISE}, ${factions.activatedAt}, ${factions.createdAt})`,
    }).from(factions).where(inArray(factions.status, EXAMINED));

    return rows.map((r) => ({
      ...r,
      // postgres.js returns timestamptz as Date, but the value arrives through
      // a raw SQL expression rather than a typed column, so normalise rather
      // than trust the driver's mapping.
      lastRaiseAt: r.lastRaiseAt === null ? null : new Date(r.lastRaiseAt as unknown as string),
      dormantSince: r.dormantSince === null ? null : new Date(r.dormantSince as unknown as string),
    }));
  }
}
