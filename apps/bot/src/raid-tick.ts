import type { Database } from "@factions/db";
import { factionMembers, factions, raids, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { RAID_DEDUP_MS, clanValue, raidPoints, scoringWeekStartOf } from "@factions/domain";
import { appendWarLogTx, noticeClanTx, noticeFullMembersTx } from "@factions/roster/internal";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { classifyLower, clanOnlineAt, seasonRaidFacts } from "./raid-detect.js";
import { openSeason } from "./season.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const RAID_CONSUMER = "raid-consumer";

export type RaidTickResult = { scanned: number; raids: number; absorbed: number; skippedNoSeason: number };

export type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };
export function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.gamertag !== "string" || typeof p.texture !== "string" || typeof p.poleKey !== "string") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey };
}

/**
 * The raid consumer (spec §5.8, §7, §8.2; raid value spec 2026-11-06 §1–§2).
 * `classifyLower` decides who a `flag.lowered` raids: an active clan at its
 * declared base, or (away) a clan whose own flag was lowered somewhere else.
 * One row per (raider clan, victim) per 24 h from the first lower; later
 * lowers inside the window update `last_lower_at`/`last_lower_event_id`/
 * `lower_count` and score nothing. A raid pays the victim's live value
 * (`clanValue`) × the online multiplier. Everything happens under the
 * victim's `factions` row lock, then `season_standings`, then `raids`, then
 * the war-log row and the notices — last, per §4.12.
 *
 * An away raid scores, dedups, logs and counts as a hit exactly like a base
 * raid, but never starts the flag-down clock: the pole is not the clan's
 * base, so it must not drive the crate or dormancy.
 */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * `factions` after `raids` reads as out of §4.12 order, but no new lock is
 * taken: the victim's row has been held FOR UPDATE since just after
 * classification, at the top of the transaction.
 */
async function setFlagDown(tx: Tx, factionId: number, at: Date, byDayzId: string) {
  await tx.update(factions).set({ flagDownSince: at, flagDownByDayzId: byDayzId }).where(eq(factions.id, factionId));
}

async function queueFlagDown(tx: Tx, serverId: number, factionId: number, at: Date, gamertag: string, raiderClan: string | null) {
  const notice = { gamertag, raiderClan };
  await noticeClanTx(tx, { serverId, factionId, kind: "flag_down", occurredAt: at, payload: notice });
  await noticeFullMembersTx(tx, { serverId, factionId, kind: "flag_down", occurredAt: at, payload: notice });
}

/** The absorb path's clock start: no war-log row, since the raid it folds into was already logged. */
async function startFlagDown(tx: Tx, serverId: number, factionId: number, at: Date, byDayzId: string, gamertag: string, raiderClan: string | null) {
  await setFlagDown(tx, factionId, at, byDayzId);
  await queueFlagDown(tx, serverId, factionId, at, gamertag, raiderClan);
}

export async function raidTick(db: Database, opts: { batchSize?: number; onNoSeason?: (serverId: number) => void } = {}): Promise<RaidTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: RaidTickResult = { scanned: 0, raids: 0, absorbed: 0, skippedNoSeason: 0 };
  let cursor = await readCursor(db, RAID_CONSUMER);
  const warned = new Set<number>();
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.lowered") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const result = await db.transaction(async (tx) => {
        // ⚠️ Every exit from this transaction goes through `done`, which
        // commits the consumer cursor in the SAME transaction as the event's
        // effects. A mid-batch failure therefore rolls back an unfinished
        // event and nothing else: the next tick resumes at the last event
        // that fully committed, and an already-applied event can never be
        // replayed. The unique/`last_lower_event_id` guards below stay as
        // belt-and-braces (the log is at-least-once by contract).
        const done = async <T,>(v: T): Promise<T> => {
          await writeCursor(tx, RAID_CONSUMER, ev.id);
          return v;
        };
        // Classification only reads (no row locks), so it cannot take a lock
        // out of §4.12 order; the victim's `factions` row is locked FIRST
        // among this transaction's locks, right after.
        const verdict = await classifyLower(tx, { serverId: ev.serverId, occurredAt: ev.occurredAt, dayzId: p.dayzId, poleKey: p.poleKey, texture: p.texture });
        if (verdict.kind === "none") return done("no-raid" as const); // upkeep, or no clan's flag
        const away = verdict.away;
        // ⚠️ Re-check `active` under the lock: classification read without
        // one, and a dormancy/disband commit in between would otherwise let a
        // raid land on a clan that is no longer raidable.
        const [victim] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, flagDownSince: factions.flagDownSince, activatedAt: factions.activatedAt })
          .from(factions).where(and(eq(factions.id, verdict.victimFactionId), eq(factions.status, "active")))
          .for("update");
        if (!victim) return done("no-raid" as const);
        const season = await openSeason(tx, ev.serverId);
        if (!season) return done("no-season" as const);
        // The raider's clan, if any (full membership on this server).
        const [raider] = await tx.select({ factionId: factionMembers.factionId, name: factions.name, tag: factions.tag }).from(factionMembers)
          .innerJoin(factions, eq(factions.id, factionMembers.factionId))
          .where(and(eq(factionMembers.serverId, ev.serverId), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        const raiderFactionId = raider?.factionId ?? null;
        // Dedup under the victim's lock (§8.2).
        const since = new Date(ev.occurredAt.getTime() - RAID_DEDUP_MS);
        const [open] = await tx.select({ id: raids.id, lastLowerEventId: raids.lastLowerEventId, away: raids.away }).from(raids).where(and(
          eq(raids.victimFactionId, victim.id), gt(raids.firstLowerAt, since),
          raiderFactionId === null ? and(isNull(raids.raiderFactionId), eq(raids.raiderDayzId, p.dayzId))! : eq(raids.raiderFactionId, raiderFactionId),
        )).orderBy(desc(raids.firstLowerAt)).limit(1);
        // ⚠️ A base lower absorbed into an earlier AWAY raid by the same clan
        // still has to start the flag-down clock: the away raid never did,
        // and without this the base would sit raided with no clock, no
        // crate pause and no flag_down notice. Base-after-base absorbs keep
        // today's behaviour (the first lower already started the clock).
        const startsClock = !away && victim.flagDownSince === null;
        if (open) {
          // ⚠️ `ev.id` is the true idempotency guard here, not `lastLowerAt`.
          // A redelivery of an event already folded into this raid (any
          // at-least-once replay, not only a crash — see raid-tick.ts's
          // header) carries an id no greater than `lastLowerEventId`; taking
          // the absorb branch again for it would double-count `lower_count`.
          // Only a genuinely new lower (`ev.id` strictly greater) advances
          // the row; an already-applied replay is a no-op.
          if (ev.id > open.lastLowerEventId) {
            await tx.update(raids).set({ lastLowerAt: ev.occurredAt, lastLowerEventId: ev.id, lowerCount: sql`${raids.lowerCount} + 1` }).where(eq(raids.id, open.id));
            if (open.away && startsClock) await startFlagDown(tx, ev.serverId, victim.id, ev.occurredAt, p.dayzId, p.gamertag, raider?.name ?? null);
          }
          return done("absorbed" as const);
        }
        // Points (value spec §1): the victim's value just before this raid,
        // from the season's raid rows, × the online multiplier. This row is
        // not inserted yet, so it cannot be in its own price. ⚠️ The
        // excludeRaidId of MAX_SAFE_INTEGER makes a same-instant earlier row
        // count, as it does in the season rescore (which orders by id with
        // every row present); every existing row was written before this one.
        const online = await clanOnlineAt(tx, ev.serverId, victim.id, ev.occurredAt);
        // ⚠️ A null activated_at cannot pass the `active` check in practice;
        // if one ever does, treat it as activated now (worth 0), never as
        // epoch (worth full price).
        const valued = { id: victim.id, activatedAt: victim.activatedAt ?? ev.occurredAt };
        const value = clanValue(valued, await seasonRaidFacts(tx, season.id), ev.occurredAt, Number.MAX_SAFE_INTEGER);
        // Solo raids stay real, announced raids that score nothing (spec non-goal).
        const points = raiderFactionId === null ? 0 : raidPoints(value, online);
        // Standings before raids, per §4.12's documented lock order.
        //
        // ⚠️ The two rows are upserted in `faction_id` order, not
        // victim-then-raider. §4.12 fixes the order BETWEEN tables and is
        // silent WITHIN one; two simultaneous raids with swapped roles (A
        // raids B while B raids A) would otherwise take the same two
        // `season_standings` rows in opposite orders and deadlock. Sorting by
        // a stable key is free and removes the cycle.
        const standings = [
          { factionId: victim.id, values: { seasonId: season.id, factionId: victim.id, timesRaided: 1 }, set: { timesRaided: sql`${seasonStandings.timesRaided} + 1` } },
          ...(raiderFactionId === null ? [] : [{ factionId: raiderFactionId, values: { seasonId: season.id, factionId: raiderFactionId, points, raids: 1 }, set: { points: sql`${seasonStandings.points} + ${points}`, raids: sql`${seasonStandings.raids} + 1` } }]),
        ].sort((a, b) => a.factionId - b.factionId);
        for (const u of standings) {
          await tx.insert(seasonStandings).values(u.values)
            .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: u.set });
        }
        await tx.insert(raids).values({
          seasonId: season.id, serverId: ev.serverId, victimFactionId: victim.id, raiderDayzId: p.dayzId, raiderFactionId,
          firstLowerEventId: ev.id, firstLowerAt: ev.occurredAt, lastLowerAt: ev.occurredAt, lastLowerEventId: ev.id, lowerCount: 1,
          points, victimOnline: online, away,
          // The rank ladder is retired; new rows carry no rank (value spec §1).
          victimRankAtLower: null, rankedCountAtLower: null,
          weekStart: scoringWeekStartOf(ev.occurredAt),
        });
        // ⚠️ The war-log line is the same for base and away raids, on
        // purpose: saying "away" would hint at where the base is not.
        const payload = { raiderClan: raider?.name ?? null, raiderTag: raider?.tag ?? null, victimClan: victim.name, victimTag: victim.tag, gamertag: p.gamertag, solo: raider === undefined, points };
        if (away) {
          await appendWarLogTx(tx, { serverId: ev.serverId, kind: "raid", occurredAt: ev.occurredAt, payload });
          // Channel only, no DMs: nothing is at stake for the base, so it
          // does not warrant waking every member the way flag_down does.
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: victim.id, kind: "flag_lowered_away", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, raiderClan: raider?.name ?? null } });
          return done("raid" as const);
        }
        // The clock starts on the FIRST lower of an episode; a second raid during flag-down does not restart it.
        if (startsClock) await setFlagDown(tx, victim.id, ev.occurredAt, p.dayzId);
        await appendWarLogTx(tx, { serverId: ev.serverId, kind: "raid", occurredAt: ev.occurredAt, payload });
        if (startsClock) await queueFlagDown(tx, ev.serverId, victim.id, ev.occurredAt, p.gamertag, raider?.name ?? null);
        return done("raid" as const);
      });
      if (result === "raid") out.raids++;
      else if (result === "absorbed") out.absorbed++;
      else if (result === "no-season") {
        out.skippedNoSeason++;
        if (!warned.has(ev.serverId)) { warned.add(ev.serverId); opts.onNoSeason?.(ev.serverId); }
      }
    }
    // The tail: events this consumer skipped outright (wrong type, unparseable
    // payload) opened no transaction, so nothing has advanced the cursor past
    // them. They have no effects, so replaying them is free — this write just
    // saves the next tick from re-reading them.
    await writeCursor(db, RAID_CONSUMER, cursor);
  }
  return out;
}
