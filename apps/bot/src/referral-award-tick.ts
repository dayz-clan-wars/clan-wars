// apps/bot/src/referral-award-tick.ts
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { players, referralWeeks, referralWeekWinners, type Database } from "@factions/db";
import { previousReferralWeek } from "@factions/domain";
import { qualifyReferralsDb } from "@factions/roster/internal";
import { closeReferralWeek, referralWeekReady } from "./referral-award.js";
import { referralWinnersText } from "./referral-award-text.js";

export type ReferralPosters = { announce: (c: string) => Promise<void>; ops: (c: string) => Promise<void> };

/**
 * Referral qualification and the weekly plate carrier (spec 2026-09-27-referral-leaderboard §6).
 *
 * 1. Qualify: always, so the boards fill before the prize is on.
 * 2. Close the most recently ended week: only when `payout`, and only once ready.
 *    ⚠️ Never an older week: turning this on, or a long outage, pays no backlog.
 * 3. Announce any closed week with winners and no `announced_at`. Post, THEN stamp.
 * 4. Ops notes for skipped referrers or a missing prize, once each.
 *
 * Each step has its own try/catch: a failing step must not starve the others.
 * ⚠️ Except that a failed qualify SKIPS the close (not the announce or ops steps):
 * a close on stale qualifications records the week without its late qualifiers,
 * and the week-row guard then makes that underpayment permanent.
 */
export async function referralAwardTick(
  db: Database, posters: ReferralPosters,
  opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string; payout: boolean },
): Promise<{ qualified: number; closed: number; posted: number }> {
  const out = { qualified: 0, closed: 0, posted: 0 };
  let qualifiedOk = false;
  try {
    out.qualified = await qualifyReferralsDb(db, opts.now);
    qualifiedOk = true;
  } catch (err) {
    console.error("referrals: qualification failed; retrying next tick, and not closing a week this tick", err);
  }
  if (!opts.payout) return out;

  if (qualifiedOk) {
    try {
      const week = previousReferralWeek(opts.now);
      if (await referralWeekReady(db, week, opts.now)) {
        const r = await closeReferralWeek(db, week, opts);
        if (r.status === "closed") out.closed = 1;
      }
    } catch (err) {
      console.error("referrals: closing the week failed; retrying next tick", err);
    }
  }

  const weeks = await db.select().from(referralWeeks).where(gt(referralWeeks.topCount, 0));
  for (const w of weeks) {
    try {
      if (w.announcedAt === null) {
        const winners = await db.select({ gamertag: players.gamertag, dayzId: referralWeekWinners.dayzId })
          .from(referralWeekWinners)
          .leftJoin(players, eq(players.dayzId, referralWeekWinners.dayzId))
          .where(eq(referralWeekWinners.weekStart, w.weekStart))
          .orderBy(asc(referralWeekWinners.discordId));
        if (winners.length > 0) {
          try {
            await posters.announce(referralWinnersText(winners.map((x) => x.gamertag ?? x.dayzId), w.topCount));
          } catch (err) {
            console.warn("referrals: winners post failed; retrying next tick", err);
            continue;
          }
          await db.update(referralWeeks).set({ announcedAt: opts.now }).where(and(eq(referralWeeks.weekStart, w.weekStart), isNull(referralWeeks.announcedAt)));
          out.posted += 1;
        }
      }
    } catch (err) {
      console.error(`referrals: announcing week ${w.weekStart.toISOString()} failed`, err);
    }
  }

  // Ops: any closed week (winners or not) with something to say, once.
  const all = await db.select().from(referralWeeks);
  for (const w of all) {
    const d = w.detail;
    if (d.opsAlerted || (!d.failure && !(d.skipped && d.skipped.length > 0))) continue;
    const day = w.weekStart.toISOString().slice(0, 10);
    const lines = [
      ...(d.skipped && d.skipped.length > 0 ? [`skipped unlinked top referrer(s) ${d.skipped.join(", ")}`] : []),
      ...(d.failure ? [d.failure] : []),
    ];
    try {
      await posters.ops(`⚠️ Referral week of ${day}: ${lines.join("; ")}`);
      await db.update(referralWeeks).set({ detail: { ...d, opsAlerted: true } }).where(eq(referralWeeks.weekStart, w.weekStart));
    } catch (err) {
      console.warn("referrals: ops note failed; retrying next tick", err);
    }
  }
  return out;
}
