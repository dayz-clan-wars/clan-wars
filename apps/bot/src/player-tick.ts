import type { Database } from "@factions/db";
import { players } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { sql } from "drizzle-orm";

/**
 * ⚠️ Distinct from every other consumer ("pole-projector", "identity-verifier",
 * "ceremony-detector"). Two consumers sharing a cursor name each skip the
 * other's events, and the symptom here would be "autocomplete is randomly
 * stale" rather than an error.
 */
export const PLAYER_CONSUMER = "player-projector";

export type PlayerProjectionOpts = { batchSize?: number };

export type PlayerProjectionResult = {
  /** player.position / emote.performed events examined. */
  scanned: number;
  /** rows actually written to players. */
  upserted: number;
};

type PlayerPayload = { dayzId: string; gamertag: string };

function readPlayerPayload(payload: unknown): PlayerPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  if (typeof p.gamertag !== "string" || p.gamertag === "") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag };
}

/**
 * Projects observed players from the event log into `players`, so `/link`'s
 * autocomplete can offer gamertags without touching the event log directly.
 */
export async function runPlayerProjection(
  db: Database,
  opts: PlayerProjectionOpts = {},
): Promise<PlayerProjectionResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, PLAYER_CONSUMER);
  let scanned = 0;
  let upserted = 0;

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;

    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "player.position" && ev.type !== "emote.performed") continue;
      const payload = readPlayerPayload(ev.payload);
      // A malformed payload is a parser bug, not a reason to stall the cursor.
      if (!payload) continue;
      scanned++;

      await db.insert(players)
        .values({
          dayzId: payload.dayzId,
          gamertag: payload.gamertag,
          firstSeenAt: ev.occurredAt,
          lastSeenAt: ev.occurredAt,
        })
        .onConflictDoUpdate({
          target: players.dayzId,
          // ⚠️ Guarded in SQL, not by a prior read. Events are replayed in id
          // order, but a backfill can carry OLDER occurredAt values than rows
          // already written, and `first_seen` must survive that while
          // `last_seen` and the display name must not regress.
          set: {
            lastSeenAt: sql`greatest(${players.lastSeenAt}, excluded.last_seen_at)`,
            firstSeenAt: sql`least(${players.firstSeenAt}, excluded.first_seen_at)`,
            gamertag: sql`case when excluded.last_seen_at >= ${players.lastSeenAt}
                          then excluded.gamertag else ${players.gamertag} end`,
          },
        });
      upserted++;
    }
    await writeCursor(db, PLAYER_CONSUMER, cursor);
  }

  return { scanned, upserted };
}
