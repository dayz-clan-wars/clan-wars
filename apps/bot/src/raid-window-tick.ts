import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { raidWindowAnnouncements, raidWindowFlips, raidWindowSkips, type Database } from "@factions/db";
import { raidWindowAt } from "@factions/domain";
import { advanceText, closeText, failureText, openText } from "./raid-window-text.js";

export type RaidPoster = (content: string) => Promise<void>;
export type RaidPosters = { announce: RaidPoster; ops: RaidPoster };
export type RaidWindowTickResult = { posted: number; skipped: number };

/** How far ahead of the open the advance notice goes out. */
const ADVANCE_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the failure scan looks. Two weeks — comfortably more than the four
 * boundaries a week, so a real failure is still alerted after a weekend of bot
 * downtime.
 *
 * ⚠️ An older failure is deliberately NOT resurrected. A `refused`/`failed` row
 * that was never alerted (OPS_CHANNEL_ID set only later, say) would otherwise post
 * its first alert now, about a weekend long past — an alert nobody can act on, that
 * arrives looking like a live incident. Unbounded, the scan also grew a row and a
 * lookup per failed boundary forever, on every tick.
 */
const FAILURE_SCAN_MS = 14 * 24 * 60 * 60 * 1000;

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
  } catch (err) {
    // No row: the next tick retries. A single stuck poster must not stop the rest
    // of this tick's work — the same reasoning notice-tick.ts gives for a per-target
    // failure never blocking a different target.
    // ⚠️ Logged, because retrying forever in silence is indistinguishable from
    // having nothing to say: a permanently broken poster (a deleted channel, a
    // revoked permission) would otherwise never surface anywhere.
    console.warn(`raid window: ${kind} message for ${boundaryAt.toISOString()} failed to post — retrying next tick`, err);
    return false;
  }
  await db.insert(raidWindowAnnouncements)
    .values({ boundaryAt, kind, announcedAt: now, outcome: "posted" })
    .onConflictDoNothing();
  return true;
}

/**
 * Has any server confirmed a flip at this boundary — uploaded AND restarted?
 *
 * ⚠️ ANY server, not a named one. Known limitation, accepted because there is one
 * registered server and one host: with two, a single confirmed flip would make the
 * announcement speak for both, and the second server's failed flip would be
 * announced as a success. Scope this per server before a second one is registered.
 */
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
    // ⚠️ state.boundaryAt, not state.opensAt — they are equal by construction while
    // the window is open, but every other consumer keys on boundaryAt and this branch
    // has already paid once for an independently-derived-but-currently-equal instant.
    if (await confirmed(db, state.boundaryAt)) {
      if (await postOnce(db, posters.announce, state.boundaryAt, "open", openText(state), opts.now)) out.posted++;
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
  }).from(raidWindowFlips).where(and(
    inArray(raidWindowFlips.outcome, ["refused", "failed"]),
    gte(raidWindowFlips.boundaryAt, new Date(opts.now.getTime() - FAILURE_SCAN_MS)),
  ));

  for (const b of broken) {
    const err = String(b.detail?.error ?? "unknown");
    if (await postOnce(db, posters.ops, b.boundaryAt, "failure",
        failureText(b.boundaryAt, b.wantedDisabled, err), opts.now)) {
      out.posted++;
    }
  }

  return out;
}
