import type { Database } from "@factions/db";
import { declarations, defenses, factionMembers, factions, identityLinks, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { appendWarLogTx, noticeClanTx, noticeUserTx } from "@factions/roster/internal";
import { FLAG_DOWN_MS } from "@factions/domain";
import { and, eq, sql } from "drizzle-orm";
import { openSeason } from "./season.js";
import { reviveFactionTx } from "./dormancy-store.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const RAISE_CONSUMER = "raise-consumer";

export type RaiseTickResult = { scanned: number; defenses: number; revived: number; noticed: number };

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };
function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.gamertag !== "string" || typeof p.texture !== "string" || typeof p.poleKey !== "string") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey };
}

/**
 * Every `flag.raised` the roster cares about, in one pass (spec §7: defense,
 * revive, non-member raise, colors elsewhere, rebind proposal). Activation
 * stays in ceremony-tick; the 7-day clock stays in dormancy-tick. Order of
 * checks per event:
 *   1. the pole is a clan's declaration → member/non-member branch
 *   2. else the pole is a solo declaration → non-member DM
 *   3. else, if the texture belongs to a clan → proposal or colors elsewhere
 *
 * ⚠️ Lock order (§4.12): `factions` FOR UPDATE first, then declarations,
 * poles, faction_members, … `season_standings` BEFORE `defenses`, then
 * faction_events, war_log_events, clan_notices last. The spec fixes
 * `season_standings → raids → defenses` as an order that is "extended, never
 * reordered" — `raid-tick.ts` writes standings before its `raids` row for the
 * same reason, and the defense branch below writes standings before
 * `defenses` to match.
 */
export async function raiseTick(db: Database, opts: { batchSize?: number; siteBaseUrl: string }): Promise<RaiseTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: RaiseTickResult = { scanned: 0, defenses: 0, revived: 0, noticed: 0 };
  let cursor = await readCursor(db, RAISE_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const r = await db.transaction(async (tx) => {
        // ⚠️ Every exit from this transaction goes through `done`, which
        // commits the consumer cursor in the SAME transaction as the event's
        // effects. Four of the branches below (non_member_raise,
        // solo_non_member_raise, rebind_proposed, colors_elsewhere) write
        // nothing but a queue row and so have no unique key to dedupe on; the
        // cursor is what makes them replay-proof. A mid-batch failure now
        // rolls back exactly the unfinished event.
        const done = async <T,>(v: T): Promise<T> => {
          await writeCursor(tx, RAISE_CONSUMER, ev.id);
          return v;
        };
        const [decl] = await tx.select({ ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId })
          .from(declarations).where(and(eq(declarations.serverId, ev.serverId), eq(declarations.poleKey, p.poleKey)));

        if (decl?.ownerFactionId) {
          const [clan] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status, flagDownSince: factions.flagDownSince })
            .from(factions).where(eq(factions.id, decl.ownerFactionId)).for("update");
          if (!clan) return done(null);
          const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
            .where(and(eq(factionMembers.factionId, clan.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
          if (!full) {
            if (clan.status === "active" || clan.status === "dormant") {
              await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
              return done("noticed" as const);
            }
            return done(null);
          }
          if (p.texture !== clan.texture) return done(null); // a member raising a foreign flag at home is nothing
          // ⚠️ Bounded by FLAG_DOWN_MS (§5.8). `dormancy-tick` decides against
          // wall-clock now while this consumer decides against event time, and
          // during any backlog (bot down, ingest catching up) a raise can
          // arrive long after the flag went down. A raise at or after
          // `flag_down_since + FLAG_DOWN_MS` is NOT a defense: it scores
          // nothing and, crucially, does not clear `flag_down_since`, so the
          // dormancy clock still converts the clan to dormant(raided) and this
          // same raise revives it through the dormant branch below on a later
          // tick — the state machine §5.8 describes.
          const siegeMs = clan.flagDownSince === null ? 0 : ev.occurredAt.getTime() - clan.flagDownSince.getTime();
          if (clan.status === "active" && clan.flagDownSince !== null && siegeMs < FLAG_DOWN_MS) {
            const season = await openSeason(tx, ev.serverId);
            if (!season) return done(null);
            const siege = Math.max(0, Math.floor(siegeMs / 1000));
            // ⚠️ Replay guard, and the reason the standings increment below is
            // safe. A plain SELECT takes no lock, so §4.12 is unaffected, and
            // the clan's `factions` row is already held FOR UPDATE — no other
            // transaction can insert a defense for this clan meanwhile. If the
            // defense row for this event already exists, the whole branch has
            // already been applied: do not double-count the standings, the
            // war-log line or the notice.
            const [already] = await tx.select({ id: defenses.id }).from(defenses).where(eq(defenses.eventId, ev.id));
            if (already) return done(null);
            // Standings before defenses, per §4.12's documented lock order
            // ("extended, never reordered") — the same order raid-tick.ts
            // writes standings before its raids row.
            await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: clan.id, defenses: 1 })
              .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { defenses: sql`${seasonStandings.defenses} + 1` } });
            await tx.insert(defenses).values({ factionId: clan.id, seasonId: season.id, raisedByDayzId: p.dayzId, eventId: ev.id, flagDownSince: clan.flagDownSince, defendedAt: ev.occurredAt, siegeSeconds: siege })
              .onConflictDoNothing({ target: defenses.eventId });
            await tx.update(factions).set({ flagDownSince: null, flagDownByDayzId: null }).where(eq(factions.id, clan.id));
            await appendWarLogTx(tx, { serverId: ev.serverId, kind: "defense", occurredAt: ev.occurredAt, payload: { victimClan: clan.name, victimTag: clan.tag, gamertag: p.gamertag, durationSeconds: siege } });
            await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "defended", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, durationSeconds: siege } });
            return done("defense" as const);
          }
          if (clan.status === "dormant") {
            // Shared with the dormancy clock's own revive() (Major #3, review
            // round 1) — see dormancy-store.ts's reviveFactionTx for what it
            // clears and why. The SELECT … FOR UPDATE above already
            // established `status === "dormant"` inside this transaction, so
            // no further guard is needed here. reviveFactionTx itself queues
            // the "revived" notice (with the gamertag, since an actor is
            // given here) — a second one here would double-notify.
            await reviveFactionTx(tx, clan.id, ev.occurredAt, { dayzId: p.dayzId, gamertag: p.gamertag });
            return done("revived" as const);
          }
          return done(null); // an ordinary upkeep raise: the dormancy clock reads it through LAST_RAISE
        }

        if (decl?.ownerDayzId) {
          if (decl.ownerDayzId === p.dayzId) return done(null);
          const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, decl.ownerDayzId));
          if (!link) return done(null);
          await noticeUserTx(tx, { serverId: ev.serverId, factionId: null, discordId: link.discordId, kind: "solo_non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
          return done("noticed" as const);
        }

        // Undeclared pole: does the texture belong to a holding clan on this server?
        const [owner] = await tx.select({ id: factions.id, status: factions.status }).from(factions)
          .where(and(eq(factions.serverId, ev.serverId), eq(factions.texture, p.texture), sql`${factions.status} in ('reserved','active','dormant')`));
        if (!owner || owner.status === "reserved") return done(null); // activation is ceremony-tick's
        const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, owner.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        if (full) {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "rebind_proposed", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, link: `${opts.siteBaseUrl}/clan/settings` } });
        } else {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "colors_elsewhere", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
        }
        return done("noticed" as const);
      });
      if (r === "defense") out.defenses++;
      else if (r === "revived") out.revived++;
      else if (r === "noticed") out.noticed++;
    }
    // The tail: events this consumer skipped outright (wrong type, unparseable
    // payload) opened no transaction. They have no effects, so replaying them
    // is free — this write just saves the next tick from re-reading them.
    await writeCursor(db, RAISE_CONSUMER, cursor);
  }
  return out;
}
