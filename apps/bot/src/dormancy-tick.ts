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
  opts: { now: Date; windows: DormancyWindows; onError?: (factionId: number, err: unknown) => void },
): Promise<DormancyTickResult> {
  const { now, windows } = opts;
  const out: DormancyTickResult = {
    examined: 0, dormant: 0, revived: 0, disbanded: 0, stamped: 0, paused: 0, notices: [],
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
          if (await store.goDormant(clock.id, now, disbandAt)) {
            out.dormant++;
            out.notices.push(notice("dormant", clock, now, windows));
          }
          break;
        }

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
