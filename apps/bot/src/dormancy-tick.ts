import { decide, type DormancyWindows } from "./dormancy.js";
import type { DormancyStore } from "./dormancy-store.js";

type DormancyNoticeBase = {
  factionId: number;
  leaderDiscordId: string;
  name: string;
  tag: string;
  /**
   * How long a flag may go unraised before the faction goes dormant. Carried
   * here (rather than hardcoded in the DM copy) so `BOT_DORMANT_AFTER_MS`
   * stays the one source of truth for the number a leader is told.
   */
  dormantAfterMs: number;
};

/**
 * A leader who needs telling. Disband produces none — see the tick.
 *
 * Discriminated on `kind` so `disbandAt` — when the flag, tag and pole
 * return to the pool if nothing changes — can only exist on a "dormant"
 * notice, where it's required rather than optional: a "revive" notice has
 * nothing counting down, so a value there would be a number nobody should
 * read. Making the field's presence follow from `kind` at the type level
 * means a hand-built or future-constructed dormant notice missing
 * `disbandAt` fails to compile, instead of type-checking and then throwing
 * at DM time.
 */
export type DormancyNotice =
  | (DormancyNoticeBase & { kind: "dormant"; disbandAt: Date })
  | (DormancyNoticeBase & { kind: "revive" });

export type DormancyTickResult = {
  examined: number;
  dormant: number;
  revived: number;
  disbanded: number;
  stamped: number;
  /**
   * Dormant factions whose disband countdown was restarted because their
   * server looked dark this tick.
   *
   * ⚠️ This is the outage signal, and it is the whole reason the suppression
   * is no longer silent. A non-zero value here means "ingest is not producing
   * events for a server that has dormant factions on it" — previously that
   * state and "nothing was due" were both a null from `decide()` and both
   * counted nothing, so an operator reading the bot's own logs could not tell
   * a quiet week from a broken worker.
   */
  paused: number;
  /**
   * Dormant factions warned that disband is `DISBAND_WARNING_LEAD_MS` away.
   */
  warned: number;
  /**
   * Solo declarations released this tick because the declarant had not raised
   * their flag for SOLO_LAPSE_MS. Counted here rather than logged inside the
   * store so the one job that sweeps the clocks reports every clock it swept.
   */
  soloLapsed: number;
  notices: DormancyNotice[];
};

/**
 * Move every faction to the status its flag says it should have.
 *
 * ⚠️ A notice is emitted only when the guarded transition actually moved a
 * row. That is the at-most-once guard for the DM: two overlapping ticks
 * cannot both warn the same leader, because only one of their updates
 * matches.
 *
 * ⚠️ Per-faction try/catch. One faction's deadlock or constraint violation
 * must not abort the sweep — every faction after it would keep the status it
 * has, and therefore keep or lose supplies for another whole tick.
 */
export async function dormancyTick(
  store: DormancyStore,
  opts: {
    now: Date;
    windows: DormancyWindows;
    onError?: (factionId: number, err: unknown) => void;
    /**
     * Releases solo declarations whose declarant has gone quiet, returning
     * who lapsed. Optional so every existing caller and test keeps working;
     * when it is absent `soloLapsed` is 0 because nothing was swept, which is
     * the honest count.
     */
    lapseSolos?: (now: Date) => Promise<{ dayzId: string; poleKey: string; discordId: string | null }[]>;
  },
): Promise<DormancyTickResult> {
  const { now, windows } = opts;
  const out: DormancyTickResult = {
    examined: 0, dormant: 0, revived: 0, disbanded: 0, stamped: 0, paused: 0, warned: 0, soloLapsed: 0, notices: [],
  };

  for (const clock of await store.clocks()) {
    out.examined++;
    try {
      switch (decide(clock, now, windows)) {
        case "revive":
          if (await store.revive(clock.id)) {
            out.revived++;
            out.notices.push(notice("revive", clock, now, windows));
          }
          break;

        case "dormant": {
          const disbandAt = new Date(now.getTime() + windows.disbandAfterDormantMs);
          if (await store.goDormant(clock.id, now, "inactive", disbandAt)) {
            out.dormant++;
            out.notices.push(notice("dormant", clock, now, windows));
          }
          break;
        }

        case "dormant-raided": {
          // Same disbandAt as the ordinary dormant path — the countdown is
          // identical, only the reason differs. The leader DM (notifyDormancy)
          // stays the same for both dormant kinds; only the channel notice's
          // kind differs, and that lives in the store.
          const disbandAt = new Date(now.getTime() + windows.disbandAfterDormantMs);
          if (await store.goDormant(clock.id, now, "raided", disbandAt)) {
            out.dormant++;
            out.notices.push(notice("dormant", clock, now, windows));
          }
          break;
        }

        case "warn":
          if (await store.warnDisband(clock.id, now)) out.warned++;
          break;

        case "disband":
          // No notice: the faction is gone and its roster was cleared by the
          // same transaction, so there is no longer anyone to tell.
          if (await store.disbandDormant(clock.id, new Date(now.getTime() - windows.disbandAfterDormantMs))) {
            out.disbanded++;
          }
          break;

        case "stamp":
          if (await store.stampDormantSince(clock.id, now)) out.stamped++;
          break;

        case "pause":
          // No notice. The leader was already DMed when the faction went
          // dormant, and a pause only ever moves their deadline further out —
          // telling them "your server is being watched less well than we
          // thought" is noise they cannot act on.
          if (await store.pauseDormancyClock(clock.id, now)) out.paused++;
          break;
      }
    } catch (err) {
      opts.onError?.(clock.id, err);
    }
  }

  // Last, and after the faction loop: solo clocks are independent of every
  // faction's, so a faction that threw above must not cost the solos their
  // sweep.
  //
  // ⚠️ Its own try/catch, for the same reason every faction has one — but the
  // stakes here are the OTHER half of the tick. The faction transitions above
  // are already committed and their guarded updates will not re-emit; if a
  // throw from here escaped, the caller's catch would log "dormancy tick
  // failed" and `out.notices` would never be delivered, leaving leaders whose
  // clan went dormant with no warning and nothing to reconcile it.
  if (opts.lapseSolos) {
    try {
      out.soloLapsed = (await opts.lapseSolos(now)).length;
    } catch (err) {
      // factionId 0 is the sentinel for "not a faction" — no row has it.
      opts.onError?.(0, err);
    }
  }

  return out;
}

function notice(
  kind: DormancyNotice["kind"],
  clock: { id: number; leaderDiscordId: string; name: string; tag: string },
  now: Date,
  windows: DormancyWindows,
): DormancyNotice {
  const base = {
    factionId: clock.id,
    leaderDiscordId: clock.leaderDiscordId,
    name: clock.name,
    tag: clock.tag,
    dormantAfterMs: windows.dormantAfterMs,
  };
  // Only "dormant" carries a deadline — see DormancyNotice's discriminated
  // union — so the two branches build distinct shapes rather than one
  // object with an optional field.
  return kind === "dormant"
    ? { ...base, kind, disbandAt: new Date(now.getTime() + windows.disbandAfterDormantMs) }
    : { ...base, kind };
}
