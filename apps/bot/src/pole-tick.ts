import type { Database } from "@factions/db";
import { poles, servers } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { NEW_POLE_GRACE_MS } from "@factions/domain";
import { eq, sql } from "drizzle-orm";

/**
 * ⚠️ Distinct from apps/projector's "pole-projector" cursor. That process
 * does not run in production and writes flag_changes too; this one writes
 * poles only. Sharing a cursor name would make each skip the other's events.
 */
export const POLE_CONSUMER = "pole-projector-bot";

export type PoleProjectionResult = { scanned: number; upserted: number };

type FlagPayload = { texture: string; poleKey: string; pole: { x: number; y: number; z: number } };

function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const pole = p.pole as Record<string, unknown> | undefined;
  if (typeof p.texture !== "string" || typeof p.poleKey !== "string" || p.poleKey === "") return null;
  if (!pole || typeof pole.x !== "number" || typeof pole.y !== "number" || typeof pole.z !== "number") return null;
  return { texture: p.texture, poleKey: p.poleKey, pole: { x: pole.x, y: pole.y, z: pole.z } };
}

/**
 * Fold flag events into `poles`, so grace_until exists for every pole the
 * log has ever seen. The site's public-bases layer and the solo declare
 * page both read this table.
 */
export async function runPoleProjection(db: Database, opts: { batchSize?: number } = {}): Promise<PoleProjectionResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, POLE_CONSUMER);
  const out: PoleProjectionResult = { scanned: 0, upserted: 0 };
  const maps = new Map<number, string>();

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised" && ev.type !== "flag.lowered") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;

      let map = maps.get(ev.serverId);
      if (!map) {
        const [s] = await db.select({ map: servers.map }).from(servers).where(eq(servers.id, ev.serverId));
        if (!s) continue;
        map = s.map;
        maps.set(ev.serverId, map);
      }

      const raised = ev.type === "flag.raised";
      // ⚠️ `.returning()` and the row count, not an unconditional `++`. The
      // `setWhere` below suppresses the update for an out-of-order event, and
      // ON CONFLICT ... WHERE that matches nothing writes nothing — so
      // counting every statement reported poles projected that were not, and
      // the runbook's `pole projection: N poles` line would confirm a
      // projection that had in fact skipped every row.
      const written = await db.insert(poles).values({
        serverId: ev.serverId, map, poleKey: p.poleKey,
        x: p.pole.x.toFixed(2), y: p.pole.y.toFixed(2), z: p.pole.z.toFixed(2),
        currentTexture: p.texture, flagRaised: raised,
        firstSeenAt: ev.occurredAt, lastSeenAt: ev.occurredAt,
        // ⚠️ Only on insert. The ON CONFLICT below deliberately omits
        // grace_until: a release resets it (declaration-store) and the
        // runbook stamps it, and neither must be undone by the next raise.
        graceUntil: new Date(ev.occurredAt.getTime() + NEW_POLE_GRACE_MS),
      }).onConflictDoUpdate({
        target: [poles.serverId, poles.map, poles.poleKey],
        set: { currentTexture: p.texture, flagRaised: raised, lastSeenAt: ev.occurredAt, foldedAt: null },
        // Events can arrive out of order across ADM files; never let an older line overwrite a newer state.
        // Cast explicitly: this raw comparison loses the column-type context that would
        // otherwise tell postgres.js how to encode a bare Date parameter.
        setWhere: sql`${poles.lastSeenAt} <= ${ev.occurredAt.toISOString()}::timestamptz`,
      }).returning({ id: poles.id });
      out.upserted += written.length;
    }
    await writeCursor(db, POLE_CONSUMER, cursor);
  }
  return out;
}
