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

/**
 * What applying one event did. `unboundFold` marks a `flagpole.folded` event
 * that could not be attached to a known pole — either the line carried no
 * parseable player position, or no pole sat within NEAREST_POLE_RADIUS_M.
 *
 * ⚠️ These used to be bare `return`s. The cursor advances past them either way,
 * so an unbound fold left no trace at all — and pole loss is one of only two
 * consequential signals the ADM log provides (it drives dormancy and rebind in
 * the next plan). Count them and surface the total.
 */
export type ApplyOutcome = { unboundFold: boolean };

const APPLIED: ApplyOutcome = { unboundFold: false };
const UNBOUND_FOLD: ApplyOutcome = { unboundFold: true };

export async function applyEvent(db: Database, map: string, ev: EventRow): Promise<ApplyOutcome> {
  if (ev.type === "flag.raised" || ev.type === "flag.lowered") {
    await applyFlagChange(db, map, ev, ev.payload as FlagPayload);
    return APPLIED;
  }
  if (ev.type === "flagpole.folded") {
    return applyFold(db, map, ev, ev.payload as FlagPolePayload);
  }
  // placed/built/dismantled and player.position carry no pole identity and are not
  // projected here. Later plans consume them from the event log directly.
  return APPLIED;
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
    // foldedAt MUST be cleared here. A pole folded on Monday and rebuilt at the
    // same 1cm key on Tuesday would otherwise keep its stale folded_at while
    // flag_raised flipped true — and the next plan's dormancy logic keys on
    // exactly this column.
    set: {
      currentTexture: p.texture,
      flagRaised: raised,
      lastSeenAt: ev.occurredAt,
      foldedAt: null,
    },
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

async function applyFold(db: Database, map: string, ev: EventRow, p: FlagPolePayload): Promise<ApplyOutcome> {
  if (!p.player) return UNBOUND_FOLD;

  const candidates = await db.select().from(poles)
    .where(and(eq(poles.serverId, ev.serverId), eq(poles.map, map)));

  let best: { id: number; d: number } | null = null;
  for (const c of candidates) {
    const dx = Number(c.x) - p.player.x;
    const dz = Number(c.z) - p.player.z;
    const d = Math.hypot(dx, dz);
    if (d <= NEAREST_POLE_RADIUS_M && (!best || d < best.d)) best = { id: c.id, d };
  }
  if (!best) return UNBOUND_FOLD;

  await db.update(poles)
    .set({ foldedAt: ev.occurredAt, flagRaised: false, lastSeenAt: ev.occurredAt })
    .where(eq(poles.id, best.id));

  return APPLIED;
}
