import { ACHIEVEMENT_BY_KEY } from "@factions/domain";
import { achievementCounters, type Database } from "@factions/db";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A 1 km square as one integer.
 *
 * ⚠️ Deliberately lossy: the counter must never be able to give a position
 * back. `achievement_counters_no_coordinates` bans an `x`/`z` key in `detail`,
 * and this is why the stored square INDICES are safe beside it — 5050,7020 and
 * 5999,7999 collapse to the same number, so nothing here locates a base.
 */
export const gridSquare = (x: number, z: number): number => Math.floor(x / 1000) * 1000 + Math.floor(z / 1000);

async function readCounter(tx: Tx, ownerId: string, key: string) {
  const [c] = await tx.select().from(achievementCounters)
    .where(and(eq(achievementCounters.ownerKind, "player"), eq(achievementCounters.ownerId, ownerId), eq(achievementCounters.key, key)));
  return c;
}

async function writeCounter(tx: Tx, ownerId: string, key: string, value: number, detail: Record<string, unknown>) {
  const updatedAt = new Date();
  await tx.insert(achievementCounters).values({ ownerKind: "player", ownerId, key, value, detail, updatedAt })
    .onConflictDoUpdate({
      target: [achievementCounters.ownerKind, achievementCounters.ownerId, achievementCounters.key],
      set: { value, detail, updatedAt },
    });
}

/** Group rows by player, preserving the caller's (time-ordered) order within each player. */
function byPlayer<T extends { dayzId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.dayzId);
    if (list) list.push(r);
    else out.set(r.dayzId, [r]);
  }
  return out;
}

/**
 * New position fixes, in time order. Squares are added to each player's set;
 * the fix that made it 50 is `crossedAt`.
 *
 * ⚠️ `crossedAt` is set once and never moved: it is the `earnedAt` the rule
 * reports, and an unlock must be dated to the evidence, not to the last pass
 * that happened to touch the counter.
 */
export async function applyPositionCounters(tx: Tx, rows: readonly { dayzId: string; x: number; z: number; at: Date }[]): Promise<void> {
  const target = ACHIEVEMENT_BY_KEY.explorer.target;
  for (const [dayzId, fixes] of byPlayer(rows)) {
    const c = await readCounter(tx, dayzId, "explorer");
    const squares = new Set<number>((c?.detail.squares as number[] | undefined) ?? []);
    let crossedAt = c?.detail.crossedAt as string | undefined;
    for (const f of fixes) {
      squares.add(gridSquare(f.x, f.z));
      if (!crossedAt && squares.size >= target) crossedAt = f.at.toISOString();
    }
    await writeCounter(tx, dayzId, "explorer", squares.size, { squares: [...squares].sort((a, b) => a - b), ...(crossedAt ? { crossedAt } : {}) });
  }
}

/**
 * New pins, in id order. Deleting a pin later does not un-drop it — which is the whole
 * reason this counter exists rather than a `count(*)` over `clan_pins` (they are deleted
 * by players and expire on their own).
 *
 * ⚠️ Idempotent BY CONSTRUCTION, via `lastPinId`: the tick re-reads the same head of
 * `clan_pins` on every pass of a capped drain (the watermarks are held back), so a
 * counter that simply added `rows.length` would inflate cartographer by a batch per
 * pass and stamp `crossedAt` on the wrong pin. Explorer needs no such guard — a set of
 * squares absorbs a replay on its own.
 */
export async function applyPinCounters(tx: Tx, rows: readonly { id: number; dayzId: string; at: Date }[]): Promise<void> {
  const target = ACHIEVEMENT_BY_KEY.cartographer.target;
  for (const [dayzId, pins] of byPlayer(rows)) {
    const c = await readCounter(tx, dayzId, "cartographer");
    let value = c?.value ?? 0;
    let lastPinId = Number(c?.detail.lastPinId ?? 0);
    let crossedAt = c?.detail.crossedAt as string | undefined;
    for (const p of [...pins].sort((a, b) => a.id - b.id)) {
      if (p.id <= lastPinId) continue;
      value += 1;
      lastPinId = p.id;
      if (!crossedAt && value >= target) crossedAt = p.at.toISOString();
    }
    await writeCounter(tx, dayzId, "cartographer", value, { lastPinId, ...(crossedAt ? { crossedAt } : {}) });
  }
}
