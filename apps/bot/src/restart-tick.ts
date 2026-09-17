import { serverRestarts, servers, raidWindowFlips, raidWindowSkips, type Database } from "@factions/db";
import { restartSlot, truckWipeActive, rotationActiveFor, WEEKLY_WIPE_VEHICLES, raidWindowAt, type SkippedWindow } from "@factions/domain";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { setEventActive } from "./events-xml.js";
import { setBaseDamageDisabled } from "./cfggameplay.js";

/** What the tick needs from a Nitrado client, so a test can hand it a fake. */
export type RestartTarget = {
  status(): Promise<string>;
  restart(message: string): Promise<void>;
  /** Only reached when a truck wipe is configured. */
  missionDbDir(): Promise<string>;
  /** Only reached when the raid window flip is enabled. */
  missionRootDir(): Promise<string>;
  downloadFile(path: string): Promise<string>;
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
};

/** Which events.xml entries the wipe owns, the UTC window they are off for, and
 *  whether the weekly vehicle rotation rides along. */
export type TruckWipe = { events: string[]; offHour: number; onHour: number; rotation: boolean };

/** The events.xml file name, inside the mission's `db` directory. */
const EVENTS_FILE = "events.xml";
export type RestartTickResult = { restarted: number; skipped: number; missed: number; failed: number };

/**
 * Bring one server's events.xml to the state `slot` wants, immediately before its
 * restart. Returns true when a write actually went out.
 *
 * ⚠️ Level-triggered — see `truckWipeActive`. Every slot recomputes the wanted
 * state, so the 10 daily slots outside the window each verify the trucks are back
 * on and rewrite the file if some earlier write was lost. A file already in the
 * wanted state is NEVER re-uploaded: the download still happens (that is the
 * check), the upload does not.
 */
async function applyTruckWipe(nitrado: RestartTarget, wipe: TruckWipe, slot: Date): Promise<boolean> {
  const daily = truckWipeActive(slot, wipe.offHour, wipe.onHour);
  const dir = await nitrado.missionDbDir();
  const original = await nitrado.downloadFile(`${dir}/${EVENTS_FILE}`);

  let xml = original;
  for (const name of wipe.events) xml = setEventActive(xml, name, daily).xml;

  // ⚠️ ALL five every slot, not just this week's. A bot down across a Monday 10:00
  // leaves that week's vehicle at 0, and by the time it returns the rotation has moved
  // on — nothing else would ever put it back. Converging the whole set costs nothing:
  // the download already happened, and an unchanged file is still never re-uploaded.
  if (wipe.rotation) {
    for (const v of WEEKLY_WIPE_VEHICLES) {
      xml = setEventActive(xml, v.event, rotationActiveFor(slot, wipe.offHour, wipe.onHour, v.event)).xml;
    }
  }

  if (xml === original) return false;

  await nitrado.uploadFile(dir, EVENTS_FILE, xml);
  return true;
}

export type RaidWindow = { enabled: boolean };

/** The cfggameplay.json file name, in the mission ROOT (not `db`, not `custom`). */
const GAMEPLAY_FILE = "cfggameplay.json";

export type RaidFlip = {
  boundaryAt: Date;
  wantedDisabled: boolean;
  changed: boolean;
  previousContent: string;
};

/**
 * Bring one server's cfggameplay.json to the state `slot` wants, immediately
 * before its restart.
 *
 * ⚠️ Level-triggered, exactly like applyTruckWipe. Every slot recomputes the
 * wanted value, so a bot down across Friday 00:00 opens the window LATE rather
 * than not at all, and a lost or hand-reverted write is corrected within two
 * hours. An edge-triggered version ("on the Friday slot, set false") loses a
 * whole weekend to one missed tick and nothing anywhere notices.
 *
 * ⚠️ The returned boundaryAt is the WINDOW boundary, never the slot: a Saturday
 * repair belongs to that Friday's row.
 *
 * ⚠️ Throws rather than uploading whenever a guard in setBaseDamageDisabled
 * rejects the edit. Refusing costs a window that opens two hours late; writing a
 * cfggameplay.json that does not parse costs every player the server itself.
 */
export async function applyRaidWindow(
  nitrado: RestartTarget,
  slot: Date,
  skips: SkippedWindow[],
): Promise<RaidFlip> {
  const state = raidWindowAt(slot, skips);
  const dir = await nitrado.missionRootDir();
  const original = await nitrado.downloadFile(`${dir}/${GAMEPLAY_FILE}`);

  const { json, changed } = setBaseDamageDisabled(original, state.baseDamageDisabled);

  if (changed) await nitrado.uploadFile(dir, GAMEPLAY_FILE, json);

  // ⚠️ state.boundaryAt, never a local derivation. The announcer and the website
  // key their confirmation lookups on the same field; deriving it here independently
  // is how the writer and the readers ended up disagreeing about midweek instants.
  return {
    boundaryAt: state.boundaryAt,
    wantedDisabled: state.baseDamageDisabled,
    changed,
    previousContent: original,
  };
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
  opts: { now: Date; lastError?: Map<number, string>; truckWipe?: TruckWipe; raidWindow?: RaidWindow },
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
      if (opts.truckWipe && (opts.truckWipe.events.length > 0 || opts.truckWipe.rotation)) {
        try {
          const wrote = await applyTruckWipe(nitrado, opts.truckWipe, slot.start);
          if (wrote) console.log(`restart: server ${s.id} wrote events.xml for ${slot.start.toISOString()}`);
        } catch (err) {
          console.error(`restart: server ${s.id} truck wipe failed for slot ${slot.start.toISOString()} — restarting anyway`, err);
        }
      }

      // ⚠️ BEFORE the restart POST and only for a server actually being restarted:
      // DayZ reads cfggameplay.json at boot, so a write after the POST does not take
      // effect for another two hours. ⚠️ Its own try/catch — a refused flip must
      // never cost the restart; the next slot recomputes the wanted state anyway.
      let flip: RaidFlip | undefined;
      if (opts.raidWindow?.enabled) {
        // ⚠️ The boundary is computed BEFORE the attempt, so the catch below can key
        // its row on the same boundary a success would have used. Keying a refusal on
        // the SLOT instead would write a fresh row every two hours — up to 12 a day —
        // and the failure alert, which fires once per (boundary, kind), would fire
        // once per slot with it. That is the exact alert-burial this design refuses.
        const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
          .from(raidWindowSkips);
        const state = raidWindowAt(slot.start, skips);
        const boundaryAt = state.boundaryAt;
        try {
          flip = await applyRaidWindow(nitrado, slot.start, skips);
          if (flip.changed) {
            await db.insert(raidWindowFlips).values({
              serverId: s.id,
              boundaryAt: flip.boundaryAt,
              wantedDisabled: flip.wantedDisabled,
              outcome: "applied",
              appliedAt: opts.now,
              previousContent: flip.previousContent,
            }).onConflictDoUpdate({
              target: [raidWindowFlips.serverId, raidWindowFlips.boundaryAt],
              set: { outcome: "applied", appliedAt: opts.now, wantedDisabled: flip.wantedDisabled },
            });
            console.log(`raid window: server ${s.id} set disableBaseDamage=${flip.wantedDisabled} for ${flip.boundaryAt.toISOString()}`);
          }
        } catch (err) {
          const detail = { error: err instanceof Error ? err.message : String(err) };
          console.error(`raid window: server ${s.id} REFUSED the flip for slot ${slot.start.toISOString()} — restarting anyway`, err);
          await db.insert(raidWindowFlips).values({
            serverId: s.id,
            boundaryAt,
            wantedDisabled: state.baseDamageDisabled,
            outcome: "refused",
            detail,
          }).onConflictDoUpdate({
            target: [raidWindowFlips.serverId, raidWindowFlips.boundaryAt],
            // ⚠️ Only downgrade a row that is not already applied. A later slot that
            // fails must never turn a confirmed flip into a refusal — that would make
            // the website stop saying LIVE for a window that genuinely is live.
            setWhere: sql`${raidWindowFlips.outcome} <> 'applied'`,
            set: { outcome: "refused", detail },
          }).catch(() => undefined);
        }
      }

      await nitrado.restart(RESTART_MESSAGE);
      // ⚠️ An upload whose restart did not happen is NOT in effect. Confirmation is
      // what the website and the open/close announcements read; recording it before
      // the restart would make them assert a flip the server has not loaded.
      if (flip?.changed) {
        await db.update(raidWindowFlips).set({ restartConfirmedAt: opts.now })
          .where(and(eq(raidWindowFlips.serverId, s.id), eq(raidWindowFlips.boundaryAt, flip.boundaryAt)))
          .catch(() => undefined);
      }
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
