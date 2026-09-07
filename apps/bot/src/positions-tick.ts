import type { Database } from "@factions/db";
import { playerPositions } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const POSITIONS_CONSUMER = "positions-projector";

export type Fix = { dayzId: string; x: number; z: number; alt: number };

/** Any payload with a `pos` Vec3 (`player.position`, `base.*`). Flag events carry `pole`, not `pos`, and are not fixes. */
export function readFix(payload: unknown): Fix | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  const v = p.pos as Record<string, unknown> | undefined;
  if (!v || typeof v.x !== "number" || typeof v.y !== "number" || typeof v.z !== "number") return null;
  // ⚠️ Vec3 is {x, y: altitude, z}. alt = y.
  return { dayzId: p.dayzId, x: v.x, z: v.z, alt: v.y };
}

/**
 * The positions consumer (spec §4.9, §7): every pos-bearing event becomes a
 * `player_positions` row. Idempotent by `player_positions_event_uniq`
 * (`onConflictDoNothing`), so a cursor reset rewrites nothing.
 */
export async function positionsTick(db: Database, opts: { batchSize?: number } = {}): Promise<{ scanned: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, POSITIONS_CONSUMER);
  const out = { scanned: 0, written: 0 };
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    const rows: (typeof playerPositions.$inferInsert)[] = [];
    for (const ev of batch) {
      cursor = ev.id;
      const fix = readFix(ev.payload);
      if (!fix) continue;
      out.scanned++;
      rows.push({ serverId: ev.serverId, dayzId: fix.dayzId, x: fix.x.toFixed(2), z: fix.z.toFixed(2), alt: fix.alt.toFixed(2), occurredAt: ev.occurredAt, eventId: ev.id });
    }
    if (rows.length > 0) {
      const inserted = await db.insert(playerPositions).values(rows).onConflictDoNothing({ target: playerPositions.eventId }).returning({ id: playerPositions.id });
      out.written += inserted.length;
    }
    await writeCursor(db, POSITIONS_CONSUMER, cursor);
  }
  return out;
}
