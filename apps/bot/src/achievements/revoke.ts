import type { AchievementKey } from "@factions/domain";
import { achievementProgress, achievementUnlocks, type Database } from "@factions/db";
import { and, eq, inArray } from "drizzle-orm";
import { PVP_RULES } from "./rules-pvp.js";

/**
 * The achievements a discredited kill can have earned (spec 2026-09-22-hub-combat §2.8).
 *
 * ⚠️ Kill-derived rules ONLY. Re-running a position- or pin-based rule today
 * reads data the reaper has already deleted (POSITION_RETENTION_MS), comes
 * back "not earned", and would revoke a badge that was fairly won. Pinned by
 * revoke.test.ts: every key here is a PvP rule, and none of the three PvP
 * rules that do not read `kills` scoring is here.
 */
export const REVOCABLE_KEYS = [
  "first_blood", "ten_down", "centurion", "marksman", "sniper", "point_blank",
  "arsenal", "hat_trick", "killing_spree", "unstoppable", "nemesis", "payback",
] as const satisfies readonly AchievementKey[];

export type RevokeResult = { owners: number; revoked: { ownerId: string; key: string }[]; redated: { ownerId: string; key: string }[]; failed: number };

const unlockOf = (ownerId: string, key: string) =>
  and(eq(achievementUnlocks.ownerKind, "player"), eq(achievementUnlocks.ownerId, ownerId), eq(achievementUnlocks.key, key));

/**
 * Re-run the kill-derived rules for every player holding one of their badges.
 * A badge that no longer holds is deleted, silently (spec §2.8). A badge that
 * still holds but was earned at a different kill is re-dated to it: the kill
 * rebuild renumbers `kills.id`, so every kept badge's evidence id is stale anyway.
 */
export async function revokeAchievements(db: Database, opts: { apply: boolean; now?: Date; onError?: (ownerId: string, key: string, err: unknown) => void }): Promise<RevokeResult> {
  const now = opts.now ?? new Date();
  const out: RevokeResult = { owners: 0, revoked: [], redated: [], failed: 0 };
  const rows = await db.select().from(achievementUnlocks)
    .where(and(eq(achievementUnlocks.ownerKind, "player"), inArray(achievementUnlocks.key, [...REVOCABLE_KEYS])));
  const byOwner = new Map<string, typeof rows>();
  for (const r of rows) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r]);

  for (const [ownerId, held] of byOwner) {
    out.owners++;
    for (const u of held) {
      const key = u.key as AchievementKey;
      let r;
      // ⚠️ A throw is NOT "no longer earned": skip, count, report. Treating it as
      // a revocation would strip every badge on one bad query.
      try { r = await PVP_RULES[key]!(db, { kind: "player", id: ownerId }, { now }); }
      catch (err) { out.failed++; opts.onError?.(ownerId, key, err); continue; }

      const earned = r.earnedAt !== undefined && r.count >= r.target;
      if (!earned) {
        out.revoked.push({ ownerId, key });
        if (opts.apply) await db.transaction(async (tx) => {
          // Lock order (CLAUDE.md): achievement_unlocks → achievement_progress.
          await tx.delete(achievementUnlocks).where(unlockOf(ownerId, key));
          await tx.insert(achievementProgress).values({ ownerKind: "player", ownerId, key, count: r.count, target: r.target, computedAt: now })
            .onConflictDoUpdate({ target: [achievementProgress.ownerKind, achievementProgress.ownerId, achievementProgress.key], set: { count: r.count, target: r.target, computedAt: now } });
        });
      } else if (r.earnedAt!.getTime() !== u.earnedAt.getTime() || (r.evidenceId ?? null) !== u.evidenceId) {
        out.redated.push({ ownerId, key });
        if (opts.apply) await db.update(achievementUnlocks)
          .set({ earnedAt: r.earnedAt!, evidenceId: r.evidenceId ?? null, evidence: r.evidence ?? {} })
          .where(unlockOf(ownerId, key));
      }
    }
  }
  return out;
}
