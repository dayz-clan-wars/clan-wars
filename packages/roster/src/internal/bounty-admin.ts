import type { Database } from "@factions/db";
import { bounties, identityLinks, playerSessions, players } from "@factions/db";
import {
  BOUNTY_DEADLINE_MS, BOUNTY_DEFAULT_MS, BOUNTY_MAX_MS, BOUNTY_REASON_MAX, onlineMs,
} from "@factions/domain";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { activeServerId } from "../server";
import { appendClanNoticeTx } from "./notices";

const HOUR = 3_600_000;

export type PlaceBountyOutcome =
  | { ok: true; bountyId: number; gamertag: string; budgetMs: number }
  | { ok: false; reason: "unknown-player" | "ambiguous-player" | "already-open" | "bad-hours" | "no-reason" | "reason-too-long" };

/** Discord's choice limit: an autocomplete answer longer than this is rejected whole. */
const TARGET_SEARCH_LIMIT = 25;

/**
 * `/bounty place`'s autocomplete: every character the log has seen, by gamertag
 * prefix, most recently seen first.
 *
 * ⚠️ NOT `searchGamertags`. That is `/link`'s search and returns only UNLINKED
 * characters — right for linking, wrong here: it hid every linked player from
 * `/bounty place` in production (2026-09-23), and the players an admin most often
 * needs to punish are linked. Spec §2.2: any player the log has seen.
 */
export async function searchBountyTargetsDb(db: Database, prefix: string): Promise<{ dayzId: string; gamertag: string }[]> {
  const q = prefix.trim();
  if (q.length === 0) return [];
  // ⚠️ Escape LIKE's metacharacters so a typed "%" or "_" matches itself, not everyone.
  const literal = q.slice(0, 64).replace(/[\\%_]/gu, (c) => `\\${c}`);
  return db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players)
    .where(ilike(players.gamertag, `${literal}%`))
    .orderBy(desc(players.lastSeenAt), desc(players.dayzId))
    .limit(TARGET_SEARCH_LIMIT);
}

/**
 * The character `target` names: a DayZ id (what an autocomplete choice sends), or
 * else a gamertag typed out in full, matched case-insensitively.
 *
 * ⚠️ The gamertag fallback is not optional. When an admin types a name and sends
 * without picking a choice, Discord delivers the raw text as the option's value;
 * without this, a correctly spelled name reads as "never seen".
 */
async function resolveTarget(db: Database, target: string):
  Promise<{ dayzId: string; gamertag: string } | "unknown-player" | "ambiguous-player"> {
  const t = target.trim();
  const [byId] = await db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players).where(eq(players.dayzId, t));
  if (byId) return byId;
  const byName = await db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players)
    .where(sql`lower(${players.gamertag}) = lower(${t})`).limit(2);
  // Two characters have carried this name: refuse rather than punish the wrong one.
  if (byName.length > 1) return "ambiguous-player";
  return byName[0] ?? "unknown-player";
}

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
  /** A DayZ id from the autocomplete, or a gamertag typed in full. */
  target: string; reason: string; hours: number | null; adminDiscordId: string; now: Date;
}): Promise<PlaceBountyOutcome> {
  const reason = a.reason.trim();
  if (!reason) return { ok: false, reason: "no-reason" };
  if (reason.length > BOUNTY_REASON_MAX) return { ok: false, reason: "reason-too-long" };
  const budgetMs = a.hours === null ? BOUNTY_DEFAULT_MS : a.hours * HOUR;
  if (!Number.isInteger(a.hours ?? 1) || budgetMs < HOUR || budgetMs > BOUNTY_MAX_MS) return { ok: false, reason: "bad-hours" };

  const target = await resolveTarget(db, a.target);
  if (typeof target === "string") return { ok: false, reason: target };
  const serverId = await activeServerId(db);
  const [link] = await db.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, target.dayzId));

  try {
    const bountyId = await db.transaction(async (tx) => {
      const [row] = await tx.insert(bounties).values({
        serverId, targetDayzId: target.dayzId, reason, placedByDiscordId: a.adminDiscordId,
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
