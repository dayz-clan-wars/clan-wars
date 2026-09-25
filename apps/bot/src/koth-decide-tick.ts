import { kothEvents, kothVotes, servers, type Database } from "@factions/db";
import {
  KOTH_HISTORY_MS, chooseKothTown, decisionInstantFor, highWater, isoWeekStart, kothLocation, nextRestartAt, shouldFireKoth,
} from "@factions/domain";
import { and, eq, gt, gte, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { scheduledText } from "./koth-text.js";
import { historyInstants, onlineNow, popsAt } from "./population.js";
import { kothOpen, lastKothSlot, recentTowns, slotTakenBy } from "./koth-vote-store.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The automatic KotH decision (spec 2026-09-24 §3).
 *
 * ⚠️ Runs BEFORE airdropTick in discord.ts (tick-order.test.ts): on a record night
 * both want the slot, and airdropTick yields to a scheduled KotH row — but only
 * if the row already exists when it looks.
 *
 * ⚠️ Row FIRST, post second — airdrop-tick's order, for its reason: posting first
 * and crashing leaves an event players were told about that nothing opens. An
 * unannounced row is harmless: `kothWanted` refuses it and koth-tick fails it.
 */
export async function kothDecideTick(
  db: Database, post: (c: string) => Promise<void>,
  opts: { now: Date; weeklyCap: number; minPop: number; rng?: () => number },
): Promise<{ decided: number; posted: number }> {
  const out = { decided: 0, posted: 0 };
  const rng = opts.rng ?? Math.random;
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
  for (const s of targets) {
    try {
      // 1. Retry an automatic row nobody has been told about, while its slot is ahead.
      const pending = await db.select().from(kothEvents).where(and(
        eq(kothEvents.serverId, s.id), eq(kothEvents.origin, "auto"), eq(kothEvents.state, "scheduled"),
        isNull(kothEvents.announcedAt), gt(kothEvents.slotAt, opts.now),
      ));
      for (const row of pending) out.posted += await announce(db, post, row.id, row.location, row.slotAt, opts.now);
      if (pending.length > 0) continue;

      // 2. A new decision.
      const slot = nextRestartAt(opts.now);
      if (opts.now < decisionInstantFor(slot)) continue;
      const weekStart = isoWeekStart(slot);
      const [week, votes] = await Promise.all([
        db.select({ id: kothEvents.id }).from(kothEvents).where(and(
          eq(kothEvents.serverId, s.id), eq(kothEvents.origin, "auto"), notInArray(kothEvents.state, ["cancelled", "failed"]),
          gte(kothEvents.slotAt, weekStart), lt(kothEvents.slotAt, new Date(weekStart.getTime() + WEEK_MS)),
        )),
        db.select({ id: kothVotes.id }).from(kothVotes).where(and(
          eq(kothVotes.serverId, s.id), eq(kothVotes.slotAt, slot), inArray(kothVotes.state, ["open", "failed"]),
        )),
      ]);
      const pop = await onlineNow(db, s.id, opts.now);
      const threshold = highWater(await popsAt(db, s.id, historyInstants(decisionInstantFor(slot), KOTH_HISTORY_MS)));
      if (!shouldFireKoth({
        slot, slotTaken: (await slotTakenBy(db, s.id, slot)) !== null, voteBlocks: votes.length > 0,
        openEvent: await kothOpen(db, s.id), weekCount: week.length, weeklyCap: opts.weeklyCap,
        lastSlotAt: await lastKothSlot(db, s.id, slot), pop, threshold, minPop: opts.minPop,
      })) continue;

      const town = chooseKothTown(await recentTowns(db, s.id), rng);
      // ⚠️ onConflictDoNothing: a /koth schedule racing this slot owns it if it got
      // there first — counting and posting regardless would announce the wrong town.
      const [row] = await db.insert(kothEvents).values({
        serverId: s.id, slotAt: slot, location: town.slug, centreX: String(town.centreX), centreZ: String(town.centreZ),
        state: "scheduled", origin: "auto", scheduledByDiscordId: null, awardKey: null,
        popAtDecision: pop, threshold: String(threshold),
      }).onConflictDoNothing().returning({ id: kothEvents.id });
      if (!row) continue;
      out.decided += 1;
      console.log(`koth: server ${s.id} decided ${town.slug} for ${slot.toISOString()} (pop ${pop}, threshold ${threshold})`);
      out.posted += await announce(db, post, row.id, town.slug, slot, opts.now);
    } catch (err) {
      console.error(`koth: server ${s.id} automatic decision failed`, err);
    }
  }
  return out;
}

/**
 * ⚠️ `reminded_at` is stamped WITH `announced_at`: the decision is made at the
 * reminder instant, so this post is the reminder. Without it koth-tick posts a
 * second message seconds later.
 */
async function announce(db: Database, post: (c: string) => Promise<void>, id: number, slug: string, slot: Date, now: Date): Promise<number> {
  try {
    await post(scheduledText(kothLocation(slug)?.name ?? slug, slot, null));
  } catch (err) {
    console.warn(`koth: automatic announcement for ${slot.toISOString()} failed to post — retrying next tick`, err);
    return 0;
  }
  await db.update(kothEvents).set({ announcedAt: now, remindedAt: now }).where(eq(kothEvents.id, id));
  return 1;
}
