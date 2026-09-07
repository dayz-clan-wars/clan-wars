/**
 * @factions/roster — what the site is allowed to do (target spec §10.4).
 *
 * `apps/web` imports this and never @factions/db. The export list below IS
 * the permission list; test/exports.test.ts pins it by name and so does
 * apps/web/test/smoke.test.ts. It holds the link flow (`startLink`,
 * `cancelLink`, `unlink`, `linkStatus`, `searchGamertags`), the solo base
 * (`declareSolo`, `releaseSolo`, `baseFor`) and the roster writes — invites
 * and join requests both ways, `leave`/`kick`/`promote`/`demote`/`transfer`,
 * `rename`/`setRecruitingPost`/`disband`, `claimCeremony` and
 * `confirmRebind`. Every write names the ACTOR's Discord id first and
 * resolves their clan itself. Nothing here may ever set a clan active or dormant, write a raid
 * or a defense, insert a declaration without citing evidence the log
 * already holds, or create a faction without a ceremony.
 *
 * Lock order for the writes that land in increments 2b and 2c (spec §4.12):
 * factions → declarations → poles → faction_members → faction_invites →
 * faction_join_requests → … → faction_events. Every write appends its feed
 * or notice row in the transition's own transaction.
 */
import { db } from "./client";
import { viewerForDb, type Viewer, type Role } from "./viewer";
import {
  linkStatusDb, startLinkDb, cancelLinkDb, unlinkDb, searchGamertagsDb,
  type LinkStatus, type LinkStep, type UnlinkOutcome,
} from "./link";
import { baseForDb, declareSoloDb, releaseSoloDb, type BaseView, type DeclareSoloOutcome, type DeclareSoloReason } from "./base";
export { DECLARE_SOLO_REASONS } from "./base";
import type { IssueOutcome, IssueOutcomeKind } from "@factions/verification";
export { ISSUE_OUTCOME_KINDS } from "@factions/verification";
import {
  inviteDb, revokeInviteDb, acceptInviteDb, declineInviteDb, requestJoinDbByTag, withdrawRequestDbFor, decideRequestDbFor,
  leaveDb, kickDb, promoteDb, demoteDb, transferDb, disbandDb, renameDb, setRecruitingPostDb, claimCeremonyDb, confirmRebindDb,
  type InviteOutcome, type InviteeRef, type ReserveOutcome,
} from "./writes";
import type {
  CreateInviteOutcome, AcceptInviteOutcome, KickOutcome, LeaveOutcome, SetRoleOutcome, TransferOutcome, RenameOutcome,
  RequestJoinOutcome, DecideRequestOutcome,
} from "./internal";
import type { ActorRefusal } from "./actor";
import {
  clanForDb, directoryDb, clanByTagDb, claimContextDb, myInvitesDb, myRequestsDb,
  type RosterRow, type ClanView, type DirectoryEntry, type ClanPage, type ClaimContext, type MyInvite, type MyRequest,
} from "./reads";
import {
  scoreboardDb, alphasDb, seasonsDb, warLogDb,
  type Scoreboard, type ScoreboardRow, type AlphaWeek, type SeasonSummary, type WarLogEntry,
} from "./scoring";
import { mapStateDb, dropPinDb, deletePinDb, type MapState, type MapFix, type DropPinOutcome } from "./map";
import {
  playerBoardsDb, playerProfileDb, clanBoardDb,
  type StatScope, type BoardRow, type KdRow, type Boards, type PlayerProfile,
} from "./stats";

export type { Viewer, Role };
export type { MapState, MapFix, DropPinOutcome };
export type { LinkStatus, LinkStep, UnlinkOutcome, IssueOutcome, IssueOutcomeKind };
export type { BaseView, DeclareSoloOutcome, DeclareSoloReason };
export type {
  ActorRefusal, InviteOutcome, InviteeRef, ReserveOutcome, CreateInviteOutcome, AcceptInviteOutcome, KickOutcome, LeaveOutcome,
  SetRoleOutcome, TransferOutcome, RenameOutcome, RequestJoinOutcome, DecideRequestOutcome,
};
export type { RosterRow, ClanView, DirectoryEntry, ClanPage, ClaimContext, MyInvite, MyRequest };
export type { Scoreboard, ScoreboardRow, AlphaWeek, SeasonSummary, WarLogEntry };
export type { StatScope, BoardRow, KdRow, Boards, PlayerProfile };

/** Who is looking: their link and their clan, or null for either. */
export function viewerFor(discordId: string): Promise<Viewer> {
  return viewerForDb(db(), discordId);
}

/** /link's one read: your link, your open challenge, how the last one ended. */
export function linkStatus(discordId: string): Promise<LinkStatus> {
  return linkStatusDb(db(), discordId, new Date());
}
/** Issue (or re-show) a link challenge for a character the log has seen. */
export function startLink(discordId: string, targetDayzId: string, opts: { newSequence?: boolean } = {}): Promise<IssueOutcome> {
  return startLinkDb(db(), { discordId, targetDayzId, newSequence: opts.newSequence, now: new Date(), rng: Math.random });
}
export function cancelLink(discordId: string): Promise<{ canceled: boolean }> {
  return cancelLinkDb(db(), discordId, new Date());
}
/** Refused while in a clan; releases a solo base. */
export function unlink(discordId: string): Promise<UnlinkOutcome> {
  return unlinkDb(db(), discordId, new Date());
}
export function searchGamertags(prefix: string): Promise<{ dayzId: string; gamertag: string }[]> {
  return searchGamertagsDb(db(), prefix);
}

/** /base's one read: your raises, your declaration. */
export function baseFor(discordId: string): Promise<BaseView> {
  return baseForDb(db(), discordId);
}
/** Declare a solo base at a pole you have raised at. Every rule is inside. */
export function declareSolo(discordId: string, poleKey: string): Promise<DeclareSoloOutcome> {
  return declareSoloDb(db(), discordId, poleKey, new Date());
}
export function releaseSolo(discordId: string): Promise<{ released: boolean }> {
  return releaseSoloDb(db(), discordId, new Date());
}

/** Invite a linked player to your clan, by Discord id or by gamertag. Officer+ only; the invitee must already be linked. */
export function invite(actorDiscordId: string, invitee: InviteeRef): Promise<{ outcome: InviteOutcome; inviteId: number | null }> {
  return inviteDb(db(), new Date(), actorDiscordId, invitee);
}
/** Withdraw an outstanding invite. Officer+ only. */
export function revokeInvite(actorDiscordId: string, inviteId: number) {
  return revokeInviteDb(db(), new Date(), actorDiscordId, inviteId);
}
/** Accept an invite sent to you. */
export function acceptInvite(discordId: string, inviteId: number) {
  return acceptInviteDb(db(), new Date(), discordId, inviteId);
}
/** Decline an invite sent to you. */
export function declineInvite(discordId: string, inviteId: number) {
  return declineInviteDb(db(), new Date(), discordId, inviteId);
}
/** Ask to join a recruiting clan by its tag. */
export function requestJoin(discordId: string, tag: string) {
  return requestJoinDbByTag(db(), new Date(), discordId, tag);
}
/** Withdraw your own join request. */
export function withdrawRequest(discordId: string, requestId: number) {
  return withdrawRequestDbFor(db(), new Date(), discordId, requestId);
}
/** Accept or decline a join request against your clan. Officer+ only. */
export function decideRequest(actorDiscordId: string, requestId: number, decision: "accepted" | "declined") {
  return decideRequestDbFor(db(), new Date(), actorDiscordId, requestId, decision);
}
/** Leave your clan. A pending member may leave too. */
export function leave(discordId: string) {
  return leaveDb(db(), new Date(), discordId);
}
/** Kick a member from your clan. Officer+ only. */
export function kick(actorDiscordId: string, targetDiscordId: string) {
  return kickDb(db(), new Date(), actorDiscordId, targetDiscordId);
}
/** Promote a member to officer. Leader only. */
export function promote(actorDiscordId: string, targetDiscordId: string) {
  return promoteDb(db(), actorDiscordId, targetDiscordId);
}
/** Demote an officer to member. Leader only. */
export function demote(actorDiscordId: string, targetDiscordId: string) {
  return demoteDb(db(), actorDiscordId, targetDiscordId);
}
/** Hand leadership to another full member. */
export function transfer(actorDiscordId: string, targetDiscordId: string) {
  return transferDb(db(), new Date(), actorDiscordId, targetDiscordId);
}
/** Disband your clan. Leader only. */
export function disband(actorDiscordId: string) {
  return disbandDb(db(), actorDiscordId);
}
/** Rename your clan, and optionally its tag. Leader only, on a cooldown. */
export function rename(actorDiscordId: string, r: { name: string; tag?: string }) {
  return renameDb(db(), new Date(), actorDiscordId, r);
}
/** Edit your clan's recruiting post. Officer+ only. */
export function setRecruitingPost(actorDiscordId: string, post: { recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }) {
  return setRecruitingPostDb(db(), actorDiscordId, post);
}
/** Claim a ceremony: name, tag, flag, and a roster pruned to real participants. */
export function claimCeremony(discordId: string, ceremonyId: number, a: { name: string; tag: string; texture: string; memberDayzIds: string[] }) {
  return claimCeremonyDb(db(), new Date(), discordId, ceremonyId, a);
}
/** Confirm moving your clan's base to a pole a member raised your flag at. Leader only. */
export function confirmRebind(actorDiscordId: string, poleKey: string) {
  return confirmRebindDb(db(), new Date(), actorDiscordId, poleKey);
}

/** Your clan page: roster, and — role permitting — invites out, requests in, rebind candidates. */
export function clanFor(discordId: string): Promise<ClanView | "not-linked" | "not-in-clan"> {
  return clanForDb(db(), discordId, new Date());
}
/** The public listing: recruiting clans first, then by name, plus the flag pool. */
export function directory(): Promise<{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }> {
  return directoryDb(db());
}
/** A single clan's public page, and whether the viewer may request to join it. */
export function clanByTag(tag: string, viewerDiscordId: string | null): Promise<ClanPage | null> {
  return clanByTagDb(db(), tag, viewerDiscordId, new Date());
}
/** The viewer's open founding ceremony, or null. */
export function claimContext(discordId: string): Promise<ClaimContext> {
  return claimContextDb(db(), discordId);
}
/** Invites still open to you. */
export function myInvites(discordId: string) {
  return myInvitesDb(db(), discordId, new Date());
}
/** Your own outstanding join requests. */
export function myRequests(discordId: string) {
  return myRequestsDb(db(), discordId, new Date());
}

/** The open season's table in §8.1 order: ranked clans first, then unranked, by name. */
export function scoreboard(): Promise<Scoreboard> {
  return scoreboardDb(db());
}
/** Every closed week of the open season, newest first. */
export function alphas(): Promise<{ season: { number: number } | null; weeks: AlphaWeek[] }> {
  return alphasDb(db());
}
/** Closed seasons, newest first, with their final standings and champion. */
export function seasons(): Promise<SeasonSummary[]> {
  return seasonsDb(db());
}
/** Raids and defenses of the open season, newest first. */
export function warLog(limit?: number): Promise<WarLogEntry[]> {
  return warLogDb(db(), limit);
}

/** The map, scoped to who is looking (spec §10.3). */
export function mapState(discordId: string): Promise<MapState | "not-linked"> { return mapStateDb(db(), discordId, new Date()); }
/** Drop a clan pin. Full members only; every rule is inside. */
export function dropPin(discordId: string, pin: { x: number; z: number; icon: string; note: string | null }): Promise<DropPinOutcome> { return dropPinDb(db(), discordId, pin, new Date()); }
/** Delete one of your clan's pins. Any full member may. */
export function deletePin(discordId: string, pinId: number): Promise<{ deleted: boolean }> { return deletePinDb(db(), discordId, pinId); }

/** The public player boards for one scope: raiders, killers, K/D, play time, friendly fire (spec §11). */
export function playerBoards(scope: StatScope, limit?: number): Promise<Boards> {
  return playerBoardsDb(db(), scope, limit, new Date());
}
/** One player's public page, by gamertag. Null when the log has never seen that name. */
export function playerProfile(gamertag: string, scope: StatScope): Promise<PlayerProfile | null> {
  return playerProfileDb(db(), gamertag, scope, new Date());
}
/** The same boards, narrowed to the viewer's own clan's current full roster. Full members only. */
export function clanBoard(discordId: string, scope: StatScope): Promise<Boards | "not-linked" | "not-in-clan" | "pending"> {
  return clanBoardDb(db(), discordId, scope, undefined, new Date());
}
