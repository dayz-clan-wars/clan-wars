// apps/bot/src/referral-award.ts
import { and, count, eq, gt, gte, inArray, lt, max } from "drizzle-orm";
import { events, identityLinks, referralQualifications, referralWeeks, referralWeekWinners, servers, type Database, type ReferralWeekDetail } from "@factions/db";
import { REFERRAL_AWARD_KEY, REFERRAL_CLOSE_GRACE_MS, referralWinners, type ReferralWeek } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { readCursor } from "@factions/event-log";
import { grantAwardTx } from "@factions/roster/internal";
import { SESSIONS_CONSUMER } from "./sessions-tick.js";

/**
 * ⚠️ All three, never one (spec §6, the lesson of KotH's `scoringReady`): the grace
 * covers log lag, the "seen past the end" test covers a stalled ingest, and the
 * cursor test covers a bot catching up. Without them a restart after downtime
 * closes a half-ingested week and pays the wrong player, for good.
 */
export async function referralWeekReady(db: Database, week: ReferralWeek, now: Date): Promise<boolean> {
  if (now.getTime() < week.end.getTime() + REFERRAL_CLOSE_GRACE_MS) return false;
  const [past] = await db.select({ id: events.id }).from(events).where(gt(events.occurredAt, week.end)).limit(1);
  if (!past) return false;
  const [last] = await db.select({ id: max(events.id) }).from(events).where(lt(events.occurredAt, week.end));
  return (last?.id ?? 0) <= await readCursor(db, SESSIONS_CONSUMER);
}

export type CloseOutcome =
  | { status: "already" }
  | { status: "skipped-first" }
  | { status: "closed"; winners: string[]; topCount: number; skipped: string[]; failure?: string };

/**
 * The `detail.failure` of the first-ever close. Ops-facing only: `opsAlerted` is
 * preset beside it, so no ops note ever posts it.
 */
export const FIRST_CLOSE_UNPAID = "payout was not enabled during this week";

const reasonFor = (week: ReferralWeek) => `Top referrer, week of ${week.start.toISOString().slice(0, 10)}`;

/**
 * Pay one week, once (spec §6). ONE transaction: the week row, every grant, every
 * DM and every winner row, or none. Lock order referral_weeks → award_grants →
 * clan_notices.
 *
 * ⚠️ The week-row insert is the idempotency guard: no row returned means already
 * paid. A refused grant THROWS so the whole week rolls back and the next tick
 * retries; a prize missing from the catalogue is NOT a refusal, it closes the
 * week with a `failure` for ops, because it would refuse forever.
 *
 * ⚠️ The first-ever close (no `referral_weeks` row at all) pays NOTHING: that week
 * ended before the payout was switched on, and spec §1 excludes retroactive
 * payouts. It is recorded closed and unpaid (`top_count` 0, `opsAlerted` preset so
 * no ops note fires, no grant, no winner, no post), so the first paid week is the
 * one in progress when `REFERRAL_AWARD_TICK` is switched on. The check is inside
 * this transaction, before the week-row insert: two racing closes of the same
 * week both see an empty table, and the insert's conflict still lets one through.
 */
export async function closeReferralWeek(db: Database, week: ReferralWeek, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string }): Promise<CloseOutcome> {
  return db.transaction(async (tx) => {
    const [anyWeek] = await tx.select({ weekStart: referralWeeks.weekStart }).from(referralWeeks).limit(1);
    if (!anyWeek) {
      const first = await tx.insert(referralWeeks).values({
        weekStart: week.start, closedAt: opts.now, topCount: 0,
        detail: { failure: FIRST_CLOSE_UNPAID, opsAlerted: true },
      }).onConflictDoNothing().returning({ weekStart: referralWeeks.weekStart });
      return first.length === 0 ? { status: "already" } as const : { status: "skipped-first" } as const;
    }

    const claimed = await tx.insert(referralWeeks).values({ weekStart: week.start, closedAt: opts.now, topCount: 0 })
      .onConflictDoNothing().returning({ weekStart: referralWeeks.weekStart });
    if (claimed.length === 0) return { status: "already" } as const;

    const counts = (await tx.select({ discordId: referralQualifications.referrerDiscordId, count: count() })
      .from(referralQualifications)
      .where(and(gte(referralQualifications.qualifiedAt, week.start), lt(referralQualifications.qualifiedAt, week.end)))
      .groupBy(referralQualifications.referrerDiscordId))
      .map((r) => ({ discordId: r.discordId, count: Number(r.count) }));
    const links = counts.length === 0 ? [] : await tx.select({ discordId: identityLinks.discordId, dayzId: identityLinks.dayzId })
      .from(identityLinks).where(inArray(identityLinks.discordId, counts.map((c) => c.discordId)));
    const dayzOf = new Map(links.map((l) => [l.discordId, l.dayzId]));
    const { winners, topCount, skipped } = referralWinners(counts, (id) => dayzOf.has(id));

    const detail: ReferralWeekDetail = skipped.length > 0 ? { skipped } : {};
    const setWeek = (v: Partial<typeof referralWeeks.$inferInsert>) => tx.update(referralWeeks).set(v).where(eq(referralWeeks.weekStart, week.start));

    if (winners.length > 0 && !awardsCatalogue()[REFERRAL_AWARD_KEY]) {
      const failure = `award "${REFERRAL_AWARD_KEY}" is no longer in awards.json; grant it by hand with /award grant to ${winners.join(", ")}`;
      await setWeek({ topCount, detail: { ...detail, failure } });
      return { status: "closed", winners: [], topCount, skipped, failure } as const;
    }

    if (winners.length > 0) {
      // ⚠️ `clan_notices.server_id` is NOT NULL: the DM needs a server, as in grantAwardDb.
      const [server] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1);
      if (!server) throw new Error("referral award: no active server");
      for (const discordId of winners) {
        const g = await grantAwardTx(tx, {
          awardKey: REFERRAL_AWARD_KEY, winnerDiscordId: discordId, grantedByDiscordId: opts.grantedByDiscordId,
          reason: reasonFor(week), siteBaseUrl: opts.siteBaseUrl, now: opts.now, serverId: server.id,
        });
        if (!g.ok) throw new Error(`referral award: grant refused (${g.reason})`);
        await tx.insert(referralWeekWinners).values({ weekStart: week.start, discordId, dayzId: dayzOf.get(discordId)!, awardGrantId: g.grantId });
      }
    }
    await setWeek({ topCount, detail });
    return { status: "closed", winners, topCount, skipped } as const;
  });
}
