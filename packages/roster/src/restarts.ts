import type { Database } from "@factions/db";
import { serverRestarts } from "@factions/db";
import { RESTART_PERIOD_MS } from "@factions/domain";
import { gte, sql } from "drizzle-orm";

/**
 * How stale the newest recorded slot may be before the site stops claiming there
 * is a restart coming: twelve slots, i.e. a day.
 *
 * ⚠️ Expressed in periods, not as a bare `86_400_000`, so changing the restart
 * cadence cannot silently leave this at half a day or at three.
 */
export const RESTART_EVIDENCE_MS = 12 * RESTART_PERIOD_MS;

/**
 * Whether scheduled restarts are actually running, and therefore whether the
 * site may show a countdown to the next one.
 *
 * ⚠️ This read is the whole reason the timer bar is honest. `nextRestartAt` is
 * pure arithmetic on the epoch, so it ALWAYS returns a confident-looking clock —
 * including on an install where `RESTART_SCHEDULE` is unset and nothing has ever
 * restarted. The web app cannot see the bot's env, so the evidence has to come
 * from what the tick wrote: any slot recorded inside the window, whatever its
 * outcome. No row means no column, never a guessed countdown.
 */
export async function restartsScheduledDb(db: Database, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - RESTART_EVIDENCE_MS);
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(serverRestarts)
    .where(gte(serverRestarts.scheduledFor, since))
    .limit(1);
  return row !== undefined;
}
