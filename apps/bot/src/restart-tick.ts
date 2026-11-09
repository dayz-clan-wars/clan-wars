import { serverRestarts, servers, type Database } from "@factions/db";
import { restartSlot, truckWipeActive, rotationActiveFor, fixedWipeActiveFor, WEEKLY_WIPE_VEHICLES, FIXED_WEEKLY_WIPES } from "@factions/domain";
import { and, eq, isNotNull } from "drizzle-orm";
import { setEventActive } from "./events-xml.js";

/** What the tick needs from a Nitrado client, so a test can hand it a fake. */
export type RestartTarget = {
  status(): Promise<string>;
  restart(message: string): Promise<void>;
  /** Only reached when a truck wipe is configured. */
  missionDbDir(): Promise<string>;
  downloadFile(path: string): Promise<string>;
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
};

/** Which events.xml entries the wipe owns, the UTC window they are off for, and
 *  whether the weekly vehicle rotation and the fixed weekly wipes ride along. */
export type TruckWipe = { events: string[]; offHour: number; onHour: number; rotation: boolean };

/** The events.xml file name, inside the mission's `db` directory. */
const EVENTS_FILE = "events.xml";
export type RestartTickResult = { restarted: number; skipped: number; missed: number; failed: number };

export type EventsEdits = { truckWipe?: TruckWipe };
export type EventsResult = { uploaded: boolean; truckWipeError?: Error };

/**
 * Bring one server's events.xml to the state `slot` wants — the truck wipe and the
 * weekly rotation — immediately before its restart.
 *
 * ⚠️ ONE download and ONE upload for every feature: two round trips silently lose
 * whichever edit uploads first.
 *
 * ⚠️ Level-triggered — see `truckWipeActive`. A file already in the wanted state
 * is never re-uploaded.
 *
 * ⚠️ The splices run in their own try/catch and are RETURNED, never thrown. A
 * splice that throws contributes NONE of its edits (`let next = xml` then commit).
 */
export async function applyEvents(nitrado: RestartTarget, slot: Date, edits: EventsEdits): Promise<EventsResult> {
  const dir = await nitrado.missionDbDir();
  const original = await nitrado.downloadFile(`${dir}/${EVENTS_FILE}`);
  let xml = original;
  const out: Omit<EventsResult, "uploaded"> = {};

  const wipe = edits.truckWipe;
  if (wipe && (wipe.events.length > 0 || wipe.rotation)) {
    try {
      let next = xml;
      const daily = truckWipeActive(slot, wipe.offHour, wipe.onHour);
      for (const name of wipe.events) next = setEventActive(next, name, daily).xml;
      // ⚠️ ALL five every slot, not just this week's. A bot down across a Monday 10:00
      // leaves that week's vehicle at 0, and by the time it returns the rotation has moved
      // on — nothing else would ever put it back. The fixed weekly wipes ride the same
      // flag and converge every slot for the same reason.
      if (wipe.rotation) {
        for (const v of WEEKLY_WIPE_VEHICLES) {
          next = setEventActive(next, v.event, rotationActiveFor(slot, wipe.offHour, wipe.onHour, v.event)).xml;
        }
        for (const w of FIXED_WEEKLY_WIPES) {
          next = setEventActive(next, w.event, fixedWipeActiveFor(slot, wipe.offHour, wipe.onHour, w)).xml;
        }
      }
      xml = next;
    } catch (err) {
      out.truckWipeError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const uploaded = xml !== original;
  if (uploaded) await nitrado.uploadFile(dir, EVENTS_FILE, xml);
  return { ...out, uploaded };
}

export const RESTART_MESSAGE = "Scheduled restart";

type Outcome = "restarted" | "skipped" | "missed";

/**
 * The last error per server, for the `missed` row's detail. Process-local by
 * design: a restarted bot has no error to report, and says "not running".
 * Module-level default; `restartTick`'s `opts.lastError` lets a test supply
 * its own map so it cannot leak state across test files (see restart-tick.test.ts).
 */
const moduleLastError = new Map<number, string>();

/** Record a slot. `onConflictDoNothing`: a row already there means another pass handled it. */
async function record(db: Database, serverId: number, slot: Date, now: Date, outcome: Outcome, detail: Record<string, string | number | boolean | null> = {}): Promise<boolean> {
  const inserted = await db.insert(serverRestarts).values({ serverId, scheduledFor: slot, issuedAt: now, outcome, detail }).onConflictDoNothing().returning({ serverId: serverRestarts.serverId });
  return inserted.length > 0;
}

/**
 * Scheduled restarts (spec 2026-09-12). Every pass: find the current slot; for
 * each active server with a Nitrado service, if the slot has no row —
 *
 *   - inside the grace window: check the status, POST the restart, write
 *     `restarted`. A throw writes NOTHING, so the next pass retries; the
 *     last error is kept in memory for the `missed` row.
 *   - past the grace window: write `missed`. A restart that late kicks players
 *     who had no countdown, and the next slot is at most 110 minutes away.
 *
 * ⚠️ POST first, row second. A row before the POST records a restart that
 * never happened when the POST then fails. The reverse — the process dying
 * between POST and insert — is absorbed by the status check on the retry: the
 * server reports `restarting`, and the slot is recorded `skipped`, not
 * restarted twice.
 *
 * ⚠️ Only `started` is restarted. Any other status is `skipped` with the
 * status in `detail`: a messages.xml shutdown or a manual restart already in
 * flight must not be followed by a second one.
 */
export async function restartTick(
  db: Database,
  nitradoFor: (serviceId: number) => RestartTarget,
  opts: {
    now: Date; lastError?: Map<number, string>; truckWipe?: TruckWipe;
  },
): Promise<RestartTickResult> {
  const result: RestartTickResult = { restarted: 0, skipped: 0, missed: 0, failed: 0 };
  const lastError = opts.lastError ?? moduleLastError;
  const slot = restartSlot(opts.now);
  const targets = await db.select({ id: servers.id, serviceId: servers.nitradoServiceId }).from(servers)
    .where(and(eq(servers.active, true), isNotNull(servers.nitradoServiceId)));

  for (const s of targets) {
    const serviceId = s.serviceId!;
    try {
      const [handled] = await db.select({ serverId: serverRestarts.serverId }).from(serverRestarts)
        .where(and(eq(serverRestarts.serverId, s.id), eq(serverRestarts.scheduledFor, slot.start))).limit(1);
      if (handled) continue;

      if (slot.missedIfUnhandled) {
        const err = lastError.get(s.id);
        const detail: Record<string, string | number | boolean | null> = err
          ? { reason: "failed", error: err }
          : { reason: "not running" };
        if (await record(db, s.id, slot.start, opts.now, "missed", detail)) {
          result.missed += 1;
          console.error(`restart: server ${s.id} MISSED slot ${slot.start.toISOString()} (${err ?? "bot was not running"})`);
        }
        lastError.delete(s.id);
        continue;
      }

      const nitrado = nitradoFor(serviceId);
      const status = await nitrado.status();
      if (status !== "started") {
        if (await record(db, s.id, slot.start, opts.now, "skipped", { status })) {
          result.skipped += 1;
          console.warn(`restart: server ${s.id} skipped slot ${slot.start.toISOString()} — status ${status}`);
        }
        // Same reasoning as the `restarted`/`missed` branches: a stale error
        // here would otherwise surface on a LATER slot's `missed` row.
        lastError.delete(s.id);
        continue;
      }

      // ⚠️ BEFORE the restart POST, and only for a server actually being restarted:
      // DayZ reads events.xml at boot, so a write after the POST would not take
      // effect for another two hours. ⚠️ Its own try/catch — a wipe that fails must
      // never cost the restart; players rely on the two-hour cadence, and the next
      // slot recomputes the wanted state anyway.
      // ⚠️ Either half can run alone: the daily truck wipe and the weekly rotation are
      // independently switchable, so this must not require `events` to be non-empty.
      const wipeWanted = !!opts.truckWipe && (opts.truckWipe.events.length > 0 || opts.truckWipe.rotation);
      if (wipeWanted) {
        try {
          const r = await applyEvents(nitrado, slot.start, { truckWipe: opts.truckWipe });
          if (r.truckWipeError) console.error(`restart: server ${s.id} truck wipe refused for slot ${slot.start.toISOString()} — restarting anyway`, r.truckWipeError);
          if (r.uploaded) console.log(`restart: server ${s.id} wrote events.xml for ${slot.start.toISOString()}`);
        } catch (err) {
          console.error(`restart: server ${s.id} events.xml failed for slot ${slot.start.toISOString()} — restarting anyway`, err);
        }
      }

      await nitrado.restart(RESTART_MESSAGE);
      if (await record(db, s.id, slot.start, opts.now, "restarted")) {
        result.restarted += 1;
        console.log(`restart: server ${s.id} restarted for ${slot.start.toISOString()}`);
      } else {
        // ⚠️ The POST already went out — silence here is the one thing that
        // would hide a possible double restart. A false return means some
        // other pass already recorded this slot, so the server may just have
        // been restarted twice.
        console.warn(`restart: server ${s.id} POSTed a restart for slot ${slot.start.toISOString()} that was already recorded — a double restart may have happened`);
      }
      lastError.delete(s.id);
    } catch (err) {
      // Per server: one service's failure never blocks another's. No row —
      // the next pass retries until the window closes.
      result.failed += 1;
      lastError.set(s.id, err instanceof Error ? err.message : String(err));
      console.error(`restart: server ${s.id} failed for slot ${slot.start.toISOString()}`, err);
    }
  }
  return result;
}
