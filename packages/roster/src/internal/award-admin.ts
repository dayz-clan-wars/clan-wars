import type { Database } from "@factions/db";
import { awardGrants, boosterKitChallenges, servers } from "@factions/db";
import { AWARD_PLACE_BY_MS, awardState, isOpenAward, type AwardState } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { and, desc, eq, isNull } from "drizzle-orm";
import { appendClanNoticeTx } from "./notices";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type GrantAwardOutcome =
  | { ok: true; grantId: number; placeBy: Date }
  | { ok: false; reason: "unknown-award" | "no-reason" | "no-server" };

/**
 * The grant and its DM, inside a caller's transaction — for King of the Hill,
 * which must lock its own row first so a retry cannot grant twice (lock order:
 * koth_events → award_grants → clan_notices).
 */
export async function grantAwardTx(tx: Tx, a: {
  awardKey: string; winnerDiscordId: string; grantedByDiscordId: string; reason: string; siteBaseUrl: string; now: Date; serverId: number;
}): Promise<GrantAwardOutcome> {
  const def = awardsCatalogue()[a.awardKey];
  if (!def) return { ok: false, reason: "unknown-award" };
  const reason = a.reason.trim();
  if (!reason) return { ok: false, reason: "no-reason" };
  const placeBy = new Date(a.now.getTime() + AWARD_PLACE_BY_MS);
  const [row] = await tx.insert(awardGrants).values({
    awardKey: def.key, discordId: a.winnerDiscordId, grantedByDiscordId: a.grantedByDiscordId,
    reason, grantedAt: a.now, placeBy, updatedAt: a.now,
  }).returning({ id: awardGrants.id });
  await appendClanNoticeTx(tx, {
    serverId: a.serverId, factionId: null, target: "dm", discordTargetId: a.winnerDiscordId,
    kind: "award_granted", occurredAt: a.now,
    payload: { grantId: row!.id, awardKey: def.key, label: def.label, reason, placeBy: placeBy.toISOString(), awardUrl: `${a.siteBaseUrl}/awards/${row!.id}` },
  });
  return { ok: true, grantId: row!.id, placeBy };
}

/**
 * Hand an event winner an award (spec §4.1). Admin-only; the gate is the
 * command's, because this is reachable only through `@factions/roster/internal`.
 *
 * ⚠️ ONE transaction for the grant and its DM, `award_grants` then
 * `clan_notices`, in the lock order (CLAUDE.md). A grant with no DM is a prize
 * nobody hears about; a DM with no grant links to a 404.
 *
 * ⚠️ The key is checked against the committed catalogue HERE, not only by the
 * command's choices: this is the write, and a key the catalogue does not know
 * is a grant the page cannot render and the worker cannot spawn.
 */
export async function grantAwardDb(db: Database, a: {
  awardKey: string; winnerDiscordId: string; grantedByDiscordId: string; reason: string; siteBaseUrl: string; now: Date;
}): Promise<GrantAwardOutcome> {
  // ⚠️ `clan_notices.server_id` is NOT NULL, so the DM needs a server even
  // though an award belongs to no clan. The one active server, picked the way
  // `/airdrop place` picks it.
  const [server] = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1);
  if (!server) return { ok: false, reason: "no-server" };
  return db.transaction((tx) => grantAwardTx(tx, { ...a, serverId: server.id }));
}

export type RevokeAwardOutcome = { ok: true } | { ok: false; reason: "not-found" | "ended" };

/**
 * Revoke one grant, and close any sequence open for it.
 *
 * ⚠️ `award_grants` FOR UPDATE first, then the challenge — the SAME order
 * `kitPlacementTick` takes them in. Postgres makes an UPDATE wait for a row
 * another transaction holds, never skip it, so the opposite order in either
 * place is a deadlock between a revoke and a winner's last emote.
 */
export async function revokeAwardDb(db: Database, a: { grantId: number; now: Date }): Promise<RevokeAwardOutcome> {
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(awardGrants).where(eq(awardGrants.id, a.grantId)).for("update");
    if (!g) return { ok: false, reason: "not-found" } as const;
    if (!isOpenAward(awardState(g, a.now))) return { ok: false, reason: "ended" } as const;
    await tx.update(awardGrants).set({ revokedAt: a.now, updatedAt: a.now }).where(eq(awardGrants.id, a.grantId));
    await tx.update(boosterKitChallenges).set({ closedAt: a.now })
      .where(and(eq(boosterKitChallenges.awardGrantId, a.grantId), isNull(boosterKitChallenges.closedAt)));
    return { ok: true } as const;
  });
}

export type AwardListRow = {
  id: number; awardKey: string; label: string; discordId: string; reason: string;
  state: AwardState; placeBy: Date; expiresAt: Date | null;
};

/**
 * Open grants, for `/award list` and `/award revoke`'s autocomplete. At most
 * 25 — Discord's choice limit, and more open prizes than any event needs.
 *
 * ⚠️ Filtered in code by `awardState`, not in SQL: the state rule has one
 * statement, and a WHERE clause would be a second.
 */
export async function listAwardsDb(db: Database, a: { discordId: string | null; now: Date }): Promise<AwardListRow[]> {
  const rows = await db.select().from(awardGrants)
    .where(and(isNull(awardGrants.revokedAt), a.discordId ? eq(awardGrants.discordId, a.discordId) : undefined))
    .orderBy(desc(awardGrants.id)).limit(200);
  const catalogue = awardsCatalogue();
  return rows
    .map((g) => ({
      id: g.id, awardKey: g.awardKey, label: catalogue[g.awardKey]?.label ?? g.awardKey, discordId: g.discordId,
      reason: g.reason, state: awardState(g, a.now), placeBy: g.placeBy, expiresAt: g.expiresAt,
    }))
    .filter((r) => isOpenAward(r.state))
    .slice(0, 25);
}

/**
 * Revoke every open grant a departing member holds, inside the removal's own
 * transaction. Returns how many.
 *
 * ⚠️ `revoked_at IS NULL` only, so a redelivered `guildMemberRemove` finds
 * nothing and a grant's first revocation time is never overwritten.
 */
export async function revokeAwardsForTx(tx: Tx, discordId: string, at: Date): Promise<number> {
  const gone = await tx.update(awardGrants).set({ revokedAt: at, updatedAt: at })
    .where(and(eq(awardGrants.discordId, discordId), isNull(awardGrants.revokedAt)))
    .returning({ id: awardGrants.id });
  for (const g of gone) {
    await tx.update(boosterKitChallenges).set({ closedAt: at })
      .where(and(eq(boosterKitChallenges.awardGrantId, g.id), isNull(boosterKitChallenges.closedAt)));
  }
  return gone.length;
}
