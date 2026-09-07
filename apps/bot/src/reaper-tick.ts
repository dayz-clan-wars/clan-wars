import type { Database } from "@factions/db";
import { clanPins, intruderSightings, playerPositions } from "@factions/db";
import { INTRUDER_PIN_TTL_MS, POSITION_RETENTION_MS } from "@factions/domain";
import { lt, lte } from "drizzle-orm";

/**
 * The reaper's map half (spec §7): pins past `expires_at`, positions older
 * than POSITION_RETENTION_MS, intruder sightings with no fix for
 * INTRUDER_PIN_TTL_MS. Three plain deletes; nothing here notifies.
 * (Invites, requests and pending members have their own reapers already.)
 */
export async function reaperTick(db: Database, now: Date): Promise<{ pins: number; positions: number; sightings: number }> {
  const pins = await db.delete(clanPins).where(lte(clanPins.expiresAt, now)).returning({ id: clanPins.id });
  const positions = await db.delete(playerPositions).where(lt(playerPositions.occurredAt, new Date(now.getTime() - POSITION_RETENTION_MS))).returning({ id: playerPositions.id });
  const sightings = await db.delete(intruderSightings).where(lt(intruderSightings.lastSeenAt, new Date(now.getTime() - INTRUDER_PIN_TTL_MS))).returning({ id: intruderSightings.id });
  return { pins: pins.length, positions: positions.length, sightings: sightings.length };
}
