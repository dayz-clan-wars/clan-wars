import type { Database } from "@factions/db";
import { poles, flagChanges } from "@factions/db";
import type { Vec3 } from "@factions/domain";
import { and, eq } from "drizzle-orm";

/** A player must stand at a pole to fold it, so 10m is generous. */
export const NEAREST_POLE_RADIUS_M = 10;

type EventRow = {
  id: number; serverId: number; type: string;
  occurredAt: Date; payload: unknown;
};

type FlagPayload = {
  gamertag: string; dayzId: string; texture: string;
  action: "raised" | "lowered"; pole: Vec3; poleKey: string;
};

type FlagPolePayload = {
  gamertag: string; dayzId: string;
  action: "placed_kit" | "folded" | "built" | "dismantled";
  player: Vec3 | null;
};

export async function applyEvent(db: Database, map: string, ev: EventRow): Promise<void> {
  if (ev.type === "flag.raised" || ev.type === "flag.lowered") {
    return applyFlagChange(db, map, ev, ev.payload as FlagPayload);
  }
  if (ev.type === "flagpole.folded") {
    return applyFold(db, map, ev, ev.payload as FlagPolePayload);
  }
  // placed/built/dismantled and player.position carry no pole identity and are not
  // projected here. Later plans consume them from the event log directly.
}

async function applyFlagChange(db: Database, map: string, ev: EventRow, p: FlagPayload): Promise<void> {
  const raised = p.action === "raised";

  await db.insert(poles).values({
    serverId: ev.serverId,
    map,
    poleKey: p.poleKey,
    x: p.pole.x.toFixed(2),
    y: p.pole.y.toFixed(2),
    z: p.pole.z.toFixed(2),
    currentTexture: p.texture,
    flagRaised: raised,
    firstSeenAt: ev.occurredAt,
    lastSeenAt: ev.occurredAt,
  }).onConflictDoUpdate({
    target: [poles.serverId, poles.map, poles.poleKey],
    set: { currentTexture: p.texture, flagRaised: raised, lastSeenAt: ev.occurredAt },
  });

  await db.insert(flagChanges).values({
    eventId: ev.id,
    serverId: ev.serverId,
    map,
    poleKey: p.poleKey,
    dayzId: p.dayzId,
    gamertag: p.gamertag,
    action: p.action,
    texture: p.texture,
    occurredAt: ev.occurredAt,
  }).onConflictDoNothing({ target: flagChanges.eventId });
}

async function applyFold(db: Database, map: string, ev: EventRow, p: FlagPolePayload): Promise<void> {
  if (!p.player) return;

  const candidates = await db.select().from(poles)
    .where(and(eq(poles.serverId, ev.serverId), eq(poles.map, map)));

  let best: { id: number; d: number } | null = null;
  for (const c of candidates) {
    const dx = Number(c.x) - p.player.x;
    const dz = Number(c.z) - p.player.z;
    const d = Math.hypot(dx, dz);
    if (d <= NEAREST_POLE_RADIUS_M && (!best || d < best.d)) best = { id: c.id, d };
  }
  if (!best) return;

  await db.update(poles)
    .set({ foldedAt: ev.occurredAt, flagRaised: false, lastSeenAt: ev.occurredAt })
    .where(eq(poles.id, best.id));
}
