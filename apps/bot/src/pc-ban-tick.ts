import type { Database } from "@factions/db";
import { bans, identityLinks, playerDevices, verificationChallenges } from "@factions/db";
import { pcGateAction } from "@factions/domain";
import { and, eq, gt, isNull } from "drizzle-orm";

export type PcBanTickResult = {
  banned: { dayzId: string; gamertag: string }[];
  lifted: { dayzId: string; gamertag: string }[];
};

/** Ban statuses that mean "this ban is in force or on its way out" — not a reason to write another. */
const ACTIVE = ["pending", "applied", "lift_pending"] as const;

/**
 * Bans PC players who have not linked, and opens the door once when they
 * start to.
 *
 * ⚠️ This tick NEVER calls Nitrado. It writes `bans` rows and lift requests;
 * `banTick` is the only thing that talks to the ban list, and its reference
 * counting is what stops a PC ban freeing an account that also has a zone ban.
 *
 * ⚠️ Level-triggered, like the truck wipe and the raid window: every pass
 * recomputes what should be true rather than reacting to an edge. That is
 * what makes a lost lift self-heal, and it is why an expired challenge needs
 * no code of its own to produce a fresh ban.
 *
 * ⚠️ Candidates come from `player_devices`, which fills ONLY as accounts
 * connect. Backfilling that table from retained RPT files turns this into a
 * retroactive sweep over everyone ever seen — see the design doc §6.
 */
export async function pcBanTick(db: Database, opts: { serverId: number; now?: Date }): Promise<PcBanTickResult> {
  const now = opts.now ?? new Date();
  const out: PcBanTickResult = { banned: [], lifted: [] };

  // Everyone ever seen on desktop. Small by nature — 7 accounts in the first
  // three days of retained logs — and it only grows as PC players arrive.
  const candidates = await db.select({ dayzId: playerDevices.dayzId, gamertag: playerDevices.gamertag })
    .from(playerDevices).where(eq(playerDevices.device, "desktop"));

  for (const c of candidates) {
    const [link] = await db.select({ id: identityLinks.id }).from(identityLinks).where(eq(identityLinks.dayzId, c.dayzId));

    const [open] = await db.select({ id: verificationChallenges.id }).from(verificationChallenges).where(and(
      eq(verificationChallenges.targetDayzId, c.dayzId),
      isNull(verificationChallenges.completedAt),
      isNull(verificationChallenges.canceledAt),
      gt(verificationChallenges.expiresAt, now),
    ));

    const mine = await db.select({ id: bans.id, status: bans.status }).from(bans).where(and(
      eq(bans.serverId, opts.serverId),
      eq(bans.dayzId, c.dayzId),
      eq(bans.reason, "unlinked_pc"),
    ));

    const active = mine.find((b) => (ACTIVE as readonly string[]).includes(b.status));
    // ⚠️ "Has had its lift" is derived from the ban history, not a column: any
    // row that ever reached lift_pending or lifted spent this account's one
    // chance, for all time.
    const liftSpent = mine.some((b) => b.status === "lift_pending" || b.status === "lifted");

    const action = pcGateAction({
      seenOnDesktop: true,
      linked: Boolean(link),
      challengeOpen: Boolean(open),
      activeBan: Boolean(active),
      liftSpent,
    });

    if (action === "ban") {
      await db.insert(bans).values({
        serverId: opts.serverId,
        dayzId: c.dayzId,
        gamertag: c.gamertag,
        bannedAt: now,
        // ⚠️ Permanent. This is not a sentence to serve; it is a door that
        // opens when they link.
        expiresAt: null,
        status: "pending",
        reason: "unlinked_pc",
      });
      out.banned.push(c);
    } else if (action === "lift" && active) {
      await db.update(bans).set({ status: "lift_pending" }).where(eq(bans.id, active.id));
      out.lifted.push(c);
    }
  }

  return out;
}
