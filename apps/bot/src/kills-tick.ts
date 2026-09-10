import type { Database } from "@factions/db";
import { kills, events } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { classifyDeath, finishedBy, RECENT_HIT_WINDOW_S, type RecentHit, type RecentUnconscious } from "@factions/domain";
import { and, eq, gte, lte, inArray, sql } from "drizzle-orm";
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
type DiedPayload = { victimDayzId: string; cause: string; water: number | null; energy: number | null; bleedSources: number | null };
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

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
  return { victimDayzId: p.victimDayzId, cause: p.cause, water: num(p.water), energy: num(p.energy), bleedSources: num(p.bleedSources) };
}

/** What a bare `died` resolves to: a cause word, or a credited kill with the finishing player's hit. */
type Verdict = { cause: string; finisher: RecentHit | null };

/**
 * What the log said "died." meant: the victim's hits and knockouts in the
 * RECENT_HIT_WINDOW_S before the death, handed to the domain's two rules
 * with the death line's own stats — `finishedBy` first (a player shot them
 * to near-zero and nothing else touched them: a kill, `cause = 'finished'`),
 * then `classifyDeath`'s ladder. Only a bare `died` is looked up — a stated
 * cause passes straight through.
 *
 * ⚠️ Evidence is matched by occurred_at and the victim's id, never by event
 * id order: a reparse backfills hit events at the head of the log with
 * their true occurred_at, and a rebuild after it must still find them.
 */
async function verdictOf(db: Database, serverId: number, payload: DiedPayload, at: Date): Promise<Verdict> {
  if (payload.cause !== "died") return { cause: payload.cause, finisher: null };
  const from = new Date(at.getTime() - RECENT_HIT_WINDOW_S * 1000);
  const rows = await db.select({ type: events.type, occurredAt: events.occurredAt, payload: events.payload }).from(events).where(and(
    eq(events.serverId, serverId),
    inArray(events.type, ["player.hit", "player.unconscious"]),
    gte(events.occurredAt, from), lte(events.occurredAt, at),
    sql`coalesce(${events.payload}->>'victimDayzId', ${events.payload}->>'dayzId') = ${payload.victimDayzId}`,
  ));
  const secondsBefore = (t: Date) => Math.round((at.getTime() - t.getTime()) / 1000);
  const hits: RecentHit[] = []; const outs: RecentUnconscious[] = [];
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>;
    if (r.type === "player.hit") {
      const type = p.attackerType;
      hits.push({ attackerType: type === "player" || type === "infected" ? type : "environment", attackerLabel: typeof p.attackerLabel === "string" ? p.attackerLabel : null,
        victimHp: num(p.victimHp), secondsBeforeDeath: secondsBefore(r.occurredAt),
        attackerId: typeof p.attackerDayzId === "string" ? p.attackerDayzId : null, weapon: typeof p.weapon === "string" ? p.weapon : null, distanceM: num(p.distanceM) });
    } else {
      outs.push({ disconnecting: p.disconnecting === true, secondsBeforeDeath: secondsBefore(r.occurredAt) });
    }
  }
  // A player cannot finish themselves: their own hit (a self-inflicted wound) is not a credit.
  const finisher = finishedBy(hits.filter((h) => h.attackerId !== payload.victimDayzId), outs);
  if (finisher) return { cause: "finished", finisher };
  return { cause: classifyDeath({ mechanism: payload.cause, water: payload.water, energy: payload.energy, bleedSources: payload.bleedSources }, hits, outs), finisher: null };
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
            // ⚠️ `cause` is DESCRIPTIVE ONLY — nothing reads it. The column
            // holds `DeathCause ∪ {'pvp'}`, and `'pvp'` is not a `DeathCause`.
            // PvP is decided by `killer_dayz_id` (set, and not equal to the
            // victim), never by this string: `cause = 'pvp'` would count
            // self-kills as PvP kills. See the column comment in schema.ts.
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

        const [victimFactionId, { cause, finisher }] = await Promise.all([
          membershipAt(db, ev.serverId, payload.victimDayzId, ev.occurredAt),
          verdictOf(db, ev.serverId, payload, ev.occurredAt),
        ]);
        // A credited kill is a kill: killer set, faction and friendly fire resolved exactly as for a
        // `player.killed` line. The stats and the kill feed key on `killer_dayz_id`, so it counts.
        const killerDayzId = finisher?.attackerId ?? null;
        const killerFactionId = killerDayzId === null ? null : await membershipAt(db, ev.serverId, killerDayzId, ev.occurredAt);
        const friendlyFire = killerFactionId !== null && killerFactionId === victimFactionId;

        const inserted = await db
          .insert(kills)
          .values({
            serverId: ev.serverId,
            eventId: ev.id,
            occurredAt: ev.occurredAt,
            victimDayzId: payload.victimDayzId,
            killerDayzId,
            weapon: finisher?.weapon ?? null,
            distanceM: finisher?.distanceM == null ? null : String(finisher.distanceM),
            // `DeathCauseWord` (@factions/domain): the parser's word, the verdict's for a bare `died`,
            // or `finished` for a credited kill.
            cause,
            victimFactionId,
            killerFactionId,
            friendlyFire,
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
