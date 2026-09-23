import { BOUNTY_EXPIRY_SETTLE_MS } from "./rules";

/**
 * Bounties (spec 2026-09-23-bounties). The claim/expiry decision, pure, so the
 * ordering rule (§2.8) is tested without a database.
 *
 * ⚠️ Mirrored by `bounties_status_valid` in SQL; `packages/db/test/bounties-schema.test.ts`
 * holds the two together.
 */
export const BOUNTY_STATUSES = ["open", "claimed", "expired", "revoked"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

/** One `player_sessions` row: connect to disconnect, `to = null` while still connected. */
export type SessionSpan = { from: Date; to: Date | null };

/** Spans clipped to [start, until], sorted, overlaps merged away — so nothing is counted twice. */
function clipped(spans: SessionSpan[], start: Date, until: Date): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const sorted = [...spans].sort((a, b) => a.from.getTime() - b.from.getTime());
  let floor = start.getTime();
  for (const s of sorted) {
    const from = Math.max(s.from.getTime(), floor);
    const to = Math.min(s.to?.getTime() ?? until.getTime(), until.getTime());
    if (to <= from) continue;
    out.push({ from, to });
    floor = to;
  }
  return out;
}

/** Time connected inside [start, until]. An open session runs to `until`. */
export function onlineMs(spans: SessionSpan[], start: Date, until: Date): number {
  return clipped(spans, start, until).reduce((sum, s) => sum + (s.to - s.from), 0);
}

/** The instant the online budget was used up, or null while some remains. */
export function budgetRunOutAt(spans: SessionSpan[], start: Date, budgetMs: number, until: Date): Date | null {
  let used = 0;
  for (const s of clipped(spans, start, until)) {
    const len = s.to - s.from;
    if (used + len >= budgetMs) return new Date(s.from + (budgetMs - used));
    used += len;
  }
  return null;
}

export type BountyOutcome = { kind: "open" } | { kind: "claimed" } | { kind: "expired"; endAt: Date };

/**
 * What an open bounty should become now.
 *
 * `firstKillAt` is the earliest scoring kill of the target at or after `placedAt`
 * (the caller's query). The bounty ends at the earlier of the budget running out and
 * the deadline.
 *
 * ⚠️ A kill BEFORE the end claims, however late it is seen — log lag must not rob a
 * hunter (§2.8). And expiry waits `BOUNTY_EXPIRY_SETTLE_MS` past the end, because a
 * kill made in time may not have been ingested yet. Checking expiry first, or
 * expiring at the end exactly, are the two ways to get this wrong.
 */
export function bountyOutcome(
  b: { placedAt: Date; onlineBudgetMs: number; deadlineAt: Date },
  spans: SessionSpan[],
  firstKillAt: Date | null,
  now: Date,
): BountyOutcome {
  const runOut = budgetRunOutAt(spans, b.placedAt, b.onlineBudgetMs, now);
  const endAt = runOut && runOut < b.deadlineAt ? runOut : b.deadlineAt;
  if (firstKillAt && firstKillAt < endAt) return { kind: "claimed" };
  if (now.getTime() >= endAt.getTime() + BOUNTY_EXPIRY_SETTLE_MS) return { kind: "expired", endAt };
  return { kind: "open" };
}
