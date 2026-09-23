import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { bounties, kills, players, type Database } from "@factions/db";
import { bountyPostText, type BountyPost } from "./bounty-text.js";

const HOUR = 3_600_000;
const BATCH = 20;

/**
 * Announce bounty state changes to #server-events. Level-triggered: whatever has a
 * null `*_announced_at` gets posted, oldest first. The same post-then-mark shape as
 * `banAnnounceTick` (see its comment and feed-tick.ts), and for the same reasons:
 * at-least-once, and the first failure ENDS the run so the channel's order holds.
 *
 * ⚠️ All "placed" posts go before any "closed" post, and a closed post needs its
 * placed post already out. So a bounty claimed between two ticks still reads
 * WANTED → collected, never the reverse.
 */
export async function bountyAnnounceTick(
  db: Database,
  post: (content: string) => Promise<void>,
  opts: { now: Date; siteBaseUrl: string; onError?: (id: number, err: unknown) => void },
): Promise<{ posted: number; blockedAt: number | null }> {
  const out = { posted: 0, blockedAt: null as number | null };
  const target = alias(players, "target");
  const killer = alias(players, "killer");

  const placed = await db.select({ b: bounties, target: target.gamertag }).from(bounties)
    .leftJoin(target, eq(target.dayzId, bounties.targetDayzId))
    .where(isNull(bounties.placedAnnouncedAt)).orderBy(asc(bounties.id)).limit(BATCH);
  for (const r of placed) {
    const p: BountyPost = { kind: "placed", target: r.target ?? "someone", reason: r.b.reason, hours: Math.round(r.b.onlineBudgetMs / HOUR) };
    if (!(await send(r.b.id, p, { placedAnnouncedAt: opts.now }))) return out;
  }

  const closed = await db.select({ b: bounties, target: target.gamertag, killer: killer.gamertag, weapon: kills.weapon }).from(bounties)
    .leftJoin(target, eq(target.dayzId, bounties.targetDayzId))
    .leftJoin(killer, eq(killer.dayzId, bounties.claimedByDayzId))
    // The kill may have been rebuilt away (spec §2.7); the post then just drops the weapon.
    .leftJoin(kills, eq(kills.eventId, bounties.claimEventId))
    .where(and(ne(bounties.status, "open"), isNotNull(bounties.placedAnnouncedAt), isNull(bounties.closedAnnouncedAt)))
    .orderBy(asc(bounties.closedAt), asc(bounties.id)).limit(BATCH);
  for (const r of closed) {
    const who = r.target ?? "someone";
    const p: BountyPost = r.b.status === "claimed"
      ? { kind: "claimed", target: who, killer: r.killer ?? "someone", weapon: r.weapon }
      : { kind: r.b.status === "expired" ? "expired" : "revoked", target: who };
    if (!(await send(r.b.id, p, { closedAnnouncedAt: opts.now }))) return out;
  }
  return out;

  async function send(id: number, p: BountyPost, stamp: Partial<typeof bounties.$inferInsert>): Promise<boolean> {
    try {
      await post(bountyPostText(p, opts.siteBaseUrl));
      await db.update(bounties).set(stamp).where(eq(bounties.id, id));
      out.posted++;
      return true;
    } catch (err) {
      opts.onError?.(id, err);
      out.blockedAt = id;
      return false;
    }
  }
}
