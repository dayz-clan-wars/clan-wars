import type { Database } from "@factions/db";
import { kills } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { eq } from "drizzle-orm";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const KILLS_CONSUMER = "kills-projector";

export type KillsTickResult = {
  /** player.killed/player.died events this call looked at. */
  scanned: number;
  /** kills rows inserted. */
  written: number;
};

type KilledPayload = { victimDayzId: string; killerDayzId: string; weapon: string | null; distanceM: number | null };
type DiedPayload = { victimDayzId: string; cause: string };

function readKilledPayload(payload: unknown): KilledPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.victimDayzId !== "string" || p.victimDayzId === "") return null;
  if (typeof p.killerDayzId !== "string" || p.killerDayzId === "") return null;
  return {
    victimDayzId: p.victimDayzId,
    killerDayzId: p.killerDayzId,
    weapon: typeof p.weapon === "string" ? p.weapon : null,
    distanceM: typeof p.distanceM === "number" ? p.distanceM : null,
  };
}

function readDiedPayload(payload: unknown): DiedPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.victimDayzId !== "string" || p.victimDayzId === "") return null;
  if (typeof p.cause !== "string" || p.cause === "") return null;
  return { victimDayzId: p.victimDayzId, cause: p.cause };
}

/**
 * The kills consumer (spec §4.9, §11 ⚠️): `player.killed`/`player.died`
 * events become `kills` rows — stats only, never points. This must never
 * read or write `season_standings`, `raids`, `alpha_weeks` or
 * `season_results`.
 *
 * Faction membership is resolved at the instant of the kill via
 * `membershipAt`, not from the player's current clan — a member who has
 * since left (or joined) shows the clan they belonged to when the kill
 * happened. `friendlyFire` is true only when both sides resolve to the
 * same non-null faction.
 *
 * Idempotent: kills are deduped by `kills_event_uniq` on `event_id`
 * (`onConflictDoNothing`), so a replayed event cannot insert a second row.
 */
export async function killsTick(db: Database, opts: { batchSize?: number } = {}): Promise<KillsTickResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, KILLS_CONSUMER);
  const out: KillsTickResult = { scanned: 0, written: 0 };

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type === "player.killed") {
        const payload = readKilledPayload(ev.payload);
        if (!payload) continue;
        out.scanned++;

        // Two membershipAt calls outside a transaction: safe, because a
        // history span covering an already-elapsed instant (ev.occurredAt)
        // is immutable — nothing can change what it resolves to between
        // these two reads.
        const [killerFactionId, victimFactionId] = await Promise.all([
          membershipAt(db, ev.serverId, payload.killerDayzId, ev.occurredAt),
          membershipAt(db, ev.serverId, payload.victimDayzId, ev.occurredAt),
        ]);
        // A self-kill (e.g. a player's own grenade) is never friendly fire,
        // even when the player is in a clan and both ids resolve to it.
        const friendlyFire = payload.killerDayzId !== payload.victimDayzId
          && killerFactionId !== null && killerFactionId === victimFactionId;

        const inserted = await db
          .insert(kills)
          .values({
            serverId: ev.serverId,
            eventId: ev.id,
            occurredAt: ev.occurredAt,
            victimDayzId: payload.victimDayzId,
            killerDayzId: payload.killerDayzId,
            weapon: payload.weapon,
            distanceM: payload.distanceM === null ? null : String(payload.distanceM),
            cause: "pvp",
            victimFactionId,
            killerFactionId,
            friendlyFire,
          })
          .onConflictDoNothing({ target: kills.eventId })
          .returning({ id: kills.id });
        out.written += inserted.length;
      } else if (ev.type === "player.died") {
        const payload = readDiedPayload(ev.payload);
        if (!payload) continue;
        out.scanned++;

        const victimFactionId = await membershipAt(db, ev.serverId, payload.victimDayzId, ev.occurredAt);

        const inserted = await db
          .insert(kills)
          .values({
            serverId: ev.serverId,
            eventId: ev.id,
            occurredAt: ev.occurredAt,
            victimDayzId: payload.victimDayzId,
            killerDayzId: null,
            weapon: null,
            distanceM: null,
            cause: payload.cause,
            victimFactionId,
            killerFactionId: null,
            friendlyFire: false,
          })
          .onConflictDoNothing({ target: kills.eventId })
          .returning({ id: kills.id });
        out.written += inserted.length;
      }
    }
    await writeCursor(db, KILLS_CONSUMER, cursor);
  }
  return out;
}

/**
 * Rebuild one server's `kills` from scratch: delete its rows, reset the
 * cursor to 0, and replay.
 *
 * ⚠️ The cursor is global (one row per consumer name), but this rebuild is
 * per server. Resetting it to 0 and replaying re-derives every server's
 * kills, not just this one's — harmless (every predicate is scoped by
 * `server_id` and every write is idempotent) but wasteful, and it means a
 * concurrent rebuild of a different server would race this one's cursor
 * writes. `rebuild-kills.ts` refuses to run when more than one active
 * server exists, precisely to keep that race from ever coming up.
 */
export async function rebuildKills(db: Database, serverId: number): Promise<number> {
  await db.delete(kills).where(eq(kills.serverId, serverId));
  await writeCursor(db, KILLS_CONSUMER, 0);
  await killsTick(db);
  const rows = await db.select({ id: kills.id }).from(kills).where(eq(kills.serverId, serverId));
  return rows.length;
}
