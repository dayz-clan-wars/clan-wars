import type { Database } from "@factions/db";
import { clanPins, intruderSightings, playerPositions, guestPasses } from "@factions/db";
import { GUEST_PASS_MS, INTRUDER_PIN_TTL_MS, POSITION_RETENTION_MS } from "@factions/domain";
import { and, lt, lte, or, isNotNull } from "drizzle-orm";

/**
 * The reaper's map half (spec §7): pins past `expires_at`, positions older
 * than POSITION_RETENTION_MS, intruder sightings with no fix for
 * INTRUDER_PIN_TTL_MS. Plus guest passes: expired outright, or revoked/
 * converted more than GUEST_PASS_MS ago (the reconciler has long since
 * removed any overwrite for either). Plain deletes; nothing here notifies.
 * (Invites, requests and pending members have their own reapers already.)
 */
export async function reaperTick(db: Database, now: Date): Promise<{ pins: number; positions: number; sightings: number; guestPasses: number }> {
  const pins = await db.delete(clanPins).where(lte(clanPins.expiresAt, now)).returning({ id: clanPins.id });
  const positions = await db.delete(playerPositions).where(lt(playerPositions.occurredAt, new Date(now.getTime() - POSITION_RETENTION_MS))).returning({ id: playerPositions.id });
  const sightings = await db.delete(intruderSightings).where(lt(intruderSightings.lastSeenAt, new Date(now.getTime() - INTRUDER_PIN_TTL_MS))).returning({ id: intruderSightings.id });
  const staleSince = new Date(now.getTime() - GUEST_PASS_MS);
  const passes = await db.delete(guestPasses).where(
    or(
      lte(guestPasses.expiresAt, now),
      and(isNotNull(guestPasses.revokedAt), lte(guestPasses.revokedAt, staleSince)),
      and(isNotNull(guestPasses.convertedAt), lte(guestPasses.convertedAt, staleSince)),
    ),
  ).returning({ id: guestPasses.id });
  return { pins: pins.length, positions: positions.length, sightings: sightings.length, guestPasses: passes.length };
}
