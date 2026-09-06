import type { Database } from "@factions/db";
import { declarations, defenses, factionMembers, factions, identityLinks, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { appendFactionEventTx, appendWarLogTx, noticeClanTx, noticeUserTx } from "@factions/roster/internal";
import { and, eq, sql } from "drizzle-orm";
import { openSeason } from "./season.js";

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
        const [decl] = await tx.select({ ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId })
          .from(declarations).where(and(eq(declarations.serverId, ev.serverId), eq(declarations.poleKey, p.poleKey)));

        if (decl?.ownerFactionId) {
          const [clan] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status, flagDownSince: factions.flagDownSince })
            .from(factions).where(eq(factions.id, decl.ownerFactionId)).for("update");
          if (!clan) return null;
          const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
            .where(and(eq(factionMembers.factionId, clan.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
          if (!full) {
            if (clan.status === "active" || clan.status === "dormant") {
              await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
              return "noticed" as const;
            }
            return null;
          }
          if (p.texture !== clan.texture) return null; // a member raising a foreign flag at home is nothing
          if (clan.status === "active" && clan.flagDownSince !== null) {
            const season = await openSeason(tx, ev.serverId);
            if (!season) return null;
            const siege = Math.max(0, Math.floor((ev.occurredAt.getTime() - clan.flagDownSince.getTime()) / 1000));
            await tx.insert(defenses).values({ factionId: clan.id, seasonId: season.id, raisedByDayzId: p.dayzId, eventId: ev.id, flagDownSince: clan.flagDownSince, defendedAt: ev.occurredAt, siegeSeconds: siege })
              .onConflictDoNothing({ target: defenses.eventId });
            await tx.update(factions).set({ flagDownSince: null, flagDownByDayzId: null }).where(eq(factions.id, clan.id));
            await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: clan.id, defenses: 1 })
              .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { defenses: sql`${seasonStandings.defenses} + 1` } });
            await appendWarLogTx(tx, { serverId: ev.serverId, kind: "defense", occurredAt: ev.occurredAt, payload: { victimClan: clan.name, victimTag: clan.tag, gamertag: p.gamertag, durationSeconds: siege } });
            await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "defended", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, durationSeconds: siege } });
            return "defense" as const;
          }
          if (clan.status === "dormant") {
            await tx.update(factions).set({ status: "active", dormantSince: null, dormantReason: null, disbandWarnedAt: null, flagDownSince: null, flagDownByDayzId: null }).where(eq(factions.id, clan.id));
            await appendFactionEventTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "revived", occurredAt: ev.occurredAt, payload: { name: clan.name, tag: clan.tag, texture: clan.texture, actor: p.gamertag } });
            await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "revived", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
            return "revived" as const;
          }
          return null; // an ordinary upkeep raise: the dormancy clock reads it through LAST_RAISE
        }

        if (decl?.ownerDayzId) {
          if (decl.ownerDayzId === p.dayzId) return null;
          const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, decl.ownerDayzId));
          if (!link) return null;
          await noticeUserTx(tx, { serverId: ev.serverId, factionId: null, discordId: link.discordId, kind: "solo_non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
          return "noticed" as const;
        }

        // Undeclared pole: does the texture belong to a holding clan on this server?
        const [owner] = await tx.select({ id: factions.id, status: factions.status }).from(factions)
          .where(and(eq(factions.serverId, ev.serverId), eq(factions.texture, p.texture), sql`${factions.status} in ('reserved','active','dormant')`));
        if (!owner || owner.status === "reserved") return null; // activation is ceremony-tick's
        const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, owner.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        if (full) {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "rebind_proposed", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, link: `${opts.siteBaseUrl}/clan/settings` } });
        } else {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "colors_elsewhere", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
        }
        return "noticed" as const;
      });
      if (r === "defense") out.defenses++;
      else if (r === "revived") out.revived++;
      else if (r === "noticed") out.noticed++;
    }
    await writeCursor(db, RAISE_CONSUMER, cursor);
  }
  return out;
}
