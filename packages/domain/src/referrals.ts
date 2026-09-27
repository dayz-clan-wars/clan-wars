import { REFERRAL_QUALIFY_MS, REFERRAL_WEEK_START_HOUR_UTC } from "./rules";
import { mondayMidnightUtc } from "./restarts";

/**
 * Referral weeks and qualification (spec 2026-09-27-referral-leaderboard).
 * Pure: no clock, no I/O.
 */

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Half-open `[start, end)`. */
export type ReferralWeek = { start: Date; end: Date };

/** The week containing `at`. ⚠️ Derived from the calendar, never stored, like the vehicle rotation. */
export function referralWeekFor(at: Date): ReferralWeek {
  let start = mondayMidnightUtc(at) + REFERRAL_WEEK_START_HOUR_UTC * HOUR_MS;
  // Monday before 10:00 still belongs to the previous week.
  if (start > at.getTime()) start -= WEEK_MS;
  return { start: new Date(start), end: new Date(start + WEEK_MS) };
}

/** The most recently ENDED week at `now`: the only one the payout ever considers (no backlog). */
export function previousReferralWeek(now: Date): ReferralWeek {
  const current = referralWeekFor(now);
  return { start: new Date(current.start.getTime() - WEEK_MS), end: current.start };
}

export type SessionSpan = { connectedAt: Date; disconnectedAt: Date | null };

/**
 * When a referral qualifies: the later of the referral instant and the instant
 * the player's cumulative play reached `needMs`. Null while it has not.
 *
 * An open session counts up to `now`. Sessions are summed in connect order;
 * a span that ends at or before it starts contributes nothing.
 */
export function qualifiedAt(sessions: SessionSpan[], referredAt: Date, now: Date, needMs = REFERRAL_QUALIFY_MS): Date | null {
  const sorted = [...sessions].sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());
  let played = 0;
  for (const s of sorted) {
    const start = s.connectedAt.getTime();
    const end = Math.min((s.disconnectedAt ?? now).getTime(), now.getTime());
    if (end <= start) continue;
    if (played + (end - start) >= needMs) {
      const reached = start + (needMs - played);
      return new Date(Math.max(reached, referredAt.getTime()));
    }
    played += end - start;
  }
  return null;
}

export type ReferrerCount = { discordId: string; count: number };

/**
 * The week's winners: every LINKED referrer tied at the highest count, if that
 * count is at least 1. An unlinked referrer cannot place an award, so they are
 * dropped before ranking; `skipped` lists the ones that would have won or tied,
 * for the ops note.
 */
export function referralWinners(counts: ReferrerCount[], isLinked: (discordId: string) => boolean): { winners: string[]; topCount: number; skipped: string[] } {
  const byId = (a: ReferrerCount, b: ReferrerCount) => (a.discordId < b.discordId ? -1 : a.discordId > b.discordId ? 1 : 0);
  const eligible = counts.filter((c) => c.count > 0 && isLinked(c.discordId));
  const topCount = eligible.reduce((m, c) => Math.max(m, c.count), 0);
  const winners = eligible.filter((c) => c.count === topCount && topCount > 0).sort(byId).map((c) => c.discordId);
  const skipped = counts.filter((c) => c.count > 0 && !isLinked(c.discordId) && c.count >= topCount).sort(byId).map((c) => c.discordId);
  return { winners, topCount, skipped };
}
