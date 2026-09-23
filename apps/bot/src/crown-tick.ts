import { BOARD_KINDS, type BoardKind } from "@factions/roster";
import type { GuildGateway } from "./guild.js";

/** Discord ids currently holding #1 on each board. A board with no holder has no entry. */
export type CrownHolders = Map<BoardKind, Set<string>>;

export interface CrownStore {
  /**
   * The #1 of every board in the current season, as Discord ids. Every player
   * tied at the top value holds it; a #1 who has not linked their Discord
   * account contributes nothing, which leaves that crown unheld.
   */
  topHolders(): Promise<CrownHolders>;
}

/** The role id wired to each board. A board with no id here is never touched. */
export type CrownRoleIds = Partial<Record<BoardKind, string>>;

export type CrownTickResult = { adds: number; removes: number; errors: number };

export type CrownTickOpts = {
  roleIds: CrownRoleIds;
  onError?: (what: string, err: unknown) => void;
};

/**
 * The crown reconciler: each of the ten leaderboards has one role, and the
 * players at #1 hold it. Shaped like `structureTick` — diffs desired against
 * actual and issues only the writes that close a difference, never throws,
 * and counts a failed write as one error so the other eight boards still
 * reconcile.
 *
 * ⚠️ A failed board read returns early with NO writes. Treating a failed read
 * as "nobody is #1" would strip all ten crowns off everyone on one bad
 * query, and hand them all back on the next tick.
 *
 * A cold member cache only ever under-acts, the same as `structureTick`:
 * `desired` is filtered by `isMember` and every id in `actual` comes from the
 * member cache too, so no crown is wrongly stripped before the cache fills.
 */
export async function crownTick(
  store: CrownStore,
  guild: GuildGateway,
  opts: CrownTickOpts,
): Promise<CrownTickResult> {
  const out: CrownTickResult = { adds: 0, removes: 0, errors: 0 };

  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      out.errors++;
      opts.onError?.(what, err);
    }
  };

  let holders: CrownHolders;
  try {
    holders = await store.topHolders();
  } catch (err) {
    out.errors++;
    opts.onError?.("boards-read", err);
    return out;
  }

  for (const kind of BOARD_KINDS) {
    const roleId = opts.roleIds[kind];
    if (roleId === undefined) continue;

    const desired = new Set([...(holders.get(kind) ?? [])].filter((id) => guild.isMember(id)));
    const actual = guild.roleMembers(roleId);

    for (const id of actual) {
      if (desired.has(id)) continue;
      await step(`${kind}-remove:${id}`, async () => {
        await guild.removeRole(id, roleId);
        out.removes++;
      });
    }
    for (const id of desired) {
      if (actual.has(id)) continue;
      await step(`${kind}-add:${id}`, async () => {
        await guild.addRole(id, roleId);
        out.adds++;
      });
    }
  }

  return out;
}
