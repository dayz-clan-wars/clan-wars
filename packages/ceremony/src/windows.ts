/** A `flag.raised` that already passed every qualification check. */
export type QualifyingRaise = {
  eventId: number;
  dayzId: string;
  gamertag: string;
  occurredAt: Date;
};

export type SettledWindow = {
  start: Date;
  /** Exclusive. A raise at exactly `end` anchors the NEXT window. */
  end: Date;
  raises: QualifyingRaise[];
  /** Distinct UIDs, in first-seen order. */
  participants: string[];
};

export const CEREMONY_WINDOW_MS = 600_000;
export const MIN_PARTICIPANTS = 3;

/**
 * Group raises into settled, non-overlapping windows.
 *
 * ⚠️ `highWater` is the newest INGESTED event time, not `Date.now()`. A window
 * is only settled once the log itself has advanced past its end. Using the
 * wall clock instead closes windows before their own events have been
 * ingested — the ingest worker is a one-shot batch nothing schedules — and
 * drops every late participant, silently. It also makes a backfill and a live
 * ceremony take different paths, which would render the fixtures meaningless.
 *
 * Windows anchor at the oldest unconsumed raise and do not slide: a slow
 * trickle of raises at a busy pole must not accumulate into a ceremony nobody
 * performed.
 */
export function settleWindows(
  raises: QualifyingRaise[],
  highWater: Date,
  windowMs: number = CEREMONY_WINDOW_MS,
): SettledWindow[] {
  // Total order. ADM timestamps have second granularity, so ties are ordinary;
  // without the id tiebreak, window anchoring would be nondeterministic.
  const sorted = [...raises].sort((a, b) =>
    a.occurredAt.getTime() - b.occurredAt.getTime() || a.eventId - b.eventId);

  const out: SettledWindow[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!.occurredAt;
    const end = new Date(start.getTime() + windowMs);
    if (highWater.getTime() < end.getTime()) break;

    const group: QualifyingRaise[] = [];
    while (i < sorted.length && sorted[i]!.occurredAt.getTime() < end.getTime()) {
      group.push(sorted[i]!);
      i++;
    }

    const seen = new Set<string>();
    const participants: string[] = [];
    for (const r of group) {
      if (seen.has(r.dayzId)) continue;
      seen.add(r.dayzId);
      participants.push(r.dayzId);
    }
    out.push({ start, end, raises: group, participants });
  }
  return out;
}

export function qualifies(w: SettledWindow, min: number = MIN_PARTICIPANTS): boolean {
  return w.participants.length >= min;
}
