import type { Database } from "@factions/db";
import { declarations, factionMembers, factions } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { distance2d, JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS, HOLDING_STATUSES } from "@factions/domain";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import { and, eq, inArray, lte } from "drizzle-orm";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const PRESENCE_CONSUMER = "presence-promoter";

export type PresenceResult = {
  scanned: number;
  promoted: { factionId: number; dayzId: string; eventId: number; releasedSoloBase: boolean }[];
};

type Pending = { memberId: number; factionId: number; serverId: number; dayzId: string; poleX: number; poleZ: number };

/** The point an event places its player at: `pos` when it has one; a flag event's pole otherwise. */
function pointOf(type: string, payload: unknown): { dayzId: string; x: number; z: number } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string") return null;
  const v = (p.pos ?? ((type === "flag.raised" || type === "flag.lowered") ? p.pole : undefined)) as Record<string, unknown> | undefined;
  if (!v || typeof v.x !== "number" || typeof v.z !== "number") return null;
  // ⚠️ Vec3 is {x, y: altitude, z} — the parser already put the ADM `pos=<x, z, alt>` fields in their places. Compare x with x, z with z.
  return { dayzId: p.dayzId, x: v.x, z: v.z };
}

/**
 * Promote pending members the log has seen at their clan's base (spec §5.3,
 * §7 "presence"). Idempotent by `seen_at_base_event_id`: the UPDATE is guarded
 * on `status = 'pending'`, so a replayed batch promotes nobody twice.
 *
 * Per event: a pending member with this UID → their clan's declaration →
 * distance in 2-D → within JOIN_PRESENCE_RADIUS_M → one transaction:
 * `lockDeclarations` → `releaseTx` (the joiner's solo base, if any — §5.3 ⚠️
 * "not at accept") → `faction_members` update. Lock order §4.12:
 * declarations → poles → faction_members. Notices (`became_full`): increment 3.
 * Discord role/channel grants: increment 3 (no ids exist yet).
 */
export async function presenceTick(db: Database, opts: { batchSize?: number } = {}): Promise<PresenceResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, PRESENCE_CONSUMER);
  const out: PresenceResult = { scanned: 0, promoted: [] };
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    // One read per batch, not per event: who is pending right now, and where their base is.
    const pending = new Map<string, Pending>();
    for (const row of await db.select({
      memberId: factionMembers.id, factionId: factionMembers.factionId, serverId: factionMembers.serverId, dayzId: factionMembers.dayzId,
      poleX: declarations.x, poleZ: declarations.z,
    }).from(factionMembers)
      .innerJoin(factions, eq(factions.id, factionMembers.factionId))
      .innerJoin(declarations, eq(declarations.ownerFactionId, factionMembers.factionId))
      .where(and(eq(factionMembers.status, "pending"), inArray(factions.status, [...HOLDING_STATUSES])))) {
      pending.set(`${row.serverId}:${row.dayzId}`, { ...row, poleX: Number(row.poleX), poleZ: Number(row.poleZ) });
    }
    for (const ev of batch) {
      cursor = ev.id;
      const pt = pointOf(ev.type, ev.payload);
      if (!pt) continue;
      out.scanned++;
      const m = pending.get(`${ev.serverId}:${pt.dayzId}`);
      if (!m) continue;
      if (distance2d({ x: pt.x, z: pt.z }, { x: m.poleX, z: m.poleZ }) > JOIN_PRESENCE_RADIUS_M) continue;
      const result = await db.transaction(async (tx) => {
        await lockDeclarations(tx, m.serverId);
        const released = await releaseTx(tx, { dayzId: m.dayzId, serverId: m.serverId }, ev.occurredAt);
        const rows = await tx.update(factionMembers)
          .set({ status: "full", seenAtBaseEventId: ev.id })
          .where(and(eq(factionMembers.id, m.memberId), eq(factionMembers.status, "pending")))
          .returning({ id: factionMembers.id });
        return rows.length > 0 ? { released } : null;
      });
      if (result) {
        out.promoted.push({ factionId: m.factionId, dayzId: m.dayzId, eventId: ev.id, releasedSoloBase: result.released });
        pending.delete(`${ev.serverId}:${pt.dayzId}`);
      }
    }
    await writeCursor(db, PRESENCE_CONSUMER, cursor);
  }
  return out;
}

/**
 * The reaper's pending half (spec §7): a pending member not seen at the base
 * within PENDING_EXPIRY_MS of accepting is removed. No cooldown — they never
 * joined. Returns who, so increment 3 can DM `pending_expired`.
 */
export async function expirePendingMembers(db: Database, now: Date): Promise<{ factionId: number; dayzId: string; discordId: string }[]> {
  return db.delete(factionMembers)
    .where(and(eq(factionMembers.status, "pending"), lte(factionMembers.pendingSince, new Date(now.getTime() - PENDING_EXPIRY_MS))))
    .returning({ factionId: factionMembers.factionId, dayzId: factionMembers.dayzId, discordId: factionMembers.discordId });
}
