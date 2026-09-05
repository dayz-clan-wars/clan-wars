import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks, servers } from "@factions/db";
import { HOLDING_STATUSES, LINK_TTL_MS, emoteLabel } from "@factions/domain";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import {
  PgVerificationStore, issueChallenge, DRAW_WINDOW_MS, MAX_DRAWS_PER_TARGET,
  type IssueOutcome, type CancelReason,
} from "@factions/verification";
import { and, asc, eq, inArray } from "drizzle-orm";

export type LinkStep = { token: string; label: string; confirmed: boolean };
export type LinkStatus = {
  link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
  challenge: { id: number; targetDayzId: string; gamertag: string; steps: LinkStep[]; confirmed: number; expiresAt: Date; drawsLeft: number } | null;
  /** How the newest challenge ended when the player did not end it themselves; null otherwise. */
  ended: "expired" | CancelReason | null;
};
export type UnlinkOutcome =
  | { ok: true; releasedBase: boolean }
  | { ok: false; reason: "not-linked" }
  | { ok: false; reason: "in-clan"; clanName: string };

const SEARCH_LIMIT = 10;

/**
 * Everything /link needs to render, in one read. Polled every 5 s while a
 * challenge is open, so it stays a handful of indexed lookups.
 *
 * `confirmed` is the server's count from `challenge_attempts` — never a guess
 * (the page says "the server has confirmed N"). `ended` comes from the newest
 * challenge in any state: expired without an outcome → "expired"; canceled
 * with a reason → that reason; a switch- or self-cancel carries no reason and
 * is not reported, because the player did it.
 */
export async function linkStatusDb(db: Database, discordId: string, now: Date): Promise<LinkStatus> {
  const store = new PgVerificationStore(db);
  const link = await store.findLinkByDiscord(discordId);
  const live = await store.findLiveChallenge(discordId, now);
  if (live) {
    const [attempt, gamertag, drawn] = await Promise.all([
      store.getAttempt(live.id, live.targetDayzId),
      store.playerByDayzId(live.targetDayzId).then((p) => p?.gamertag ?? live.targetDayzId),
      store.countDrawsSince(discordId, live.targetDayzId, new Date(now.getTime() - DRAW_WINDOW_MS)),
    ]);
    const confirmed = attempt?.progressIndex ?? 0;
    return {
      link, ended: null,
      challenge: {
        id: live.id, targetDayzId: live.targetDayzId, gamertag, confirmed, expiresAt: live.expiresAt,
        steps: live.sequence.map((token, i) => ({ token, label: emoteLabel(token) ?? token, confirmed: i < confirmed })),
        drawsLeft: Math.max(0, MAX_DRAWS_PER_TARGET - drawn),
      },
    };
  }
  const latest = await store.latestChallenge(discordId);
  let ended: LinkStatus["ended"] = null;
  if (latest && latest.completedAt === null) {
    if (latest.cancelReason) ended = latest.cancelReason;
    else if (latest.canceledAt === null && latest.expiresAt < now) ended = "expired";
  }
  return { link, challenge: null, ended };
}

export async function startLinkDb(db: Database, a: {
  discordId: string; targetDayzId: string; newSequence?: boolean; now: Date; rng: () => number;
}): Promise<IssueOutcome> {
  // ⚠️ LINK_TTL_MS, the guide's ten minutes — not the bot's 24 h. The site
  // flow assumes the player is already in game (spec §5.5).
  return issueChallenge(new PgVerificationStore(db), { rng: a.rng, now: a.now, ttlMs: LINK_TTL_MS }, {
    discordId: a.discordId, targetDayzId: a.targetDayzId, guildId: null, channelId: null, newSequence: a.newSequence,
  });
}

/** Cancel the caller's live challenge. No reason: they did it, so nobody needs telling. */
export async function cancelLinkDb(db: Database, discordId: string, now: Date): Promise<{ canceled: boolean }> {
  const store = new PgVerificationStore(db);
  const live = await store.findLiveChallenge(discordId, now);
  if (!live) return { canceled: false };
  return { canceled: await store.cancelChallenge(live.id, now) };
}

/**
 * Unlink (spec §5.5): refused while a roster row exists — unlinking a leader
 * would orphan the clan into the frozen state succession exists to prevent —
 * and releases a solo declaration in the same transaction, so a base cannot
 * survive the link that owned it.
 *
 * Order: the identity_links row `FOR UPDATE` first (so two unlinks of one
 * account serialise), then `lockDeclarations` → `releaseTx` (declarations,
 * then poles), then the row delete. identity_links is outside spec §4.12's
 * ordered set; this is safe because no other writer takes an identity_links
 * row lock before the declarations advisory lock — `declareSoloDb` reads the
 * link with a plain SELECT after taking it — so no cycle exists. A future
 * writer that row-locks identity_links must take it before
 * `lockDeclarations`, as here.
 */
export async function unlinkDb(db: Database, discordId: string, now: Date): Promise<UnlinkOutcome> {
  return db.transaction(async (tx) => {
    const [link] = await tx.select({ id: identityLinks.id, dayzId: identityLinks.dayzId })
      .from(identityLinks).where(eq(identityLinks.discordId, discordId)).for("update");
    if (!link) return { ok: false as const, reason: "not-linked" as const };

    const [member] = await tx.select({ clanName: factions.name }).from(factionMembers)
      .innerJoin(factions, eq(factions.id, factionMembers.factionId))
      .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES])))
      .orderBy(asc(factions.id)).limit(1);
    if (member) return { ok: false as const, reason: "in-clan" as const, clanName: member.clanName };

    let releasedBase = false;
    for (const s of await tx.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).orderBy(asc(servers.id))) {
      await lockDeclarations(tx, s.id);
      if (await releaseTx(tx, { dayzId: link.dayzId, serverId: s.id }, now)) releasedBase = true;
    }
    await tx.delete(identityLinks).where(eq(identityLinks.id, link.id));
    return { ok: true as const, releasedBase };
  });
}

/** Autocomplete: unclaimed gamertags the server has seen, by prefix. Empty prefix → nothing. */
export async function searchGamertagsDb(db: Database, prefix: string): Promise<{ dayzId: string; gamertag: string }[]> {
  const q = prefix.trim();
  if (q.length === 0) return [];
  return new PgVerificationStore(db).searchUnlinkedPlayers(q, SEARCH_LIMIT);
}
