import type { Database } from "@factions/db";
import { bounties, identityLinks, playerSessions, players } from "@factions/db";
import {
  BOUNTY_DEADLINE_MS, BOUNTY_DEFAULT_MS, BOUNTY_MAX_MS, BOUNTY_REASON_MAX, onlineMs,
} from "@factions/domain";
import { and, asc, eq, inArray, isNull, or, gt } from "drizzle-orm";
import { activeServerId } from "../server";
import { appendClanNoticeTx } from "./notices";

const HOUR = 3_600_000;

export type PlaceBountyOutcome =
  | { ok: true; bountyId: number; gamertag: string; budgetMs: number }
  | { ok: false; reason: "unknown-player" | "already-open" | "bad-hours" | "no-reason" | "reason-too-long" };

/** True when `err` (or its `.cause`, one level) names the given Postgres constraint. */
function violatesConstraint(err: unknown, name: string): boolean {
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } } | undefined;
  return e?.constraint_name === name || e?.cause?.constraint_name === name;
}

/**
 * Put a bounty on a player (spec 2026-09-23-bounties §4.2). Admin-only; the gate is
 * the command's, because this is reachable only through `@factions/roster/internal`.
 *
 * ⚠️ ONE transaction for the bounty and its DM, `bounties` then `clan_notices`.
 * The public "wanted" post is NOT written here: the poster reads the row, so a
 * failed Discord call can never roll back the bounty or lose the post.
 */
export async function placeBountyDb(db: Database, a: {
  targetDayzId: string; reason: string; hours: number | null; adminDiscordId: string; now: Date;
}): Promise<PlaceBountyOutcome> {
  const reason = a.reason.trim();
  if (!reason) return { ok: false, reason: "no-reason" };
  if (reason.length > BOUNTY_REASON_MAX) return { ok: false, reason: "reason-too-long" };
  const budgetMs = a.hours === null ? BOUNTY_DEFAULT_MS : a.hours * HOUR;
  if (!Number.isInteger(a.hours ?? 1) || budgetMs < HOUR || budgetMs > BOUNTY_MAX_MS) return { ok: false, reason: "bad-hours" };

  const [target] = await db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, a.targetDayzId));
  if (!target) return { ok: false, reason: "unknown-player" };
  const serverId = await activeServerId(db);
  const [link] = await db.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, a.targetDayzId));

  try {
    const bountyId = await db.transaction(async (tx) => {
      const [row] = await tx.insert(bounties).values({
        serverId, targetDayzId: a.targetDayzId, reason, placedByDiscordId: a.adminDiscordId,
        placedAt: a.now, onlineBudgetMs: budgetMs, deadlineAt: new Date(a.now.getTime() + BOUNTY_DEADLINE_MS),
      }).returning({ id: bounties.id });
      if (link) {
        await appendClanNoticeTx(tx, {
          serverId, factionId: null, target: "dm", discordTargetId: link.discordId, kind: "bounty_placed", occurredAt: a.now,
          // ⚠️ No position, ever: `clan_notices_no_coordinates` rejects one, and the map is where it lives.
          payload: { bountyId: row!.id, reason, hours: Math.round(budgetMs / HOUR) },
        });
      }
      return row!.id;
    });
    return { ok: true, bountyId, gamertag: target.gamertag, budgetMs };
  } catch (err) {
    // ⚠️ The partial unique index is the one-open-bounty rule; a pre-check would race it.
    // postgres.js can surface the violation either directly or nested in `.cause` —
    // check both, or a driver-version shuffle turns this into an unhandled 500.
    if (violatesConstraint(err, "bounties_one_open_uniq")) {
      return { ok: false, reason: "already-open" };
    }
    throw err;
  }
}

/**
 * Lift an open bounty. `FOR UPDATE` then a status check, so a revoke racing the tick's
 * claim either lands first or reports "ended". It never overwrites a claim.
 */
export async function revokeBountyDb(db: Database, a: { bountyId: number; adminDiscordId: string; now: Date }):
  Promise<{ ok: true } | { ok: false; reason: "not-found" | "ended" }> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bounties).where(eq(bounties.id, a.bountyId)).for("update");
    if (!b) return { ok: false, reason: "not-found" } as const;
    if (b.status !== "open") return { ok: false, reason: "ended" } as const;
    await tx.update(bounties).set({ status: "revoked", closedAt: a.now, revokedByDiscordId: a.adminDiscordId })
      .where(eq(bounties.id, a.bountyId));
    const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, b.targetDayzId));
    if (link) {
      await appendClanNoticeTx(tx, {
        serverId: b.serverId, factionId: null, target: "dm", discordTargetId: link.discordId,
        kind: "bounty_revoked", occurredAt: a.now, payload: { bountyId: b.id },
      });
    }
    return { ok: true } as const;
  });
}

export type OpenBounty = {
  id: number; targetDayzId: string; gamertag: string; reason: string;
  placedAt: Date; deadlineAt: Date; budgetMs: number; servedMs: number;
};

/** Open bounties, oldest first, for `/bounty list` and revoke's autocomplete. At most 25, Discord's choice limit. */
export async function openBountiesDb(db: Database, now: Date): Promise<OpenBounty[]> {
  const rows = await db.select({ b: bounties, gamertag: players.gamertag }).from(bounties)
    .leftJoin(players, eq(players.dayzId, bounties.targetDayzId))
    .where(eq(bounties.status, "open")).orderBy(asc(bounties.id)).limit(25);
  if (rows.length === 0) return [];
  const sessions = await db.select().from(playerSessions).where(and(
    inArray(playerSessions.dayzId, rows.map((r) => r.b.targetDayzId)),
    or(isNull(playerSessions.disconnectedAt), gt(playerSessions.disconnectedAt, rows.reduce((m, r) => r.b.placedAt < m ? r.b.placedAt : m, rows[0]!.b.placedAt))),
  ));
  return rows.map(({ b, gamertag }) => ({
    id: b.id, targetDayzId: b.targetDayzId, gamertag: gamertag ?? b.targetDayzId, reason: b.reason,
    placedAt: b.placedAt, deadlineAt: b.deadlineAt, budgetMs: b.onlineBudgetMs,
    servedMs: onlineMs(
      sessions.filter((s) => s.serverId === b.serverId && s.dayzId === b.targetDayzId).map((s) => ({ from: s.connectedAt, to: s.disconnectedAt })),
      b.placedAt, now,
    ),
  }));
}
