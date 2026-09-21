import { serverRestarts, servers, raidWindowFlips, raidWindowSkips, airdropEvents, type Database } from "@factions/db";
import { restartSlot, truckWipeActive, rotationActiveFor, WEEKLY_WIPE_VEHICLES, raidWindowAt, type SkippedWindow, type AirdropSpec } from "@factions/domain";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { setEventActive } from "./events-xml.js";
import { setAirdropSpawner, setBaseDamageDisabled } from "./cfggameplay.js";

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

export type GameplayEdits = {
  /** Present when RAID_WINDOW_TICK is on. */
  raidWindow?: { skips: SkippedWindow[] };
  /** Present when AIRDROP_TICK is on. `wanted` is the drop this slot should register, or null for none. */
  airdrop?: { wanted: AirdropSpec | null };
};

export type GameplayResult = {
  flip?: RaidFlip;
  flipError?: Error;
  airdrop?: { wanted: AirdropSpec | null; changed: boolean };
  airdropError?: Error;
  /**
   * Whether the upload actually happened — `json !== original` after both
   * splices, regardless of which edit (or edits) caused it.
   *
   * ⚠️ This is the fact the raid-window bookkeeping's `previousContent`
   * recording must key on, NOT `flip.changed` alone. Once the airdrop can also
   * write this file, a slot where the airdrop edit changes it and the raid
   * splice does not will overwrite the file while `flip.changed` is false —
   * `flip.changed` and "the file was overwritten" stopped being the same fact
   * the moment a second feature started sharing the upload gate.
   */
  uploaded?: boolean;
};

/**
 * Bring one server's cfggameplay.json to the state `slot` wants — both the raid
 * window's `GeneralData.disableBaseDamage` and the airdrop's entry in
 * `WorldsData.objectSpawnersArr` — immediately before its restart.
 *
 * ⚠️ ONE download and ONE upload, for BOTH features (spec §5). They edit the same
 * file on the same slot; two independent download/upload pairs mean whichever
 * uploads second silently discards the other's edit, with every guard passing and
 * nothing logged. That is the entire reason this function exists rather than two.
 *
 * ⚠️ Level-triggered, exactly like applyTruckWipe. Every slot recomputes both
 * wanted values, so a bot down across Friday 00:00 opens the window LATE rather
 * than not at all, and a lost, hand-reverted or FTP-deploy-clobbered write is
 * corrected within two hours (spec §6).
 *
 * ⚠️ Each splice is attempted in its OWN try/catch and its refusal is RETURNED,
 * never thrown. A guard rejecting the airdrop must not cost the raid weekend, and
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
  if (!edits.raidWindow && !edits.airdrop) return {};

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

  if (edits.airdrop) {
    try {
      const r = setAirdropSpawner(json, edits.airdrop.wanted);
      json = r.json;
      out.airdrop = { wanted: edits.airdrop.wanted, changed: r.changed };
    } catch (err) {
      out.airdropError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const uploaded = json !== original;
  if (uploaded) await nitrado.uploadFile(dir, GAMEPLAY_FILE, json);
  return { ...out, uploaded };
}

export const RESTART_MESSAGE = "Scheduled restart";

/**
 * The in-game restart warning. When a drop goes live in the session this restart
 * opens, it says where (spec §8) — that is the half of the announcement that
 * reaches everyone who is not in Discord.
 *
 * ⚠️ Never the colour. Players are told where, never which key opens it (spec §3.4).
 */
export function restartMessage(location: string | null): string {
  if (!location) return RESTART_MESSAGE;
  const name = location.charAt(0).toUpperCase() + location.slice(1);
  return `${RESTART_MESSAGE}. Airdrop at ${name} next session.`;
}

/** How many enable attempts a drop gets before it is scrubbed (spec §9). */
const AIRDROP_MAX_ENABLE_ATTEMPTS = 2;

export type AirdropIntent = {
  /** What this slot should register, or null for none. */
  wanted: AirdropSpec | null;
  /** The row to move to `live` once the upload succeeds, if any. */
  enabling?: { slotAt: Date; location: string; attempts: number };
  /** Rows to move to `ended` once the upload succeeds. */
  ending: Date[];
};

/**
 * What the airdrop wants from this slot, read from the rows alone (spec §6:
 * level-triggered on database intent).
 *
 * ⚠️ `announced_at is not null` is part of the enable query, not a check after it.
 * A decided-but-unannounced drop must never go live — spec §9.
 */
async function airdropIntent(db: Database, serverId: number, slot: Date): Promise<AirdropIntent> {
  // ⚠️ Ordered by slotAt: with two eligible `announced` rows (both with
  // slotAt <= this slot, which happens after downtime), an unordered select
  // leaves it to Postgres's row order which drop goes live. Oldest first,
  // deterministically.
  const open = await db.select().from(airdropEvents).where(and(
    eq(airdropEvents.serverId, serverId),
    inArray(airdropEvents.state, ["announced", "live"]),
  )).orderBy(asc(airdropEvents.slotAt));

  // ⚠️ `announcedAt !== null` on `live` too, not just `enabling`: a `live` row
  // is only ever supposed to be reachable through the announced-first gate,
  // but spelling the term here as well makes that invariant locally true
  // rather than true only by luck of how the rest of the call chain happens
  // to behave.
  const live = open.find((r) => r.state === "live" && r.announcedAt !== null && r.slotAt.getTime() === slot.getTime());
  const enabling = open.find((r) =>
    r.state === "announced" && r.announcedAt !== null && r.slotAt.getTime() <= slot.getTime());
  // Anything live from an earlier slot has had its session and is over.
  const ending = open.filter((r) => r.state === "live" && r.slotAt.getTime() < slot.getTime()).map((r) => r.slotAt);

  // ⚠️ `live` wins over `enabling`: a drop already live for THIS slot is being
  // re-converged (the FTP-clobber repair), not enabled a second time.
  const holder = live ?? enabling ?? null;
  return {
    wanted: holder ? { location: holder.location, colour: holder.colour } : null,
    enabling: enabling && !live
      ? { slotAt: enabling.slotAt, location: enabling.location, attempts: Number(enabling.detail.enableAttempts ?? 0) }
      : undefined,
    ending,
  };
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
  opts: { now: Date; lastError?: Map<number, string>; truckWipe?: TruckWipe; raidWindow?: RaidWindow; airdrop?: { enabled: boolean } },
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
      let intent: AirdropIntent | undefined;
      // ⚠️ The message is settled BEFORE the upload, and names the drop this
      // slot is bringing up. A drop being taken away must not be advertised.
      let airdropLocation: string | null = null;
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
        if (opts.airdrop?.enabled) {
          intent = await airdropIntent(db, s.id, slot.start);
          edits.airdrop = { wanted: intent.wanted };
          airdropLocation = intent.enabling?.location ?? intent.wanted?.location ?? null;
        }

        const gameplay = await applyGameplay(nitrado, slot.start, edits);

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
                // identical current contents. Since the airdrop can now also cause
                // this upload, `flip.changed` alone is no longer "the file was
                // overwritten" — a slot where the airdrop changes the file and the
                // raid splice does not still overwrites it, and `previousContent`
                // must still be recorded for that write.
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
                // and using it here was the bug: an airdrop-only upload on an
                // ALREADY-applied boundary (Saturday's enable, after Friday already
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

        if (opts.airdrop?.enabled && intent) {
          // ⚠️ Its own try/catch: airdrop bookkeeping must never cost the raid
          // window's, nor the restart below.
          try {
            if (gameplay.airdropError) {
              const attempts = (intent.enabling?.attempts ?? 0) + 1;
              const detail = { enableAttempts: attempts, error: gameplay.airdropError.message };
              console.error(`airdrop: server ${s.id} REFUSED the splice for slot ${slot.start.toISOString()} — restarting anyway`, gameplay.airdropError);
              if (intent.enabling) {
                await db.update(airdropEvents).set({
                  // ⚠️ Two attempts and it scrubs (spec §9): a failed enable costs one
                  // event, and a row left `announced` forever would hold the "nothing
                  // announced or live" guard shut and stop the feature dead.
                  ...(attempts >= AIRDROP_MAX_ENABLE_ATTEMPTS ? { state: "failed" as const, endedAt: opts.now } : {}),
                  detail,
                }).where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, intent.enabling.slotAt)));
              }
              airdropLocation = null;
            } else {
              if (intent.enabling) {
                await db.update(airdropEvents).set({ state: "live" })
                  .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, intent.enabling.slotAt)));
                console.log(`airdrop: server ${s.id} enabled ${intent.wanted!.location}/${intent.wanted!.colour} for ${slot.start.toISOString()}`);
              }
              for (const slotAt of intent.ending) {
                await db.update(airdropEvents).set({ state: "ended", endedAt: opts.now })
                  .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, slotAt)));
                console.log(`airdrop: server ${s.id} ended the drop from ${slotAt.toISOString()}`);
              }
            }
          } catch (err) {
            // ⚠️ Swallowed, like the raid window's: the upload already happened, and a
            // throw here would abort the slot's server_restarts row and make the next
            // pass restart the server a second time. A `live` row that failed to become
            // `ended` is retried at the next slot, which is why the disable never gives up.
            console.error(`airdrop: server ${s.id} could not record the slot ${slot.start.toISOString()}`, err);
          }
        }
      } catch (err) {
        // ⚠️ Scrub `airdropLocation` here too, not only on `gameplay.airdropError`.
        // A THROW out of this block (missionRootDir, downloadFile, the skips
        // SELECT, airdropIntent's own query) means nothing was uploaded and the
        // row never left `announced` — the same "nothing to advertise" fact as a
        // refused splice, just from a different failure point. Without this the
        // in-game restart warning would tell every player the drop is live for a
        // session where the file was never touched.
        airdropLocation = null;
        console.error(`restart: server ${s.id} could not evaluate cfggameplay.json for slot ${slot.start.toISOString()} — restarting anyway`, err);
      }

      await nitrado.restart(restartMessage(airdropLocation));
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
