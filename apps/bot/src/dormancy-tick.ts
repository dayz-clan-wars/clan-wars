import { decide, type DormancyWindows } from "./dormancy.js";
import type { DormancyStore } from "./dormancy-store.js";

/** A leader who needs telling. Disband produces none — see the tick. */
export type DormancyNotice = {
  kind: "dormant" | "revive";
  factionId: number;
  leaderDiscordId: string;
  name: string;
  tag: string;
  /** When the flag, tag and pole return to the pool if nothing changes. */
  disbandAt: Date;
};

export type DormancyTickResult = {
  examined: number;
  dormant: number;
  revived: number;
  disbanded: number;
  stamped: number;
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
    examined: 0, dormant: 0, revived: 0, disbanded: 0, stamped: 0, notices: [],
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

        case "dormant":
          if (await store.goDormant(clock.id, now)) {
            out.dormant++;
            out.notices.push(notice("dormant", clock, now, windows));
          }
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
  return {
    kind,
    factionId: clock.id,
    leaderDiscordId: clock.leaderDiscordId,
    name: clock.name,
    tag: clock.tag,
    disbandAt: new Date(now.getTime() + windows.disbandAfterDormantMs),
  };
}
