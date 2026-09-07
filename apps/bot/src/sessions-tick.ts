import type { Database } from "@factions/db";
import { playerSessions, admFiles, events } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { and, asc, desc, eq, isNull, lt, lte } from "drizzle-orm";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const SESSIONS_CONSUMER = "sessions-projector";

export type SessionsTickResult = {
  /** connect/disconnect events this call looked at. */
  scanned: number;
  /** sessions opened (one per `player.connected`). */
  opened: number;
  /** sessions closed with close_reason 'disconnect'. */
  closed: number;
  /** sessions closed with close_reason 'restart' (file-boundary or missed-disconnect). */
  restarted: number;
};

type ConnectedPayload = { dayzId: string; gamertag: string };

function readConnectPayload(payload: unknown): ConnectedPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  return { dayzId: p.dayzId, gamertag: typeof p.gamertag === "string" ? p.gamertag : "" };
}

/**
 * The sessions consumer (spec §4.9): `player.connected`/`player.disconnected`
 * events become `player_sessions` rows. A session closes three ways:
 *   - `'disconnect'`: the matching `player.disconnected` event.
 *   - `'restart'`: an ADM file boundary is crossed while the session is still
 *     open (the server restarted without a clean disconnect line).
 *   - `'restart'`: a second `player.connected` for the same player arrives
 *     while one is already open — a missed disconnect. `player_sessions_open_uniq`
 *     makes closing the old row before opening the new one mandatory, not optional.
 *
 * Idempotent: connects are deduped by `player_sessions_connect_uniq` on
 * `connect_event_id` (`onConflictDoNothing`), and every close predicate reads
 * `disconnected_at IS NULL`, so a replayed event cannot re-close an
 * already-closed row or insert a duplicate row.
 */
export async function sessionsTick(db: Database, opts: { batchSize?: number } = {}): Promise<SessionsTickResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, SESSIONS_CONSUMER);
  const out: SessionsTickResult = { scanned: 0, opened: 0, closed: 0, restarted: 0 };

  // ⚠️ Seed the "last file seen per server" map from the newest open-or-closed
  // session's connect event, not from the cursor. The cursor is a global,
  // single-number bookmark; the boundary-crossing check below is per server.
  // Without this seed, a restart boundary that straddles two ticks (file 1's
  // last connect landed in a previous tick; file 2's first event lands in
  // this one) would look like the very first event this consumer has ever
  // seen for that server, and the file-boundary close would never fire.
  const lastFileByServer = new Map<number, number>();
  // ⚠️ `DISTINCT ON (server_id)` — one row per server, never the whole table.
  // `player_sessions` grows without bound (a 50-player server is ~200 rows a
  // day) and this runs on every tick; the loop below only ever wanted the
  // newest connect per server. `ORDER BY server_id, id DESC` is what makes
  // the kept row that newest one, so the two clauses must stay in step.
  const seeds = await db
    .selectDistinctOn([playerSessions.serverId], { serverId: playerSessions.serverId, admFileId: events.admFileId })
    .from(playerSessions)
    .innerJoin(events, eq(events.id, playerSessions.connectEventId))
    .orderBy(asc(playerSessions.serverId), desc(playerSessions.id));
  for (const row of seeds) {
    lastFileByServer.set(row.serverId, row.admFileId);
  }

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "player.connected" && ev.type !== "player.disconnected") {
        // Any event still marks the file we're in, so a boundary crossed by
        // a non-connect/disconnect event (e.g. the first position of a new
        // file) still triggers the restart-close below.
        await closeOnFileBoundary(db, ev.serverId, ev.admFileId, lastFileByServer, out);
        continue;
      }
      await closeOnFileBoundary(db, ev.serverId, ev.admFileId, lastFileByServer, out);

      const payload = readConnectPayload(ev.payload);
      if (!payload) continue;
      out.scanned++;

      if (ev.type === "player.connected") {
        // A missed disconnect: close whatever is still open for this player
        // as 'restart' at the new connect's instant, then open the new one.
        // `player_sessions_open_uniq` (server_id, dayz_id) WHERE disconnected_at
        // IS NULL makes this mandatory — inserting the new row without first
        // closing the old one would violate that index.
        const restartClosed = await db
          .update(playerSessions)
          .set({ disconnectedAt: ev.occurredAt, closeReason: "restart" })
          .where(and(
            eq(playerSessions.serverId, ev.serverId),
            eq(playerSessions.dayzId, payload.dayzId),
            isNull(playerSessions.disconnectedAt),
          ))
          .returning({ id: playerSessions.id });
        out.restarted += restartClosed.length;

        const inserted = await db
          .insert(playerSessions)
          .values({ serverId: ev.serverId, dayzId: payload.dayzId, connectedAt: ev.occurredAt, connectEventId: ev.id })
          .onConflictDoNothing({ target: playerSessions.connectEventId })
          .returning({ id: playerSessions.id });
        out.opened += inserted.length;
      } else {
        const disconnectClosed = await db
          .update(playerSessions)
          .set({ disconnectedAt: ev.occurredAt, closeReason: "disconnect" })
          .where(and(
            eq(playerSessions.serverId, ev.serverId),
            eq(playerSessions.dayzId, payload.dayzId),
            isNull(playerSessions.disconnectedAt),
            lte(playerSessions.connectedAt, ev.occurredAt),
          ))
          .returning({ id: playerSessions.id });
        out.closed += disconnectClosed.length;
      }
    }
    await writeCursor(db, SESSIONS_CONSUMER, cursor);
  }
  return out;
}

/**
 * When the event's file differs from the last file seen for this server,
 * every still-open session on that server whose `connected_at` predates the
 * new file's `boot_at` is a session the previous file never saw close — the
 * server restarted. Close it as `'restart'` at `boot_at`.
 *
 * ⚠️ `connected_at < boot_at`, strictly less-than: a session opened by the
 * very connect that boots the new file (possible if a connect and the file
 * transition share an instant) is not itself stale.
 */
async function closeOnFileBoundary(
  db: Database,
  serverId: number,
  admFileId: number,
  lastFileByServer: Map<number, number>,
  out: SessionsTickResult,
): Promise<void> {
  const lastFile = lastFileByServer.get(serverId);
  if (lastFile === admFileId) return;
  lastFileByServer.set(serverId, admFileId);
  if (lastFile === undefined) return; // first file this consumer has ever seen for this server: nothing to close

  const [file] = await db.select({ bootAt: admFiles.bootAt }).from(admFiles).where(eq(admFiles.id, admFileId));
  if (!file) return;

  const closed = await db
    .update(playerSessions)
    .set({ disconnectedAt: file.bootAt, closeReason: "restart" })
    .where(and(
      eq(playerSessions.serverId, serverId),
      isNull(playerSessions.disconnectedAt),
      lt(playerSessions.connectedAt, file.bootAt),
    ))
    .returning({ id: playerSessions.id });
  out.restarted += closed.length;
}

/**
 * Rebuild one server's `player_sessions` from scratch: delete its rows,
 * reset the cursor to 0, and replay.
 *
 * ⚠️ The cursor is global (one row per consumer name), but this rebuild is
 * per server. Resetting it to 0 and replaying re-derives every server's
 * sessions, not just this one's — harmless (every predicate is scoped by
 * `server_id` and every write is idempotent) but wasteful, and it means a
 * concurrent rebuild of a different server would race this one's cursor
 * writes. `rebuild-sessions.ts` refuses to run when more than one active
 * server exists, precisely to keep that race from ever coming up.
 */
export async function rebuildSessions(db: Database, serverId: number): Promise<number> {
  await db.delete(playerSessions).where(eq(playerSessions.serverId, serverId));
  await writeCursor(db, SESSIONS_CONSUMER, 0);
  await sessionsTick(db);
  const rows = await db.select({ id: playerSessions.id }).from(playerSessions).where(eq(playerSessions.serverId, serverId));
  return rows.length;
}
