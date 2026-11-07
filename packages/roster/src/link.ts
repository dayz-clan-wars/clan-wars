import type { Database } from "@factions/db";
import { bans, factions, factionMembers, identityLinks, servers } from "@factions/db";
import { BAN_ACTIVE_STATUSES, HOLDING_STATUSES, LINK_TTL_MS, LINK_TO_PLAY_LIFT_MS, LINK_TO_PLAY_LIFT_WINDOW_MS, emoteLabel } from "@factions/domain";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import {
  PgVerificationStore, issueChallenge, checkReferral, DRAW_WINDOW_MS, MAX_DRAWS_PER_TARGET,
  type IssueOutcome, type CancelReason,
} from "@factions/verification";
import { and, asc, eq, inArray } from "drizzle-orm";
import { resolveReferrer, referredByFor, type ReferrerRefusal } from "./referral";

export type LinkStep = { token: string; label: string; confirmed: boolean };
/**
 * Where a locked-out gamertag stands with link-to-play, shown beside its open
 * challenge. `lifted`: on the server now, until `until`. `will-lift`: banned,
 * no lift spent today, so the gate lets them on within a ban pass. `lift-used`:
 * banned and today's lift is spent; starting again works after `nextAt`.
 * Null: no `unlinked` ban in play, or another ban is, which a link cannot lift.
 */
export type LinkGate =
  | { kind: "lifted"; until: Date }
  | { kind: "will-lift" }
  | { kind: "lift-used"; nextAt: Date }
  | null;
export type LinkStatus = {
  link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
  /** Who this player was referred by, permanently, or null if nobody. A null gamertag: referred, but no name is known any more. */
  referredBy: { gamertag: string | null } | null;
  challenge: { id: number; targetDayzId: string; gamertag: string; steps: LinkStep[]; confirmed: number; expiresAt: Date; drawsLeft: number; gate: LinkGate } | null;
  /** How the newest challenge ended when the player did not end it themselves; null otherwise. */
  ended: "expired" | CancelReason | null;
};
/** Which surface is starting a link: the bot's `/link start` or the site's link page. */
export type LinkSurface = "bot" | "site";
export type StartLinkOutcome = IssueOutcome | { kind: "referrer-refused"; reason: ReferrerRefusal };
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
  const referredBy = await referredByFor(db, discordId);
  const live = await store.findLiveChallenge(discordId, now);
  if (live) {
    const [attempt, gamertag, drawn, gate] = await Promise.all([
      store.getAttempt(live.id, live.targetDayzId),
      store.playerByDayzId(live.targetDayzId).then((p) => p?.gamertag ?? live.targetDayzId),
      store.countDrawsSince(discordId, live.targetDayzId, new Date(now.getTime() - DRAW_WINDOW_MS)),
      linkGateFor(db, live.targetDayzId, now),
    ]);
    const confirmed = attempt?.progressIndex ?? 0;
    return {
      link, referredBy, ended: null,
      challenge: {
        id: live.id, targetDayzId: live.targetDayzId, gamertag, confirmed, expiresAt: live.expiresAt,
        steps: live.sequence.map((token, i) => ({ token, label: emoteLabel(token) ?? token, confirmed: i < confirmed })),
        drawsLeft: Math.max(0, MAX_DRAWS_PER_TARGET - drawn), gate,
      },
    };
  }
  const latest = await store.latestChallenge(discordId);
  let ended: LinkStatus["ended"] = null;
  if (latest && latest.completedAt === null) {
    if (latest.cancelReason) ended = latest.cancelReason;
    else if (latest.canceledAt === null && latest.expiresAt < now) ended = "expired";
  }
  return { link, referredBy, challenge: null, ended };
}

/**
 * Link-to-play's word to the player, from `bans` (spec §7). Called only beside
 * a LIVE challenge, so "an attempt is open" is given here.
 *
 * ⚠️ Null unless the target's ONLY active ban on a server is `unlinked`: a
 * zone, conduct or hub ban stays after linking, so "start linking to get back
 * on" would be a promise the lift cannot keep. Bans are per server, and this
 * reads every active server (the same set `unlinkDb` walks); with several, any
 * server where the condition holds counts, `lifted` first, then `will-lift`,
 * since being let on somewhere is the better news.
 */
async function linkGateFor(db: Database, dayzId: string, now: Date): Promise<LinkGate> {
  const rows = await db.select({
    serverId: bans.serverId, reason: bans.reason, status: bans.status, bannedAt: bans.bannedAt,
    expiresAt: bans.expiresAt, liftedAt: bans.liftedAt,
  }).from(bans).innerJoin(servers, eq(servers.id, bans.serverId))
    .where(and(eq(bans.dayzId, dayzId), eq(servers.active, true)));
  const byServer = new Map<number, typeof rows>();
  for (const r of rows) byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r]);

  let willLift = false;
  let usedNextAt: Date | null = null;
  for (const mine of byServer.values()) {
    const active = mine.filter((r) =>
      (BAN_ACTIVE_STATUSES as readonly string[]).includes(r.status) && (r.expiresAt === null || r.expiresAt > now));
    if (active.some((r) => r.reason !== "unlinked")) continue;
    const lifts = mine.filter((r) => r.reason === "unlinked" && r.liftedAt !== null).map((r) => r.liftedAt!.getTime());
    const last = lifts.length === 0 ? null : Math.max(...lifts);
    // In force or queued; a lift_pending row is on its way out.
    const banning = active.filter((r) => r.status === "pending" || r.status === "applied");
    // ⚠️ Banned again since the last lift (cancelled, then re-banned, then a
    // new attempt inside the hour): that lift no longer lets them on, so
    // saying "let back on until …" would be false while they are banned.
    const rebanned = last !== null && banning.some((r) => r.bannedAt.getTime() > last);
    if (last !== null && last + LINK_TO_PLAY_LIFT_MS > now.getTime() && !rebanned) {
      return { kind: "lifted", until: new Date(last + LINK_TO_PLAY_LIFT_MS) };
    }
    // A lift_pending row has no lifted_at yet (banTick stamps it): say nothing for that gap rather than guess a time.
    const liftSpent = active.some((r) => r.status === "lift_pending")
      || (last !== null && last + LINK_TO_PLAY_LIFT_WINDOW_MS > now.getTime());
    // The same condition the gate lifts on (linkGateAction): banned, no lift in
    // the window, an attempt live. A pending ban is applied first, then lifted.
    if (banning.length > 0 && !liftSpent) willLift = true;
    if (banning.length > 0 && last !== null && last + LINK_TO_PLAY_LIFT_WINDOW_MS > now.getTime()) {
      const at = new Date(last + LINK_TO_PLAY_LIFT_WINDOW_MS);
      if (usedNextAt === null || at < usedNextAt) usedNextAt = at;
    }
  }
  if (willLift) return { kind: "will-lift" };
  return usedNextAt ? { kind: "lift-used", nextAt: usedNextAt } : null;
}

/**
 * `referrerGamertag`, when given, is resolved and checked BEFORE any
 * challenge is issued — a bad referrer refuses with no
 * `verification_challenges` row ever written. A good one is passed through as
 * `referrerDiscordId`, recorded only if the challenge later completes (spec
 * §4: link-time referrals commit inside the same transaction as the link).
 *
 * ⚠️ `surface` is required, and is the ONLY thing that tells the bot's
 * `/link start` from the site's link page: both issue here with a NULL guild,
 * so the referral's `link_bot`/`link_site` source is written onto the
 * challenge now and read back by `completeChallenge`.
 */
export async function startLinkDb(db: Database, a: {
  discordId: string; targetDayzId: string; newSequence?: boolean; referrerGamertag?: string; surface: LinkSurface;
  now: Date; rng: () => number;
}): Promise<StartLinkOutcome> {
  let referrerDiscordId: string | null = null;
  if (a.referrerGamertag) {
    const ref = await resolveReferrer(db, a.referrerGamertag);
    if (typeof ref === "string") return { kind: "referrer-refused", reason: ref };
    const refusal = await checkReferral(db, { referredDiscordId: a.discordId, referrerDiscordId: ref.discordId });
    if (refusal) return { kind: "referrer-refused", reason: refusal };
    referrerDiscordId = ref.discordId;
  }
  // ⚠️ LINK_TTL_MS, the guide's 24 hours (raised from ten minutes on
  // 2026-09-08: a player who starts on the site need not already be in game).
  return issueChallenge(new PgVerificationStore(db), { rng: a.rng, now: a.now, ttlMs: LINK_TTL_MS }, {
    discordId: a.discordId, targetDayzId: a.targetDayzId, guildId: null, channelId: null, newSequence: a.newSequence,
    referrerDiscordId, referralSource: a.surface === "bot" ? "link_bot" : "link_site",
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
