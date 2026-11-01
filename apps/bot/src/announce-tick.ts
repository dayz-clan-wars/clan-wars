import { eq } from "drizzle-orm";
import { vehicleWipeAnnouncements, type Database } from "@factions/db";
import { wipeMondayFor, nextWeeklyWipeAt, announceAtFor, weeklyWipeVehicle, FIXED_WEEKLY_WIPES, ANNOUNCE_CUTOFF_MS, type WipeVehicle } from "@factions/domain";
import { weeklyWipeAnnouncement } from "./announce-text.js";

export type AnnouncePoster = (content: string) => Promise<void>;
export type AnnounceTickResult = { posted: number; missed: number; failed: number };

/**
 * Announce each coming vehicle wipe, once, a day ahead: the Monday rotation and
 * every fixed weekly wipe.
 *
 * ⚠️ POST first, row second — the house rule from every poster here. A row written
 * first records an announcement that never went out if the post then fails; the reverse
 * costs at most a duplicate message after a crash between the two, which is the
 * direction this repo chooses everywhere (see notice-tick.ts).
 */
export async function announceTick(
  db: Database,
  post: AnnouncePoster,
  opts: { now: Date; offHour: number; onError?: (err: unknown, wipeAt: Date) => void },
): Promise<AnnounceTickResult> {
  const out: AnnounceTickResult = { posted: 0, missed: 0, failed: 0 };

  const monday = wipeMondayFor(opts.now, opts.offHour);
  const wipes: { wipeAt: Date; vehicle: WipeVehicle }[] = [
    { wipeAt: monday, vehicle: weeklyWipeVehicle(monday) },
    ...FIXED_WEEKLY_WIPES.map((w) => ({ wipeAt: nextWeeklyWipeAt(opts.now, w.utcDay, opts.offHour), vehicle: w })),
  ];
  for (const { wipeAt, vehicle } of wipes) await announceOne(db, post, opts, wipeAt, vehicle, out);
  return out;
}

async function announceOne(
  db: Database,
  post: AnnouncePoster,
  opts: { now: Date; onError?: (err: unknown, wipeAt: Date) => void },
  wipeAt: Date,
  vehicle: WipeVehicle,
  out: AnnounceTickResult,
): Promise<void> {
  if (opts.now < announceAtFor(wipeAt)) return; // too early — nothing to do yet

  const [handled] = await db.select({ wipeAt: vehicleWipeAnnouncements.wipeAt })
    .from(vehicleWipeAnnouncements).where(eq(vehicleWipeAnnouncements.wipeAt, wipeAt)).limit(1);
  if (handled) return;

  // ⚠️ Past the cutoff the notice would describe a wipe that is effectively already
  // here. Record it so the next tick does not keep trying, and stay silent.
  if (opts.now.getTime() >= wipeAt.getTime() - ANNOUNCE_CUTOFF_MS) {
    await db.insert(vehicleWipeAnnouncements)
      .values({ wipeAt, announcedAt: opts.now, eventName: vehicle.event, outcome: "missed" })
      .onConflictDoNothing();
    out.missed++;
    return;
  }

  try {
    await post(weeklyWipeAnnouncement(vehicle, wipeAt));
  } catch (err) {
    // No row: the next tick retries until the cutoff closes the window.
    opts.onError?.(err, wipeAt);
    out.failed++;
    return;
  }

  await db.insert(vehicleWipeAnnouncements)
    .values({ wipeAt, announcedAt: opts.now, eventName: vehicle.event, outcome: "posted" })
    .onConflictDoNothing();
  out.posted++;
}
