import type { Database } from "@factions/db";
import { awardGrants, boosterKitChallenges } from "@factions/db";
import {
  KIT_PLACEMENT_TTL_MS, awardState, emoteLabel, isAwardPick, isOpenAward, picksComplete, type AwardState,
} from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { viewerForDb } from "./viewer";
import { issuePlacementChallenge } from "./internal/kit-placement-issue";
import type { KitChallenge, KitSpot } from "./booster-kit";

export type AwardSummary = {
  id: number; awardKey: string; label: string; reason: string; state: AwardState;
  placeBy: Date; liveFrom: Date | null; expiresAt: Date | null;
};
export type AwardView = AwardSummary & {
  picks: Record<string, string>;
  spot: KitSpot | null;
  linked: { gamertag: string } | null;
  challenge: KitChallenge | null;
};
/**
 * ⚠️ An OUTCOME, not a throw — booster-kit.ts's `SaveKitOutcome` rule. A
 * refusal is an answer for the page; a failed query is an outage and must
 * propagate as one.
 */
export type AwardWriteOutcome =
  | { ok: true }
  | { ok: false; reason: "not-found" | "ended" | "bad-slot" | "bad-pick" | "incomplete" | "not-linked" };

type Row = typeof awardGrants.$inferSelect;

function summary(g: Row, now: Date): AwardSummary {
  return {
    id: g.id, awardKey: g.awardKey, label: awardsCatalogue()[g.awardKey]?.label ?? g.awardKey,
    reason: g.reason, state: awardState(g, now), placeBy: g.placeBy, liveFrom: g.liveFrom, expiresAt: g.expiresAt,
  };
}

/**
 * ⚠️ Ownership is a WHERE predicate, never a check after the read (CLAUDE.md,
 * the map's rule). Another player's grant and a grant that does not exist are
 * the same answer — nothing — so an id off the wire cannot even confirm that
 * someone else won something.
 */
function owned(db: Database, discordId: string, grantId: number) {
  return db.select().from(awardGrants).where(and(eq(awardGrants.id, grantId), eq(awardGrants.discordId, discordId)));
}

/** Every grant the viewer holds, newest first, ended ones included (the page says why they ended). */
export async function awardsForDb(db: Database, discordId: string, now: Date): Promise<AwardSummary[]> {
  const rows = await db.select().from(awardGrants).where(eq(awardGrants.discordId, discordId)).orderBy(desc(awardGrants.id));
  return rows.map((g) => summary(g, now));
}

/** One grant's page, or null for a grant that is not the viewer's. */
export async function awardForDb(db: Database, discordId: string, grantId: number, now: Date): Promise<AwardView | null> {
  const [[g], viewer, [live]] = await Promise.all([
    owned(db, discordId, grantId),
    viewerForDb(db, discordId),
    db.select().from(boosterKitChallenges).where(and(
      eq(boosterKitChallenges.discordId, discordId),
      eq(boosterKitChallenges.awardGrantId, grantId),
      isNull(boosterKitChallenges.closedAt),
    )).limit(1),
  ]);
  if (!g) return null;
  // ⚠️ All three coordinates or none — booster-kit.ts's rule: a null through
  // Number() is 0, a spot at the corner of the map.
  const spot = g.posX !== null && g.posY !== null && g.posZ !== null
    ? { x: Number(g.posX), y: Number(g.posY), z: Number(g.posZ), placedAt: g.placedAt }
    : null;
  return {
    ...summary(g, now),
    picks: g.picks,
    spot,
    linked: viewer.link ? { gamertag: viewer.link.gamertag } : null,
    // ⚠️ Expiry applied here, as the kit's read does: the tick closes a stale
    // row only when that character next emotes.
    challenge: live && live.expiresAt > now
      ? {
          id: live.id, confirmed: live.progressIndex, expiresAt: live.expiresAt,
          steps: live.sequence.map((token, i) => ({ token, label: emoteLabel(token) ?? token, confirmed: i < live.progressIndex })),
        }
      : null,
  };
}

/**
 * Set or clear one slot.
 *
 * ⚠️ `isAwardPick` against the committed catalogue is the only thing between
 * a POST and an arbitrary class name in the spawner file.
 *
 * ⚠️ Writes `picks` and `updated_at` only. Position belongs to the placement
 * tick and the clock to the worker; a pick change must never disturb either.
 */
export async function saveAwardPickDb(db: Database, a: {
  discordId: string; grantId: number; slot: string; className: string; now: Date;
}): Promise<AwardWriteOutcome> {
  const [g] = await owned(db, a.discordId, a.grantId);
  if (!g) return { ok: false, reason: "not-found" };
  if (!isOpenAward(awardState(g, a.now))) return { ok: false, reason: "ended" };
  const def = awardsCatalogue()[g.awardKey];
  if (!def || !Object.hasOwn(def.slots, a.slot)) return { ok: false, reason: "bad-slot" };
  const className = a.className.trim();
  if (className !== "" && !isAwardPick(def, a.slot, className)) return { ok: false, reason: "bad-pick" };
  // ⚠️ A jsonb merge / key delete in ONE statement, never read-modify-write:
  // two quick taps on different slots would otherwise race and the loser's
  // slot would silently revert.
  const picks = className === ""
    ? sql`${awardGrants.picks} - ${a.slot}::text`
    : sql`${awardGrants.picks} || jsonb_build_object(${a.slot}::text, ${className}::text)`;
  await db.update(awardGrants).set({ picks, updatedAt: a.now })
    .where(and(eq(awardGrants.id, a.grantId), eq(awardGrants.discordId, a.discordId)));
  return { ok: true };
}

/**
 * Draw the emote sequence that marks where the award spawns.
 *
 * ⚠️ Refused until every slot is picked (spec §4.4). An award placed with a
 * gap would spawn part of a prize, which reads as a bug to the winner.
 */
export async function startAwardPlacementDb(db: Database, a: {
  discordId: string; grantId: number; now: Date; rng: () => number;
}): Promise<AwardWriteOutcome> {
  const [g] = await owned(db, a.discordId, a.grantId);
  if (!g) return { ok: false, reason: "not-found" };
  if (!isOpenAward(awardState(g, a.now))) return { ok: false, reason: "ended" };
  const def = awardsCatalogue()[g.awardKey];
  if (!def || !picksComplete(def, g.picks)) return { ok: false, reason: "incomplete" };
  const issued = await issuePlacementChallenge(db, {
    discordId: a.discordId, now: a.now, ttlMs: KIT_PLACEMENT_TTL_MS, rng: a.rng, awardGrantId: a.grantId,
  });
  return issued ? { ok: true } : { ok: false, reason: "not-linked" };
}

/**
 * Close this grant's open sequence, keeping any spot already marked.
 *
 * ⚠️ Scoped to the caller AND the grant, so it can close neither another
 * player's sequence nor this player's kit sequence.
 */
export async function cancelAwardPlacementDb(db: Database, a: { discordId: string; grantId: number; now: Date }): Promise<boolean> {
  const closed = await db.update(boosterKitChallenges).set({ closedAt: a.now })
    .where(and(
      eq(boosterKitChallenges.discordId, a.discordId),
      eq(boosterKitChallenges.awardGrantId, a.grantId),
      isNull(boosterKitChallenges.closedAt),
    ))
    .returning({ id: boosterKitChallenges.id });
  return closed.length > 0;
}
