import type { Database } from "@factions/db";
import { factions, flagHolds } from "@factions/db";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { declarationForFaction } from "@factions/declarations";
import { flagTakenTx, lockIdentity, noticeClanTx, startFlagChangeTx } from "@factions/roster/internal";
import { and, eq } from "drizzle-orm";

export type AdminFlagChangeOutcome =
  | "flag-pending" | "dry-run"
  | "no-clan" | "unknown-flag" | "unchanged" | "not-active" | "no-base" | "change-pending" | "flag-taken";

/**
 * An operator starts a clan's flag change, skipping the leader and the rename
 * cooldown (`pnpm flag:change`). Everything after the start is the ordinary
 * rebrand: the kit delivers the flag, a member raises it at home within
 * FLAG_CHANGE_WINDOW_MS, and the old flag is held OLD_FLAG_HOLD_MS.
 *
 * Same refusals and the same lock order as `PgRosterStore.rename`'s flag
 * branch (`factions` FOR UPDATE, then `lockIdentity`), because the flag rules
 * are what keep two clans off one flag; only the leader and cooldown guards
 * are dropped.
 *
 * ⚠️ `stampsCooldown: false`: an operator's change must not restart the
 * clan's own 30-day rebrand cooldown when it completes.
 *
 * ⚠️ `apply: false` runs every check and rolls back, so a dry run refuses
 * exactly what the real run would.
 */
export async function adminFlagChange(
  db: Database,
  a: { serverId: number; tag: string; texture: string; at: Date; apply: boolean },
): Promise<{ outcome: AdminFlagChangeOutcome; until: Date | null }> {
  if (!(CLAIMABLE_FLAGS as readonly string[]).includes(a.texture)) return { outcome: "unknown-flag", until: null };
  const DRY = Symbol("dry-run");
  try {
    return await db.transaction(async (tx) => {
      const [clan] = await tx.select({ id: factions.id, texture: factions.texture, status: factions.status }).from(factions)
        .where(and(eq(factions.serverId, a.serverId), eq(factions.tag, a.tag))).for("update");
      if (!clan) return { outcome: "no-clan" as const, until: null };
      if (clan.texture === a.texture) return { outcome: "unchanged" as const, until: null };
      if (clan.status !== "active") return { outcome: "not-active" as const, until: null };

      const [pending] = await tx.select({ id: flagHolds.id }).from(flagHolds)
        .where(and(eq(flagHolds.factionId, clan.id), eq(flagHolds.kind, "pending")));
      if (pending) return { outcome: "change-pending" as const, until: null };

      await lockIdentity(tx, a.serverId);
      if (!(await declarationForFaction(tx, clan.id))) return { outcome: "no-base" as const, until: null };
      if (await flagTakenTx(tx, a.serverId, a.texture, a.at)) return { outcome: "flag-taken" as const, until: null };

      const until = await startFlagChangeTx(tx, { serverId: a.serverId, factionId: clan.id, texture: a.texture, at: a.at, stampsCooldown: false });
      await noticeClanTx(tx, {
        serverId: a.serverId, factionId: clan.id, kind: "flag_change_started", occurredAt: a.at,
        payload: { texture: a.texture, until: until.toISOString() },
      });
      if (!a.apply) throw DRY;
      return { outcome: "flag-pending" as const, until };
    });
  } catch (e) {
    if (e === DRY) return { outcome: "dry-run", until: null };
    throw e;
  }
}
