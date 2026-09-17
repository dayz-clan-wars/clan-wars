import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { raidWindowAnnouncements, raidWindowFlips, raidWindowSkips, type Database } from "@factions/db";
import { raidWindowAt } from "@factions/domain";
import { advanceText, closeText, failureText, openText } from "./raid-window-text.js";

export type RaidPoster = (content: string) => Promise<void>;
export type RaidPosters = { announce: RaidPoster; ops: RaidPoster };
export type RaidWindowTickResult = { posted: number; skipped: number };

/** How far ahead of the open the advance notice goes out. */
const ADVANCE_LEAD_MS = 24 * 60 * 60 * 1000;

async function alreadyPosted(db: Database, boundaryAt: Date, kind: string): Promise<boolean> {
  const [row] = await db.select({ kind: raidWindowAnnouncements.kind })
    .from(raidWindowAnnouncements)
    .where(and(eq(raidWindowAnnouncements.boundaryAt, boundaryAt), eq(raidWindowAnnouncements.kind, kind as never)))
    .limit(1);
  return Boolean(row);
}

/**
 * ⚠️ POST first, row second — the house rule from every poster here. A row written
 * first records an announcement that never went out if the post then fails; the
 * reverse costs at most a duplicate message after a crash between the two, which is
 * the direction this repo chooses everywhere (see notice-tick.ts, announce-tick.ts).
 */
async function postOnce(
  db: Database, post: RaidPoster, boundaryAt: Date,
  kind: "advance" | "open" | "close" | "failure", body: string, now: Date,
): Promise<boolean> {
  if (await alreadyPosted(db, boundaryAt, kind)) return false;
  try {
    await post(body);
  } catch {
    // No row: the next tick retries. A single stuck poster must not stop the rest
    // of this tick's work — the same reasoning notice-tick.ts gives for a per-target
    // failure never blocking a different target.
    return false;
  }
  await db.insert(raidWindowAnnouncements)
    .values({ boundaryAt, kind, announcedAt: now, outcome: "posted" })
    .onConflictDoNothing();
  return true;
}

/** Has any server confirmed a flip at this boundary — uploaded AND restarted? */
async function confirmed(db: Database, boundaryAt: Date): Promise<boolean> {
  const [row] = await db.select({ serverId: raidWindowFlips.serverId })
    .from(raidWindowFlips)
    .where(and(
      eq(raidWindowFlips.boundaryAt, boundaryAt),
      eq(raidWindowFlips.outcome, "applied"),
      isNotNull(raidWindowFlips.restartConfirmedAt),
    ))
    .limit(1);
  return Boolean(row);
}

export async function raidWindowTick(
  db: Database,
  posters: RaidPosters,
  opts: { now: Date },
): Promise<RaidWindowTickResult> {
  const out: RaidWindowTickResult = { posted: 0, skipped: 0 };
  const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
    .from(raidWindowSkips);
  const state = raidWindowAt(opts.now, skips);

  // Advance notice: within a day of the open, before it.
  if (state.phase !== "open" && opts.now >= new Date(state.opensAt.getTime() - ADVANCE_LEAD_MS)
      && opts.now < state.opensAt) {
    if (await postOnce(db, posters.announce, state.opensAt, "advance", advanceText(state), opts.now)) out.posted++;
  }

  // ⚠️ open/close are gated on a CONFIRMED flip, never on the clock. Announcing at
  // the boundary and flipping separately makes the message a prediction; this makes
  // it evidence. A failed flip must never produce "base damage is on".
  if (state.phase === "open") {
    if (await confirmed(db, state.opensAt)) {
      if (await postOnce(db, posters.announce, state.opensAt, "open", openText(state), opts.now)) out.posted++;
    } else out.skipped++;
  } else if (state.phase === "closed") {
    // ⚠️ state.boundaryAt is the close that already happened — the same field the
    // flip was recorded under. Deriving it here instead is what made the writer and
    // this reader disagree about midweek instants during the pre-flight scan.
    if (await confirmed(db, state.boundaryAt)) {
      if (await postOnce(db, posters.announce, state.boundaryAt, "close", closeText(state), opts.now)) out.posted++;
    } else out.skipped++;
  }

  // ⚠️ The failure alert. Spec §5: one message per boundary, never per slot.
  // The level-triggered tick retries every two hours; without the (boundary, kind)
  // key this would re-alert 12 times a day and bury the alerts the design needs
  // someone to actually read — the same reasoning as the deploy system's
  // notified-marker sidecars.
  const broken = await db.select({
    boundaryAt: raidWindowFlips.boundaryAt,
    wantedDisabled: raidWindowFlips.wantedDisabled,
    detail: raidWindowFlips.detail,
  }).from(raidWindowFlips).where(inArray(raidWindowFlips.outcome, ["refused", "failed"]));

  for (const b of broken) {
    const err = String(b.detail?.error ?? "unknown");
    if (await postOnce(db, posters.ops, b.boundaryAt, "failure",
        failureText(b.boundaryAt, b.wantedDisabled, err), opts.now)) {
      out.posted++;
    }
  }

  return out;
}
