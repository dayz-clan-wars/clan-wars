import type { Database } from "@factions/db";
import { factions, identityLinks, factionMembers } from "@factions/db";
import {
  ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_TAG_LENGTH, HOLDING_STATUSES, PENDING_EXPIRY_MS, REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS,
  RENAME_COOLDOWN_MS, ROSTER_COOLDOWN_MS, isClaimableFlag,
} from "@factions/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  PgRosterStore, PgFactionStore, PgRebindStore, selectCandidates, requestJoinDb, decideRequestDb, withdrawRequestDb, siteBaseUrl,
  type CreateInviteOutcome, type AcceptInviteOutcome, type KickOutcome, type LeaveOutcome, type SetRoleOutcome, type TransferOutcome, type RenameOutcome,
  type RequestJoinOutcome, type DecideRequestOutcome,
} from "./internal";
import { actorFor, isRefusal, type ActorRefusal } from "./actor";

export type ReserveOutcome = Awaited<ReturnType<PgFactionStore["reserve"]>>;
const TAG_RE = /^[A-Za-z0-9]+$/u;
export const validName = (s: string) => s.trim().length >= CLAN_NAME_LENGTH.min && s.trim().length <= CLAN_NAME_LENGTH.max;
export const validTag = (s: string) => s.length >= CLAN_TAG_LENGTH.min && s.length <= CLAN_TAG_LENGTH.max && TAG_RE.test(s);

/**
 * A gamertag resolved to its linked Discord account — the ONLY place a
 * gamertag maps to a Discord id, since gamertag has no unique index. Tries
 * an exact-case match first; only falls back to case-insensitive (and only
 * there risks ambiguity) if the exact match misses. Shared by `inviteDb`
 * (the site has no Discord user picker) and `grantGuestPassDbFor`'s
 * gamertag form for the same reason.
 */
export async function resolveGamertagLink(db: Database, gamertag: string): Promise<{ dayzId: string; discordId: string } | "ambiguous-gamertag" | null> {
  const cols = { dayzId: identityLinks.dayzId, discordId: identityLinks.discordId };
  const exact = await db.select(cols).from(identityLinks).where(eq(identityLinks.gamertag, gamertag)).limit(2);
  if (exact.length === 1) return exact[0]!;
  const ci = await db.select(cols).from(identityLinks)
    .where(sql`lower(${identityLinks.gamertag}) = lower(${gamertag})`).limit(2);
  if (ci.length > 1) return "ambiguous-gamertag";
  return ci[0] ?? null;
}

export type InviteOutcome = CreateInviteOutcome | ActorRefusal | "not-permitted" | "invitee-not-linked" | "ambiguous-gamertag";
export type InviteeRef = { discordId: string } | { gamertag: string };
export async function inviteDb(db: Database, now: Date, actorDiscordId: string, invitee: InviteeRef): Promise<{ outcome: InviteOutcome; inviteId: number | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, inviteId: null };
  let link: { dayzId: string; discordId: string } | null;
  if ("discordId" in invitee) {
    const cols = { dayzId: identityLinks.dayzId, discordId: identityLinks.discordId };
    const [row] = await db.select(cols).from(identityLinks).where(eq(identityLinks.discordId, invitee.discordId));
    link = row ?? null;
  } else {
    const resolved = await resolveGamertagLink(db, invitee.gamertag);
    if (resolved === "ambiguous-gamertag") return { outcome: "ambiguous-gamertag", inviteId: null };
    link = resolved;
  }
  if (!link) return { outcome: "invitee-not-linked", inviteId: null };
  return new PgRosterStore(db).createInvite({
    factionId: a.factionId, serverId: a.serverId, inviteeDiscordId: link.discordId, inviteeDayzId: link.dayzId, invitedByDiscordId: a.discordId,
    at: now, expiresAt: new Date(now.getTime() + PENDING_EXPIRY_MS), siteBaseUrl: siteBaseUrl(),
  });
}
export async function revokeInviteDb(db: Database, now: Date, actorDiscordId: string, inviteId: number) {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).revokeInvite({ inviteId, factionId: a.factionId, actorDiscordId, at: now });
}
export async function acceptInviteDb(db: Database, now: Date, discordId: string, inviteId: number): Promise<AcceptInviteOutcome | "not-linked"> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  return new PgRosterStore(db).acceptInvite(inviteId, discordId, now);
}
export const declineInviteDb = (db: Database, now: Date, discordId: string, inviteId: number) => new PgRosterStore(db).declineInvite(inviteId, discordId, now);

export async function requestJoinDbByTag(db: Database, now: Date, discordId: string, tag: string): Promise<{ outcome: RequestJoinOutcome | "not-linked" | "no-such-clan"; requestId: number | null }> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return { outcome: "not-linked", requestId: null };
  const [clan] = await db.select({ id: factions.id, serverId: factions.serverId }).from(factions)
    .where(and(eq(sql`lower(${factions.tag})`, tag.toLowerCase()), inArray(factions.status, [...HOLDING_STATUSES])));
  if (!clan) return { outcome: "no-such-clan", requestId: null };
  return requestJoinDb(db, { factionId: clan.id, serverId: clan.serverId, dayzId: link.dayzId, discordId, at: now, expiresAt: new Date(now.getTime() + PENDING_EXPIRY_MS) });
}
export const withdrawRequestDbFor = (db: Database, now: Date, discordId: string, requestId: number) => withdrawRequestDb(db, requestId, discordId, now);
export async function decideRequestDbFor(db: Database, now: Date, actorDiscordId: string, requestId: number, decision: "accepted" | "declined"): Promise<DecideRequestOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return decideRequestDb(db, { requestId, actorDiscordId, decision, at: now });
}

/** Any roster row may leave, pending included — actorFor's "pending" refusal is bypassed on purpose here. */
export async function leaveDb(db: Database, now: Date, discordId: string): Promise<LeaveOutcome | "not-in-clan"> {
  const [m] = await db.select({ factionId: factionMembers.factionId }).from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES]))).limit(1);
  if (!m) return "not-in-clan";
  return new PgRosterStore(db).leave({ factionId: m.factionId, discordId, at: now, until: new Date(now.getTime() + ROSTER_COOLDOWN_MS) });
}
export async function kickDb(db: Database, now: Date, actorDiscordId: string, targetDiscordId: string): Promise<KickOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).kick({ factionId: a.factionId, actorDiscordId, targetDiscordId, at: now, until: new Date(now.getTime() + ROSTER_COOLDOWN_MS) });
}
async function setRoleDb(db: Database, actorDiscordId: string, targetDiscordId: string, role: "officer" | "member"): Promise<SetRoleOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).setRole({ factionId: a.factionId, actorDiscordId, targetDiscordId, role });
}
export const promoteDb = (db: Database, actorDiscordId: string, targetDiscordId: string) => setRoleDb(db, actorDiscordId, targetDiscordId, "officer");
export const demoteDb = (db: Database, actorDiscordId: string, targetDiscordId: string) => setRoleDb(db, actorDiscordId, targetDiscordId, "member");
export async function transferDb(db: Database, now: Date, actorDiscordId: string, targetDiscordId: string): Promise<TransferOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).transfer({ factionId: a.factionId, fromDiscordId: actorDiscordId, toDiscordId: targetDiscordId, at: now });
}
export async function disbandDb(db: Database, actorDiscordId: string): Promise<"ok" | "not-leader" | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).disband(a.factionId, actorDiscordId);
}
export async function renameDb(db: Database, now: Date, actorDiscordId: string, r: { name: string; tag?: string }): Promise<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag"> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  if (!validName(r.name)) return "bad-name";
  if (r.tag !== undefined && !validTag(r.tag)) return "bad-tag";
  return new PgRosterStore(db).rename({ factionId: a.factionId, discordId: actorDiscordId, name: r.name.trim(), tag: r.tag, at: now, notBefore: new Date(now.getTime() - RENAME_COOLDOWN_MS) });
}
export async function setRecruitingPostDb(db: Database, actorDiscordId: string, post: { recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }) {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).setRecruitingPost({ factionId: a.factionId, actorDiscordId, ...post });
}

/**
 * The claim (spec §5.1; guide ch. 3): name, tag, flag, and the roster pruned
 * to real participants. The claimant becomes leader and must be on the
 * roster. `reserve` writes the declaration citing the ceremony, so the 200 m
 * refusal happens here, where the guide says it does.
 */
export async function claimCeremonyDb(db: Database, now: Date, discordId: string, ceremonyId: number, a: { name: string; tag: string; texture: string; memberDayzIds: string[] }):
  Promise<ReserveOutcome | "not-linked" | "no-such-ceremony" | "bad-name" | "bad-tag" | "bad-flag" | "bad-roster"> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  const store = new PgFactionStore(db);
  const ceremony = await store.openCeremonyByIdFor(ceremonyId, discordId);
  if (!ceremony) return "no-such-ceremony";
  if (!validName(a.name)) return "bad-name";
  if (!validTag(a.tag)) return "bad-tag";
  if (!isClaimableFlag(a.texture)) return "bad-flag";
  const chosen = ceremony.participants.filter((p) => a.memberDayzIds.includes(p.dayzId));
  if (chosen.length !== a.memberDayzIds.length || !chosen.some((p) => p.dayzId === link.dayzId)) return "bad-roster";
  return store.reserve({
    ceremonyId, serverId: ceremony.serverId, poleKey: ceremony.poleKey, x: ceremony.x, y: ceremony.y, z: ceremony.z,
    name: a.name.trim(), tag: a.tag, texture: a.texture, leaderDiscordId: discordId,
    members: chosen.map((p) => ({ dayzId: p.dayzId, discordId: p.discordId })),
    at: now, reservedUntil: new Date(now.getTime() + ACTIVATION_WINDOW_MS),
  });
}

/**
 * The leader confirms a move (guide ch. 8: within 24 h of the raise —
 * REBIND_CONFIRM_MS, not the bot command's shorter 1 h window). The same
 * window is passed to `selectCandidates` as `qualifyingRaises` is fetched
 * with, so the freshness filter inside `selectCandidates` does not silently
 * re-narrow the 24 h the site promises.
 */
export async function confirmRebindDb(db: Database, now: Date, actorDiscordId: string, poleKey: string): Promise<"ok" | "refused" | "too-close" | "no-candidate" | "not-leader" | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  if (a.role !== "leader") return "not-leader";
  const store = new PgRebindStore(db);
  const clan = await store.factionFor(a.factionId);
  if (!clan || clan.poleKey === null) return "refused";
  const raises = await store.qualifyingRaises(clan, new Date(now.getTime() - REBIND_CONFIRM_MS));
  const candidate = selectCandidates(raises, { currentPoleKey: clan.poleKey, now, windowMs: REBIND_CONFIRM_MS }).find((c) => c.poleKey === poleKey);
  if (!candidate) return "no-candidate";
  return store.rebind({
    factionId: a.factionId, leaderDiscordId: actorDiscordId, expectedPoleKey: clan.poleKey,
    poleKey: candidate.poleKey, x: candidate.x, y: candidate.y, z: candidate.z, evidenceEventId: candidate.eventId,
    at: now, notBefore: new Date(now.getTime() - REBIND_COOLDOWN_MS),
  });
}
