import type { Database } from "@factions/db";
import {
  ceremonies, factionJoinRequests, factionMembers, factions, identityLinks, players, rosterCooldowns,
} from "@factions/db";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { CLAIMABLE_FLAGS, CLAN_SIZE_CAP, HOLDING_STATUSES, REBIND_CONFIRM_MS, type MemberStatus } from "@factions/domain";
import {
  PgFactionStore, PgRebindStore, PgRosterStore, openRequestsFor, requestsBy, selectCandidates,
  type JoinRequest, type Role,
} from "./internal";
import { activeServerId } from "./server";

const HOLDING: string[] = [...HOLDING_STATUSES];

export type RosterRow = {
  dayzId: string; discordId: string; gamertag: string | null; role: Role; status: MemberStatus;
  joinedAt: Date; lastSeenAt: Date | null;
};

export type ClanView = {
  clan: {
    id: number; name: string; tag: string; texture: string; status: string;
    createdAt: Date; activatedAt: Date | null; recruiting: boolean;
    playWindow: string | null; language: string | null; pitch: string | null;
  };
  me: { role: Role; status: MemberStatus };
  roster: RosterRow[];
  invitesOut: Awaited<ReturnType<PgRosterStore["invitesOut"]>>;
  requestsIn: JoinRequest[];
  rebindCandidates: { poleKey: string; raisedAt: Date; by: string }[];
};

export type DirectoryEntry = {
  tag: string; name: string; texture: string; status: string; memberCount: number;
  recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null;
};

export type ClanPage = DirectoryEntry & {
  createdAt: Date;
  roster: { gamertag: string | null; role: Role }[];
  canRequest: "yes" | "not-linked" | "in-clan" | "not-recruiting" | "cooldown" | "cap" | "already-requested";
};

export type ClaimContext = {
  ceremony: { id: number; detectedAt: Date; expiresAt: Date; participants: { dayzId: string; gamertag: string; discordId: string }[] };
  freeFlags: string[];
} | null;

/**
 * `rosterOf` has no lastSeenAt of its own (it's a membership fact, not a
 * presence one) — joined in here from `players` so a leader can see who has
 * gone quiet without a second page.
 */
async function rosterWithLastSeen(db: Database, factionId: number): Promise<RosterRow[]> {
  const entries = await new PgRosterStore(db).rosterOf(factionId);
  if (entries.length === 0) return [];
  const seenRows = await db.select({ dayzId: players.dayzId, lastSeenAt: players.lastSeenAt })
    .from(players).where(inArray(players.dayzId, entries.map((e) => e.dayzId)));
  const seen = new Map(seenRows.map((r) => [r.dayzId, r.lastSeenAt]));
  return entries.map((e) => ({ ...e, lastSeenAt: seen.get(e.dayzId) ?? null }));
}

/** The leader's own poles-they-could-move-to, within the 24 h confirm window (writes.ts's confirmRebindDb). No coordinates. */
async function rebindCandidatesFor(db: Database, factionId: number, now: Date): Promise<{ poleKey: string; raisedAt: Date; by: string }[]> {
  const store = new PgRebindStore(db);
  const clan = await store.factionFor(factionId);
  if (!clan || clan.poleKey === null) return [];
  const raises = await store.qualifyingRaises(clan, new Date(now.getTime() - REBIND_CONFIRM_MS));
  const candidates = selectCandidates(raises, { currentPoleKey: clan.poleKey, now, windowMs: REBIND_CONFIRM_MS });
  return candidates.map((c) => ({ poleKey: c.poleKey, raisedAt: c.occurredAt, by: c.gamertag }));
}

/**
 * The clan page for a member — leader, officer, member or pending alike
 * (target spec §10.2). A pending member sees the roster they are waiting to
 * join but not the officer views: `invitesOut`/`requestsIn` are `[]` for
 * anyone below officer, `rebindCandidates` for anyone but the leader.
 */
export async function clanForDb(db: Database, discordId: string, now: Date = new Date()): Promise<ClanView | "not-linked" | "not-in-clan"> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  const [m] = await db.select({ factionId: factionMembers.factionId, role: factionMembers.role, status: factionMembers.status })
    .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, HOLDING)))
    .orderBy(asc(factions.id)).limit(1);
  if (!m) return "not-in-clan";

  const [clan] = await db.select({
    id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status,
    createdAt: factions.createdAt, activatedAt: factions.activatedAt, recruiting: factions.recruiting,
    playWindow: factions.playWindow, language: factions.language, pitch: factions.pitch,
  }).from(factions).where(eq(factions.id, m.factionId));

  const role = m.role as Role;
  const status = m.status as MemberStatus;
  const officerPlus = status === "full" && (role === "leader" || role === "officer");

  const roster = await rosterWithLastSeen(db, m.factionId);
  const invitesOut = officerPlus ? await new PgRosterStore(db).invitesOut(m.factionId, now) : [];
  const requestsIn = officerPlus ? await openRequestsFor(db, m.factionId, now) : [];
  const rebindCandidates = status === "full" && role === "leader" ? await rebindCandidatesFor(db, m.factionId, now) : [];

  return { clan: clan!, me: { role, status }, roster, invitesOut, requestsIn, rebindCandidates };
}

/**
 * Reserved clans hold their flag but are not yet a clan the public can see
 * (spec §4.4) — excluded from the listing, but their texture still counts as
 * taken, so `taken` is computed from HOLDING_STATUSES directly, not from the
 * directory rows above it.
 */
export async function directoryDb(db: Database): Promise<{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }> {
  const serverId = await activeServerId(db);
  // A leftJoin + GROUP BY on the primary key, matching factionCard's own
  // pattern — NOT a correlated `(select count(*) ... where faction_id =
  // ${factions.id})` subquery: drizzle renders that column reference
  // unqualified, and inside the subquery's own scope it silently resolves
  // to the JOINED table's own "id" column instead of the outer row's,
  // producing a wrong (but non-erroring) count for every clan.
  const rows = await db.select({
    tag: factions.tag, name: factions.name, texture: factions.texture, status: factions.status,
    recruiting: factions.recruiting, playWindow: factions.playWindow, language: factions.language, pitch: factions.pitch,
    memberCount: sql<number>`count(*) filter (where ${factionMembers.status} = 'full')`,
  }).from(factions)
    .leftJoin(factionMembers, eq(factionMembers.factionId, factions.id))
    .where(and(eq(factions.serverId, serverId), inArray(factions.status, ["active", "dormant"])))
    .groupBy(factions.id)
    .orderBy(desc(factions.recruiting), asc(sql`lower(${factions.name})`));

  const holdingRows = await db.select({ texture: factions.texture }).from(factions)
    .where(and(eq(factions.serverId, serverId), inArray(factions.status, HOLDING)));
  const taken = holdingRows.map((r) => r.texture);

  return {
    clans: rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) })),
    flags: { taken, free: CLAIMABLE_FLAGS.filter((f) => !taken.includes(f)) },
  };
}

/**
 * The same advisory checks `requestJoinDb` makes (writes.ts), read-only and
 * in the same order: recruiting, already a member anywhere on the server,
 * cooldown, cap, then an already-open request against this clan.
 */
async function canRequestFor(db: Database, clan: { id: number; recruiting: boolean }, serverId: number, viewerDiscordId: string | null, now: Date): Promise<ClanPage["canRequest"]> {
  if (!viewerDiscordId) return "not-linked";
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, viewerDiscordId));
  if (!link) return "not-linked";
  if (!clan.recruiting) return "not-recruiting";
  const [existing] = await db.select({ id: factionMembers.id }).from(factionMembers)
    .where(and(eq(factionMembers.serverId, serverId), eq(factionMembers.dayzId, link.dayzId)));
  if (existing) return "in-clan";
  const [cd] = await db.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
    .where(and(eq(rosterCooldowns.serverId, serverId), eq(rosterCooldowns.dayzId, link.dayzId)));
  if (cd && cd.until > now) return "cooldown";
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(factionMembers).where(eq(factionMembers.factionId, clan.id));
  if (count!.n >= CLAN_SIZE_CAP) return "cap";
  const [openReq] = await db.select({ id: factionJoinRequests.id }).from(factionJoinRequests)
    .where(and(eq(factionJoinRequests.factionId, clan.id), eq(factionJoinRequests.dayzId, link.dayzId), isNull(factionJoinRequests.decidedAt), gt(factionJoinRequests.expiresAt, now)));
  if (openReq) return "already-requested";
  return "yes";
}

/**
 * The public clan page (target spec §10.3). `roster` carries gamertag and
 * role only — no coordinate ever passes through here.
 *
 * Filtered to `active`/`dormant` like `directoryDb` (spec §4.4), not the
 * wider HOLDING set: a `reserved` clan holds its flag but is not yet public,
 * so its tag must not resolve here either — until activation this returns
 * null, same as a tag nobody has claimed.
 */
export async function clanByTagDb(db: Database, tag: string, viewerDiscordId: string | null, now: Date = new Date()): Promise<ClanPage | null> {
  const serverId = await activeServerId(db);
  const [row] = await db.select({
    id: factions.id, tag: factions.tag, name: factions.name, texture: factions.texture, status: factions.status,
    createdAt: factions.createdAt, recruiting: factions.recruiting, playWindow: factions.playWindow,
    language: factions.language, pitch: factions.pitch,
    memberCount: sql<number>`count(*) filter (where ${factionMembers.status} = 'full')`,
  }).from(factions)
    .leftJoin(factionMembers, eq(factionMembers.factionId, factions.id))
    .where(and(eq(factions.serverId, serverId), eq(sql`lower(${factions.tag})`, tag.toLowerCase()), inArray(factions.status, ["active", "dormant"])))
    .groupBy(factions.id);
  if (!row) return null;

  const rosterRows = await db.select({ gamertag: identityLinks.gamertag, role: factionMembers.role })
    .from(factionMembers).leftJoin(identityLinks, eq(identityLinks.dayzId, factionMembers.dayzId))
    .where(and(eq(factionMembers.factionId, row.id), eq(factionMembers.status, "full")));

  const canRequest = await canRequestFor(db, { id: row.id, recruiting: row.recruiting }, serverId, viewerDiscordId, now);

  return {
    tag: row.tag, name: row.name, texture: row.texture, status: row.status, memberCount: Number(row.memberCount),
    recruiting: row.recruiting, playWindow: row.playWindow, language: row.language, pitch: row.pitch,
    createdAt: row.createdAt,
    roster: rosterRows.map((r) => ({ gamertag: r.gamertag ?? null, role: r.role as Role })),
    canRequest,
  };
}

/** The viewer's open ceremony, if any — `/claim`'s one read, on the site. */
export async function claimContextDb(db: Database, discordId: string): Promise<ClaimContext> {
  const ceremony = await new PgFactionStore(db).openCeremonyFor(discordId);
  if (!ceremony) return null;
  const [row] = await db.select({ detectedAt: ceremonies.detectedAt, expiresAt: ceremonies.expiresAt })
    .from(ceremonies).where(eq(ceremonies.id, ceremony.id));
  const holdingRows = await db.select({ texture: factions.texture }).from(factions)
    .where(and(eq(factions.serverId, ceremony.serverId), inArray(factions.status, HOLDING)));
  const taken = new Set(holdingRows.map((r) => r.texture));
  return {
    ceremony: { id: ceremony.id, detectedAt: row!.detectedAt, expiresAt: row!.expiresAt, participants: ceremony.participants },
    freeFlags: CLAIMABLE_FLAGS.filter((f) => !taken.has(f)),
  };
}

/**
 * /me's shape for an invite: the same row `pendingInvitesFor` returns,
 * relabeled to `clanId`/`clanName` — apps/web never spells the internal
 * store's "faction" field names (copy-vocabulary.test.ts scans identifiers,
 * not just strings), so the rename happens here, at the package boundary,
 * rather than leaking `PendingInvite`'s own field names into the site.
 */
export type MyInvite = { id: number; clanId: number; clanName: string; tag: string; serverId: number; serverName: string; expiresAt: Date };

/** /invites's one read: offers still open to you. */
export async function myInvitesDb(db: Database, discordId: string, now: Date = new Date()): Promise<MyInvite[]> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return [];
  const rows = await new PgRosterStore(db).pendingInvitesFor(link.dayzId, now);
  return rows.map((r) => ({ id: r.id, clanId: r.factionId, clanName: r.factionName, tag: r.tag, serverId: r.serverId, serverName: r.serverName, expiresAt: r.expiresAt }));
}

/** /me's shape for one of the viewer's own join requests — see `MyInvite`'s note on the rename. */
export type MyRequest = { id: number; clanId: number; clanName: string; tag: string; createdAt: Date; expiresAt: Date };

/** Your own outstanding join requests, across every clan. */
export async function myRequestsDb(db: Database, discordId: string, now: Date = new Date()): Promise<MyRequest[]> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return [];
  const rows = await requestsBy(db, link.dayzId, now);
  return rows.map((r) => ({ id: r.id, clanId: r.factionId, clanName: r.factionName, tag: r.tag, createdAt: r.createdAt, expiresAt: r.expiresAt }));
}
