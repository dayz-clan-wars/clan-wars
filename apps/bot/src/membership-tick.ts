import type { Database } from "@factions/db";
import { factionMembers, membershipHistory } from "@factions/db";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The membership reconciler (spec §11 ⚠️): diffs `faction_members` (full
 * only) against the open rows of `membership_history` and writes only the
 * differences — a new full member opens a span, a missing one closes it at
 * `now`. Runs every tick; never touches faction_members. On its first run
 * it seeds one open span per current full member using the row's joined_at.
 */
export async function membershipTick(db: Database, now: Date): Promise<{ opened: number; closed: number }> {
  return db.transaction(async (tx) => {
    const current = await tx.select({ serverId: factionMembers.serverId, factionId: factionMembers.factionId, dayzId: factionMembers.dayzId, joinedAt: factionMembers.joinedAt })
      .from(factionMembers).where(eq(factionMembers.status, "full"));
    const open = await tx.select({ id: membershipHistory.id, factionId: membershipHistory.factionId, dayzId: membershipHistory.dayzId })
      .from(membershipHistory).where(isNull(membershipHistory.leftAt));
    const key = (f: number, d: string) => `${f}:${d}`;
    const openKeys = new Set(open.map((o) => key(o.factionId, o.dayzId)));
    const currentKeys = new Set(current.map((c) => key(c.factionId, c.dayzId)));
    const [seededRow] = await tx.select({ seeded: sql<number>`count(*)::int` }).from(membershipHistory);
    const firstRun = seededRow!.seeded === 0;
    let opened = 0, closed = 0;
    for (const c of current) {
      if (openKeys.has(key(c.factionId, c.dayzId))) continue;
      await tx.insert(membershipHistory).values({ serverId: c.serverId, factionId: c.factionId, dayzId: c.dayzId, joinedAt: firstRun ? c.joinedAt : now });
      opened++;
    }
    for (const o of open) {
      if (currentKeys.has(key(o.factionId, o.dayzId))) continue;
      await tx.update(membershipHistory).set({ leftAt: now }).where(eq(membershipHistory.id, o.id));
      closed++;
    }
    return { opened, closed };
  });
}

/** The clan `dayzId` was a full member of at `at`, from the history spans. */
export async function membershipAt(db: Database | Tx, serverId: number, dayzId: string, at: Date): Promise<number | null> {
  const [row] = await db.select({ factionId: membershipHistory.factionId }).from(membershipHistory)
    .where(and(eq(membershipHistory.serverId, serverId), eq(membershipHistory.dayzId, dayzId), lte(membershipHistory.joinedAt, at), or(isNull(membershipHistory.leftAt), gt(membershipHistory.leftAt, at))))
    .limit(1);
  return row?.factionId ?? null;
}
