import { eq } from "drizzle-orm";
import { vehicleWipeAnnouncements, type Database } from "@factions/db";
import { wipeMondayFor, announceAtFor, weeklyWipeVehicle, ANNOUNCE_CUTOFF_MS } from "@factions/domain";
import { weeklyWipeAnnouncement } from "./announce-text.js";

export type AnnouncePoster = (content: string) => Promise<void>;
export type AnnounceTickResult = { posted: number; missed: number; failed: number };

/**
 * Announce the coming Monday's vehicle wipe, once, a day ahead.
 *
 * ⚠️ POST first, row second — the house rule from every poster here. A row written
 * first records an announcement that never went out if the post then fails; the reverse
 * costs at most a duplicate message after a crash between the two, which is the
 * direction this repo chooses everywhere (see notice-tick.ts).
 */
export async function announceTick(
  db: Database,
  post: AnnouncePoster,
  opts: { now: Date; offHour: number; onError?: (err: unknown) => void },
): Promise<AnnounceTickResult> {
  const out: AnnounceTickResult = { posted: 0, missed: 0, failed: 0 };

  const wipeAt = wipeMondayFor(opts.now, opts.offHour);
  if (opts.now < announceAtFor(wipeAt)) return out; // too early — nothing to do yet

  const [handled] = await db.select({ wipeAt: vehicleWipeAnnouncements.wipeAt })
    .from(vehicleWipeAnnouncements).where(eq(vehicleWipeAnnouncements.wipeAt, wipeAt)).limit(1);
  if (handled) return out;

  const vehicle = weeklyWipeVehicle(wipeAt);

  // ⚠️ Past the cutoff the notice would describe a wipe that is effectively already
  // here. Record it so the next tick does not keep trying, and stay silent.
  if (opts.now.getTime() >= wipeAt.getTime() - ANNOUNCE_CUTOFF_MS) {
    await db.insert(vehicleWipeAnnouncements)
      .values({ wipeAt, announcedAt: opts.now, eventName: vehicle.event, outcome: "missed" })
      .onConflictDoNothing();
    out.missed++;
    return out;
  }

  try {
    await post(weeklyWipeAnnouncement(vehicle, wipeAt));
  } catch (err) {
    // No row: the next tick retries until the cutoff closes the window.
    opts.onError?.(err);
    out.failed++;
    return out;
  }

  await db.insert(vehicleWipeAnnouncements)
    .values({ wipeAt, announcedAt: opts.now, eventName: vehicle.event, outcome: "posted" })
    .onConflictDoNothing();
  out.posted++;
  return out;
}
