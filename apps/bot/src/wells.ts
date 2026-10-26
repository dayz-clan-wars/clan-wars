import { WELL_BRICK_PART, WELL_RADIUS_M, WELL_ROOF_PART, RUIN_RUBBLE_RE } from "@factions/domain";
import { events, type Database } from "@factions/db";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";

/** One `base.built` line that bears on a well: a brick, a roof, or rubble. */
export type WellStep = { id: number; at: Date; serverId: number; dayzId: string; part: string; x: number; z: number };

/**
 * SQL for "this event's payload position is within WELL_RADIUS_M of (x, z)" (flat, ignores height).
 * ⚠️ The one statement of the distance rule: bricksNear and any query that asks "is there a well
 * here" must build it through this, or two radii drift apart and a well is two different wells.
 */
export function withinWellRadius(xExpr: SQL, zExpr: SQL, x: SQL | number, z: SQL | number): SQL {
  return sql`sqrt(power(${xExpr} - ${x}, 2) + power(${zExpr} - ${z}, 2)) <= ${WELL_RADIUS_M}`;
}

const posX = sql`(${events.payload}->'pos'->>'x')::float`;
const posZ = sql`(${events.payload}->'pos'->>'z')::float`;

/** The owner's well steps (bricks, roofs, rubble) in time order. Lines with no position are skipped: they cannot be placed. */
export async function wellStepsOf(db: Database, dayzId: string): Promise<WellStep[]> {
  const part = sql<string>`${events.payload}->>'part'`;
  const rows = await db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId, part, x: posX, z: posZ }).from(events)
    .where(and(
      eq(events.type, "base.built"), sql`${events.payload}->>'dayzId' = ${dayzId}`,
      sql`(${part} in (${WELL_BRICK_PART}, ${WELL_ROOF_PART}) or ${part} ~ ${RUIN_RUBBLE_RE.source})`,
      sql`${events.payload}->'pos'->>'x' is not null and ${events.payload}->'pos'->>'z' is not null`,
    ))
    .orderBy(asc(events.occurredAt), asc(events.id));
  return rows.map((r) => ({ id: r.id, at: r.at, serverId: r.serverId, dayzId, part: r.part, x: Number(r.x), z: Number(r.z) }));
}

/** Every well brick on the server within the well radius of (x, z), by any player, in time order. */
export async function bricksNear(db: Database, serverId: number, x: number, z: number): Promise<{ id: number; at: Date }[]> {
  return db.select({ id: events.id, at: events.occurredAt }).from(events)
    .where(and(
      eq(events.type, "base.built"), eq(events.serverId, serverId),
      sql`${events.payload}->>'part' = ${WELL_BRICK_PART}`,
      withinWellRadius(posX, posZ, x, z),
    ))
    .orderBy(asc(events.occurredAt), asc(events.id));
}

/**
 * The id of a well's earliest brick: **the well's identity**. Bricks keep arriving as people
 * rebuild, but the first one never changes, so anything that must remember "this well" (the
 * plate-carrier award) keys on it. `bricks` must be in bricksNear's order.
 */
export function wellAnchor(bricks: { id: number; at: Date }[]): number {
  const first = bricks[0];
  if (!first) throw new Error("wellAnchor needs at least one brick");
  return first.id;
}
