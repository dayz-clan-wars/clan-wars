import type { Database } from "@factions/db";
import { ceremonies } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { settleWindows, qualifies } from "@factions/ceremony";
import { NEUTRAL_FLAG } from "@factions/domain";
import { and, eq, lte } from "drizzle-orm";
import type { CeremonyStore, PoleRef, Participant } from "./ceremony-store.js";

/**
 * ⚠️ Distinct from `pole-projector` and `identity-verifier`. Two consumers
 * sharing a cursor name each skip the other's events, and the symptom is
 * "detection randomly doesn't work" rather than an error. This is the third
 * consumer of this log; the collision is no longer hypothetical.
 */
export const CEREMONY_CONSUMER = "ceremony-detector";

export const PROVISIONAL_TTL_MS = 86_400_000;

export type CeremonyTickResult = {
  /** flag.raised events examined. */
  scanned: number;
  /** qualifying neutral-flag raises recorded. */
  recorded: number;
  /** windows consumed, whether or not they produced a ceremony. */
  settled: number;
  /** ceremonies created. */
  detected: number;
  /** reservations activated. */
  activated: number;
  /** reservations lapsed. */
  lapsed: number;
};

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };

function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  if (typeof p.texture !== "string" || p.texture === "") return null;
  if (typeof p.poleKey !== "string" || p.poleKey === "") return null;
  if (typeof p.gamertag !== "string" || p.gamertag === "") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey };
}

/** One pass: record qualifying raises, settle what the log has passed, expire what is stale. */
export async function ceremonyTick(
  db: Database,
  store: CeremonyStore,
  opts: { batchSize?: number; now?: Date; provisionalTtlMs?: number } = {},
): Promise<CeremonyTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  const ttl = opts.provisionalTtlMs ?? PROVISIONAL_TTL_MS;
  const out: CeremonyTickResult = { scanned: 0, recorded: 0, settled: 0, detected: 0, activated: 0, lapsed: 0 };

  // Phase 1 — record. The cursor advances here and only here.
  let cursor = await readCursor(db, CEREMONY_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised") continue;
      const p = readFlagPayload(ev.payload);
      // A malformed payload is a parser bug, not a reason to stall the cursor.
      if (!p) continue;
      out.scanned++;
      const pole: PoleRef = { serverId: ev.serverId, poleKey: p.poleKey };

      // Activation: a reserved faction comes alive when its own flag goes up at
      // its own pole, raised by someone on its roster. Everything needed is
      // already in the event being read.
      if (p.texture !== NEUTRAL_FLAG) {
        const reserved = await store.reservedFactionAt(pole, p.texture);
        if (reserved && await store.isRosterMember(reserved.id, p.dayzId)) {
          if (await store.activate(reserved.id, ev.occurredAt)) out.activated++;
        }
        continue;
      }

      if (await store.isPoleBound(pole)) continue;
      // Linkage is checked at PROCESSING time, not at raise time: someone who
      // links shortly after the ceremony still counts. The forgiving reading,
      // and it costs nothing.
      if (await store.linkedDiscordId(p.dayzId) === null) continue;

      await store.recordRaise({
        ...pole, dayzId: p.dayzId, gamertag: p.gamertag,
        occurredAt: ev.occurredAt, eventId: ev.id,
      });
      out.recorded++;
    }
    await writeCursor(db, CEREMONY_CONSUMER, cursor);
  }

  // Phase 2 — settle. Separate from phase 1 on purpose: the raises are already
  // durable, so a throw here loses nothing and the next pass settles them.
  //
  // ⚠️ Each pole is handled inside its own try/catch, and that is load-bearing.
  // `settle` refuses to invent coordinates for a pole key it cannot parse —
  // correctly — but an escaping throw took the WHOLE tick with it. Phase 3
  // never ran, so nothing expired and no reservation ever lapsed; and since
  // the poisoned raises were never consumed, the same pole threw again on the
  // next tick and every tick after, forever, for every server on the box. A
  // permanent hole in the 33-flag pool is the exact failure the reservation
  // lifecycle exists to prevent, so one bad pole is logged and skipped.
  for (const pole of await store.polesWithPendingRaises()) {
    try {
      await settlePole(store, pole, { now, ttl, out });
    } catch (err) {
      console.error(`ceremony settle failed at pole ${pole.serverId}/${pole.poleKey}`, err);
    }
  }

  // Phase 3 — expire and lapse. BOTH clocks must have passed the deadline.
  //
  // ⚠️ The log-clock half is not redundant. If ingest stalls for a day,
  // wall-clock-only expiry retires a ceremony whose claim window we never had
  // the chance to observe, and lapses a faction that DID raise its flag.
  const tickServers = new Set([...await store.openCeremonyServers(), ...await store.reservedServers()]);
  for (const serverId of tickServers) {
    const highWater = await store.highWaterMark(serverId);
    if (!highWater) continue;
    const cutoff = highWater.getTime() < now.getTime() ? highWater : now;
    await db.update(ceremonies)
      .set({ status: "expired" })
      .where(and(
        eq(ceremonies.serverId, serverId),
        eq(ceremonies.status, "provisional"),
        lte(ceremonies.expiresAt, cutoff),
      ));
    out.lapsed += await store.lapseReservations(serverId, cutoff);
  }

  return out;
}

/** One pole's settleable windows. Extracted so phase 2 can isolate a failure to a single pole. */
async function settlePole(
  store: CeremonyStore,
  pole: PoleRef,
  ctx: { now: Date; ttl: number; out: CeremonyTickResult },
): Promise<void> {
  const { now, ttl, out } = ctx;
  const highWater = await store.highWaterMark(pole.serverId);
  if (!highWater) return;
  const pending = await store.pendingRaises(pole);
  for (const w of settleWindows(pending, highWater)) {
    out.settled++;
    // While a ceremony is outstanding at this pole, windows are consumed but
    // never create. Otherwise a pole under sustained White raises would try
    // to insert a ceremony every window and the partial unique index would
    // surface each as an error rather than the no-op it is.
    //
    // ⚠️ `isPoleBound` must be re-checked here, even though phase 1 already
    // checked it at record time. That earlier check is not enough: raises
    // recorded while the pole was unbound can still be sitting unsettled
    // when the pole becomes bound in between, because
    // `ceremonies_open_pole_uniq` is PARTIAL on status = 'provisional'.
    // Concretely: a ceremony opens at P; more raises land at P; the
    // ceremony gets claimed, so its status flips to 'claimed' and it stops
    // occupying the partial index; `hasOpenCeremony(P)` now reports false
    // even though P is a claimed faction's pole. Without this check, the
    // still-pending raises from before the claim would settle into a
    // SECOND ceremony at an already-bound pole — one that can never be
    // claimed, because claiming it collides with
    // `factions_holding_pole_uniq`. Bound poles are ineligible, full stop,
    // regardless of which check would have caught it first.
    const blocked = (await store.hasOpenCeremony(pole)) || (await store.isPoleBound(pole));
    let draft = null;
    if (!blocked && qualifies(w)) {
      const participants: Participant[] = [];
      for (const dayzId of w.participants) {
        const discordId = await store.linkedDiscordId(dayzId);
        // Unlinked between recording and settling: skip rather than write a
        // participant with no Discord account to DM.
        if (!discordId) continue;
        const gamertag = w.raises.find((r) => r.dayzId === dayzId)?.gamertag ?? "";
        participants.push({ dayzId, discordId, gamertag });
      }
      if (qualifies({ ...w, participants: participants.map((x) => x.dayzId) })) {
        draft = { detectedAt: now, expiresAt: new Date(now.getTime() + ttl), participants };
      }
    }
    if (await store.settle(pole, w, draft) !== null) out.detected++;
  }
}
