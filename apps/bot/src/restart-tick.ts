import { serverRestarts, servers, raidWindowFlips, raidWindowSkips, kothEvents, type Database } from "@factions/db";
import { kothTownName, restartSlot, truckWipeActive, rotationActiveFor, WEEKLY_WIPE_VEHICLES, raidWindowAt, type SkippedWindow } from "@factions/domain";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { setEventActive } from "./events-xml.js";
import { setBaseDamageDisabled, setSpawnGearPresets } from "./cfggameplay.js";
import { planKoth, convergeKothFiles, type KothPlan } from "./koth-converge.js";

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
  /** Only reached for King of the Hill: one listing of custom/ proves every preset is on the server. */
  listFiles(dir: string): Promise<string[]>;
};

/** Which events.xml entries the wipe owns, the UTC window they are off for, and
 *  whether the weekly vehicle rotation rides along. */
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
 * ⚠️ ONE download and ONE upload for every feature, exactly as `applyGameplay` is
 * for cfggameplay.json: two round trips silently lose whichever edit uploads first.
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
      // on — nothing else would ever put it back.
      if (wipe.rotation) {
        for (const v of WEEKLY_WIPE_VEHICLES) {
          next = setEventActive(next, v.event, rotationActiveFor(slot, wipe.offHour, wipe.onHour, v.event)).xml;
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

export type RaidWindow = { enabled: boolean };

/** The cfggameplay.json file name, in the mission ROOT (not `db`, not `custom`). */
const GAMEPLAY_FILE = "cfggameplay.json";

export type RaidFlip = {
  boundaryAt: Date;
  wantedDisabled: boolean;
  changed: boolean;
  previousContent: string;
};

export type GameplayEdits = {
  /** Present when RAID_WINDOW_TICK is on. */
  raidWindow?: { skips: SkippedWindow[] };
  /** Present when King of the Hill is on. The wanted `spawnGearPresetFiles` list. */
  koth?: { presets: string[] };
};

export type GameplayResult = {
  flip?: RaidFlip;
  flipError?: Error;
  koth?: { changed: boolean };
  kothError?: Error;
  /**
   * Whether the upload actually happened — `json !== original` after both
   * splices, regardless of which edit (or edits) caused it.
   *
   * ⚠️ This is the fact the raid-window bookkeeping's `previousContent`
   * recording must key on, NOT `flip.changed` alone. A slot where the KotH
   * preset edit changes the file and the raid splice does not overwrites the
   * file while `flip.changed` is false —
   * `flip.changed` and "the file was overwritten" stopped being the same fact
   * the moment a second feature started sharing the upload gate.
   */
  uploaded?: boolean;
};

/**
 * Bring one server's cfggameplay.json to the state `slot` wants — both the raid
 * window's `GeneralData.disableBaseDamage` and King of the Hill's
 * `spawnGearPresetFiles` list — immediately before its restart.
 *
 * ⚠️ ONE download and ONE upload, for BOTH features (spec §5). They edit the same
 * file on the same slot; two independent download/upload pairs mean whichever
 * uploads second silently discards the other's edit, with every guard passing and
 * nothing logged. That is the entire reason this function exists rather than two.
 *
 * ⚠️ Level-triggered, exactly like applyEvents. Every slot recomputes both
 * wanted values, so a bot down across Friday 00:00 opens the window LATE rather
 * than not at all, and a lost, hand-reverted or FTP-deploy-clobbered write is
 * corrected within two hours (spec §6).
 *
 * ⚠️ Each splice is attempted in its OWN try/catch and its refusal is RETURNED,
 * never thrown. A guard rejecting the KotH presets must not cost the raid weekend, and
 * vice versa; the caller records each outcome against its own feature's rows.
 *
 * ⚠️ The returned `boundaryAt` (on `flip`) is the WINDOW boundary, never the
 * slot — a Saturday repair belongs to that Friday's row, not to Saturday's.
 *
 * ⚠️ An edge-triggered version of this — one that only acted on a transition,
 * rather than recomputing the wanted state every slot — would lose a whole
 * weekend to one missed tick, with nothing anywhere noticing.
 */
export async function applyGameplay(
  nitrado: RestartTarget, slot: Date, edits: GameplayEdits,
): Promise<GameplayResult> {
  if (!edits.raidWindow && !edits.koth) return {};

  const dir = await nitrado.missionRootDir();
  const original = await nitrado.downloadFile(`${dir}/${GAMEPLAY_FILE}`);
  const out: Omit<GameplayResult, "uploaded"> = {};
  let json = original;

  if (edits.raidWindow) {
    const state = raidWindowAt(slot, edits.raidWindow.skips);
    try {
      const r = setBaseDamageDisabled(json, state.baseDamageDisabled);
      json = r.json;
      // ⚠️ state.boundaryAt, never a local derivation. The announcer and the
      // website key their confirmation lookups on the same field; deriving it here
      // independently is how the writer and the readers ended up disagreeing about
      // midweek instants.
      out.flip = {
        boundaryAt: state.boundaryAt, wantedDisabled: state.baseDamageDisabled,
        changed: r.changed, previousContent: original,
      };
    } catch (err) {
      out.flipError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (edits.koth) {
    try {
      const r = setSpawnGearPresets(json, edits.koth.presets);
      json = r.json;
      out.koth = { changed: r.changed };
    } catch (err) {
      out.kothError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const uploaded = json !== original;
  if (uploaded) await nitrado.uploadFile(dir, GAMEPLAY_FILE, json);
  return { ...out, uploaded };
}

export const RESTART_MESSAGE = "Scheduled restart";

/**
 * The in-game restart warning. A King of the Hill session names its town (KotH
 * spec §5.5) — that is the half of the announcement that reaches everyone who is
 * not in Discord.
 */
export function restartMessage(koth: string | null = null): string {
  // Arrives as a display name (`kothTownName`), already cased.
  return koth ? `${RESTART_MESSAGE}. King of the Hill at ${koth} next session.` : RESTART_MESSAGE;
}

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
    now: Date; lastError?: Map<number, string>; truckWipe?: TruckWipe; raidWindow?: RaidWindow;
    /** ⚠️ `open` is KOTH_TICK. Absent means off: a session is only ever opened on purpose. The restore runs regardless. */
    koth?: { open: boolean };
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

      // ⚠️ King of the Hill (spec §5). Planned for EVERY server being restarted
      // whenever any KotH row exists, whether or not KOTH_TICK is set — the
      // restore must still run if the feature is switched off mid-event.
      // Its own try/catch: KotH must never cost the restart. A plan that throws
      // leaves every KotH file as it is; the next slot plans again.
      let koth: KothPlan | null = null;
      try {
        koth = await planKoth(db, nitrado, s.id, slot.start, { allowOpen: opts.koth?.open ?? false });
      } catch (err) {
        console.error(`koth: server ${s.id} could not plan slot ${slot.start.toISOString()} — restarting anyway`, err);
      }
      // ⚠️ The row this slot is opening, nulled the moment any edit for it fails.
      // It is what the restart message advertises and what goes `live` after the
      // POST, so a session that failed half-way is neither announced in game nor
      // recorded as running; the next slot's restore arm puts the files back.
      let kothOpening = koth?.opening ?? null;
      const failKoth = async (reason: string): Promise<void> => {
        const row = kothOpening;
        kothOpening = null;
        if (!row) return;
        console.error(`koth: server ${s.id} failed to open ${row.location} for slot ${slot.start.toISOString()} — ${reason}; restarting anyway`);
        // ⚠️ Only from `scheduled`, and merged into `detail`, never replacing it.
        // ⚠️ Swallowed: bookkeeping must never cost the restart.
        await db.update(kothEvents).set({
          state: "failed",
          detail: sql`${kothEvents.detail} || ${JSON.stringify({ failure: reason })}::jsonb`,
        }).where(and(eq(kothEvents.id, row.id), eq(kothEvents.state, "scheduled"))).catch(() => undefined);
      };

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

      // ⚠️ BEFORE the restart POST and only for a server actually being restarted:
      // DayZ reads cfggameplay.json at boot, so a write after the POST does not take
      // effect for another two hours. ⚠️ The whole block is one outer try/catch — a
      // failure anywhere here (the skips SELECT included) must never cost the
      // restart; the next slot recomputes the wanted state anyway.
      let flip: RaidFlip | undefined;
      // ⚠️ Captured even when nothing changed and even when the attempt below
      // refuses, so the confirm step after the restart POST can still find and
      // confirm an EARLIER slot's still-unconfirmed `applied` row (I1) — a restart
      // that succeeds now is evidence for whatever the file currently contains,
      // not only for a flip this exact slot made.
      let raidBoundaryAt: Date | undefined;
      try {
        const edits: GameplayEdits = {};
        // ⚠️ The boundary is computed BEFORE the attempt, so a refusal below can
        // key its row on the same boundary a success would have used. Keying a
        // refusal on the SLOT instead would write a fresh row every two hours —
        // up to 12 a day — and the failure alert, which fires once per
        // (boundary, kind), would fire once per slot with it. That is the exact
        // alert-burial this design refuses.
        let state: ReturnType<typeof raidWindowAt> | undefined;
        if (opts.raidWindow?.enabled) {
          const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
            .from(raidWindowSkips);
          state = raidWindowAt(slot.start, skips);
          raidBoundaryAt = state.boundaryAt;
          edits.raidWindow = { skips };
        }
        // ⚠️ Same guard as the whole files below: an opening that already failed
        // (a refused narrowing or globals edit) must not put KotH's presets in
        // the file — the row is `failed` and nothing would ever advertise the session.
        if (koth?.presets && (koth.opening === null || kothOpening !== null)) edits.koth = { presets: koth.presets };

        const gameplay = await applyGameplay(nitrado, slot.start, edits);

        if (gameplay.kothError) {
          console.error(`koth: server ${s.id} REFUSED the preset splice for slot ${slot.start.toISOString()}`, gameplay.kothError);
          await failKoth(gameplay.kothError.message);
        }

        if (opts.raidWindow?.enabled) {
          const boundaryAt = raidBoundaryAt!;
          try {
            if (gameplay.flipError) throw gameplay.flipError;
            flip = gameplay.flip;
          } catch (err) {
            const detail = { error: err instanceof Error ? err.message : String(err) };
            console.error(`raid window: server ${s.id} REFUSED the flip for slot ${slot.start.toISOString()} — restarting anyway`, err);
            await db.insert(raidWindowFlips).values({
              serverId: s.id,
              boundaryAt,
              wantedDisabled: state!.baseDamageDisabled,
              outcome: "refused",
              detail,
            }).onConflictDoUpdate({
              target: [raidWindowFlips.serverId, raidWindowFlips.boundaryAt],
              // ⚠️ Only downgrade a row that is not already applied. A later slot that
              // fails must never turn a confirmed flip into a refusal — that would make
              // the website stop saying LIVE for a window that genuinely is live.
              setWhere: sql`${raidWindowFlips.outcome} <> 'applied'`,
              set: { outcome: "refused", detail },
              // ⚠️ Swallowed on purpose: a bookkeeping failure must never cost the
              // restart this slot was going to perform anyway. What is lost is
              // SILENT — with no `refused` row, raid-window-tick.ts's failure scan
              // finds nothing and NO ops alert ever fires for this flip; the
              // console.error above is then the only trace it happened. The next
              // slot re-attempts the flip and writes the row if it fails again.
            }).catch(() => undefined);
          }

          if (flip) {
            // ⚠️ A SEPARATE try/catch from the flip attempt above. The file upload
            // already succeeded by this point — a failure here is a bookkeeping
            // failure, not a refusal, and must never be recorded as one: a
            // `refused` row for a flip that actually happened would tell the
            // website a live window is not live.
            //
            // ⚠️ A row is written even when the file already held the wanted value
            // (`changed === false`). Both readers — the website's strip and the
            // open/close announcer — treat the ABSENCE of a row as "not confirmed",
            // so a boundary that needed no edit would otherwise read as a failed
            // flip forever: on day one (the feature switched on with the file
            // already correct), on the Monday after a skipped weekend, and after
            // the operator's own manual fallback in docs/deploy/raid-window.md —
            // which tells them "not yet confirmed" means the flip FAILED.
            // The (server_id, boundary_at) key caps this at ONE row per boundary
            // however many slots run, and the setWhere below makes every later
            // no-change upsert a no-op; the spec's earlier "~84 rows a week" cost
            // for recording no-op slots does not exist.
            try {
              await db.insert(raidWindowFlips).values({
                serverId: s.id,
                boundaryAt: flip.boundaryAt,
                wantedDisabled: flip.wantedDisabled,
                outcome: "applied",
                appliedAt: opts.now,
                // ⚠️ Keyed on `gameplay.uploaded`, NOT `flip.changed`. Only a write
                // that actually overwrote the file has something to recover; a
                // no-change slot must not clobber a real pre-edit copy with the
                // identical current contents. Since KotH's preset edit can also cause
                // this upload, `flip.changed` alone is no longer "the file was
                // overwritten" — a slot where KotH changes the file and the raid
                // splice does not still overwrites it, and `previousContent` must
                // still be recorded for that write.
                ...(gameplay.uploaded ? { previousContent: flip.previousContent } : {}),
              }).onConflictDoUpdate({
                target: [raidWindowFlips.serverId, raidWindowFlips.boundaryAt],
                // ⚠️ Also clears any earlier refusal's `detail` and writes this
                // flip's `previousContent` — otherwise the one-command rollback the
                // schema promises is unavailable for exactly the flip that wrote a
                // file, and the applied row keeps stale refusal text (I4).
                //
                // ⚠️ The no-change arm carries `setWhere outcome <> 'applied'`, so
                // it never rewrites an already-applied row (it would otherwise move
                // `applied_at` forward every two hours and lose the real flip's
                // timestamp). It DOES clear a stale `refused` row once the file is
                // observed correct again — today such a row can only be cleared by a
                // slot that happens to rewrite the file.
                //
                // ⚠️ The `setWhere` guard is keyed on `flip.changed`, NOT on
                // `gameplay.uploaded`. `flip.changed` is "did THIS boundary's raid
                // splice need an edit" — the fact that decides whether this is a
                // genuinely new flip for this boundary (safe to overwrite an
                // existing applied row unconditionally) or a mere re-verification
                // (must not clobber an already-applied row's `applied_at`/
                // `previousContent`). `gameplay.uploaded` answers a DIFFERENT
                // question — "did the upload happen at all, for either feature" —
                // and using it here was the bug: a KotH-only upload on an
                // ALREADY-applied boundary (the Saturday opening, after Friday already
                // recorded the true pre-flip copy) made `gameplay.uploaded` true
                // with `flip.changed` still false, and the unconditional branch it
                // selected clobbered Friday's real rollback copy and `applied_at`
                // with Saturday's post-flip file. `previousContent` is still
                // recorded in the no-change arm's `set` when `gameplay.uploaded` is
                // true, but only inside the arm the `setWhere` guard protects — so
                // it lands only on a row not already `applied` (e.g. converting a
                // stale `refused` row once the file is observed correct).
                ...(flip.changed
                  ? {
                    set: {
                      outcome: "applied" as const,
                      appliedAt: opts.now,
                      wantedDisabled: flip.wantedDisabled,
                      previousContent: flip.previousContent,
                      detail: {},
                    },
                  }
                  : {
                    setWhere: sql`${raidWindowFlips.outcome} <> 'applied'`,
                    set: {
                      outcome: "applied" as const,
                      appliedAt: opts.now,
                      wantedDisabled: flip.wantedDisabled,
                      detail: {},
                      ...(gameplay.uploaded ? { previousContent: flip.previousContent } : {}),
                    },
                  }),
              });
              if (flip.changed) {
                console.log(`raid window: server ${s.id} set disableBaseDamage=${flip.wantedDisabled} for ${flip.boundaryAt.toISOString()}`);
              }
            } catch (err) {
              const what = flip.changed ? "flipped" : "verified";
              console.error(`raid window: server ${s.id} ${what} disableBaseDamage=${flip.wantedDisabled} but failed to record it for ${flip.boundaryAt.toISOString()}`, err);
            }
          }
        }

      } catch (err) {
        console.error(`restart: server ${s.id} could not evaluate cfggameplay.json for slot ${slot.start.toISOString()} — restarting anyway`, err);
        // ⚠️ Same fact for KotH: nothing proves its presets reached the file.
        if (koth?.presets) await failKoth(`cfggameplay.json: ${err instanceof Error ? err.message : String(err)}`);
      }

      // The four whole files (spec §2.3), last before the POST. ⚠️ An opening that
      // has already failed does not upload its town files: the row is `failed`, the
      // next slot restores, and every file not uploaded now is one less to undo.
      if (koth && koth.files.length > 0 && (koth.opening === null || kothOpening !== null)) {
        try {
          const f = await convergeKothFiles(nitrado, koth.files);
          if (f.uploaded > 0) console.log(`koth: server ${s.id} wrote ${f.uploaded} file(s) for ${slot.start.toISOString()}`);
          if (f.errors.length > 0) {
            console.error(`koth: server ${s.id} could not write ${f.errors.join("; ")}`);
            await failKoth(f.errors.join("; "));
          }
        } catch (err) {
          console.error(`koth: server ${s.id} file convergence failed for slot ${slot.start.toISOString()}`, err);
          await failKoth(`files: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await nitrado.restart(restartMessage(kothOpening ? kothTownName(kothOpening.location) : null));
      // ⚠️ An upload whose restart did not happen is NOT in effect. Confirmation is
      // what the website and the open/close announcements read; recording it before
      // the restart would make them assert a flip the server has not loaded.
      //
      // ⚠️ Confirm by LOOKUP, not by `flip?.changed` (I1). Gating on `changed` leaves
      // an `applied` row from an EARLIER slot permanently unconfirmed whenever that
      // slot's own restart failed and every later slot finds the file already
      // correct (so `changed` is false forever after). This restart's success is
      // evidence the current file — whatever slot wrote it — is now loaded, so any
      // still-unconfirmed `applied` row for this boundary is confirmed here too.
      if (raidBoundaryAt) {
        await db.update(raidWindowFlips).set({ restartConfirmedAt: opts.now })
          .where(and(
            eq(raidWindowFlips.serverId, s.id),
            eq(raidWindowFlips.boundaryAt, raidBoundaryAt),
            eq(raidWindowFlips.outcome, "applied"),
            isNull(raidWindowFlips.restartConfirmedAt),
          ))
          // ⚠️ Swallowed on purpose: the restart POST has already gone out, and a
          // throw here would abort the slot's `server_restarts` row and make the
          // next pass restart the server a second time. What is lost is SILENT —
          // the flip row stays `applied` with a null `restart_confirmed_at`, so the
          // website reads "not yet confirmed" and no open/close message posts, until
          // a later slot's restart succeeds and this same lookup confirms it.
          .catch(() => undefined);
      }
      if (kothOpening) {
        // ⚠️ Only after the POST, and only from `scheduled`: a row a failed edit
        // above already moved to `failed` must stay failed, and a session is only
        // live once the server has actually loaded it. A
        // failed POST leaves it `scheduled`, so the retry inside the grace window
        // opens it again with the snapshots the first attempt already wrote.
        // ⚠️ Swallowed, like the raid window's confirm: a throw here would abort the slot's
        // server_restarts row and restart the server a second time.
        await db.update(kothEvents).set({ state: "live", openedAt: opts.now })
          .where(and(eq(kothEvents.id, kothOpening.id), eq(kothEvents.state, "scheduled")))
          .catch(() => undefined);
        console.log(`koth: server ${s.id} opened ${kothOpening.location} for ${slot.start.toISOString()}`);
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
