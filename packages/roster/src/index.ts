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
 * `confirmRebind`. Increment 7 adds three more groups, each named by its own
 * `Db`-suffixed wrapper file: leadership (`claimSuccession`, `openVote`,
 * `castVote` — succession and no-confidence, spec §5/§7), the vault
 * (`vaultFor`, `addLock`/`editLock`/`deleteLock`, `revealLock`/`confirmLock`,
 * `rotateLocks`, and the `VAULT_NAME_MAX`/`VAULT_NOTE_MAX` limits — spec
 * §4.9/§10.2) and settings/guest passes (`grantGuestPass`,
 * `revokeGuestPass` — spec §4.10). Every write names the ACTOR's Discord id
 * first and resolves their clan itself. Nothing here may ever set a clan
 * active or dormant, write a raid or a defense, insert a declaration
 * without citing evidence the log already holds, or create a faction
 * without a ceremony.
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
import { suggestGamertagsDb, type SuggestScope } from "./suggest";
export { SUGGEST_SCOPES, type SuggestScope } from "./suggest";
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
  type Scoreboard, type ScoreboardRow, type AlphaWeek, type SeasonSummary, type WarLogEntry, type WarLogFilter,
} from "./scoring";
import { mapStateDb, dropPinDb, deletePinDb, type MapState, type MapFix, type DropPinOutcome } from "./map";
import { achievementsForDb, type AchievementWall, type AchievementTile, type AchievementSubject } from "./achievements";
export type { AchievementWall, AchievementTile, AchievementSubject };
import {
  playerBoardsDb, playerProfileDb, clanBoardDb, boardPageDb, clanBoardPageDb, playerFeedDb, BOARD_KINDS, BOARD_PAGE_SIZE, FEED_PAGE_SIZE,
  type StatScope, type ResolvedScope, type BoardRow, type KdRow, type LongestKillRow, type Boards, type PlayerProfile,
  type BoardKind, type BoardPage, type RowClan, type RowClans, type Encounter, type FeedEntry, type PlayerFeed,
} from "./stats";
import {
  claimSuccessionDbFor, openVoteDbFor, castVoteDbFor,
  type ClaimOutcome, type OpenVoteOutcome, type CastOutcome, type OpenVote, type OpenClaim,
} from "./leadership";
import {
  vaultForDb, addLockDbFor, editLockDbFor, deleteLockDbFor, revealLockDbFor, rotateLocksDbFor, confirmLockDbFor,
  VAULT_NAME_MAX, VAULT_NOTE_MAX,
  type VaultState, type VaultLockView, type VaultHistoryRow,
} from "./vault";
import {
  grantGuestPassDbFor, revokeGuestPassDbFor,
  type GuestGrantOutcome, type GuestTargetRef,
} from "./guest";
import { attentionDb, type Attention } from "./attention";
import { liveServersDb, type LiveServer } from "./servers";

export type { Viewer, Role };
export type { MapState, MapFix, DropPinOutcome };
export type { LinkStatus, LinkStep, UnlinkOutcome, IssueOutcome, IssueOutcomeKind };
export type { BaseView, DeclareSoloOutcome, DeclareSoloReason };
export type {
  ActorRefusal, InviteOutcome, InviteeRef, ReserveOutcome, CreateInviteOutcome, AcceptInviteOutcome, KickOutcome, LeaveOutcome,
  SetRoleOutcome, TransferOutcome, RenameOutcome, RequestJoinOutcome, DecideRequestOutcome,
};
export type { RosterRow, ClanView, DirectoryEntry, ClanPage, ClaimContext, MyInvite, MyRequest };
export type { Scoreboard, ScoreboardRow, AlphaWeek, SeasonSummary, WarLogEntry, WarLogFilter };
export type { StatScope, ResolvedScope, BoardRow, KdRow, LongestKillRow, Boards, PlayerProfile, BoardKind, BoardPage, RowClan, RowClans, Encounter, FeedEntry, PlayerFeed };
export type { ClaimOutcome, OpenVoteOutcome, CastOutcome, OpenVote, OpenClaim };
export type { VaultState, VaultLockView, VaultHistoryRow };
export { VAULT_NAME_MAX, VAULT_NOTE_MAX };
export type { GuestGrantOutcome, GuestTargetRef };
export type { Attention };
export type { LiveServer };

/** The site bar's two counts: what is waiting on you (/me) and on your clan (/clan). Read on every page, so it is cheap. */
export function attention(discordId: string): Promise<Attention> {
  return attentionDb(db(), discordId, new Date());
}

/** The server strip under the top bar: each live server's in-game name as Nitrado last reported it. The same for every viewer. */
export function liveServers(): Promise<LiveServer[]> {
  return liveServersDb(db());
}

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
/** Autocomplete names for a gamertag box: `seen` for the public player search, `linked` for invites and guest passes. */
export function suggestGamertags(prefix: string, scope: SuggestScope): Promise<string[]> {
  return suggestGamertagsDb(db(), prefix, scope);
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
export function warLog(limit?: number, filter?: WarLogFilter): Promise<WarLogEntry[]> {
  return warLogDb(db(), limit, filter);
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
/** The badge wall for a player (by gamertag) or a clan (by tag). Null when the name is unknown. */
export function achievementsFor(subject: AchievementSubject): Promise<AchievementWall | null> {
  return achievementsForDb(db(), subject, new Date());
}
/** The same boards, narrowed to the viewer's own clan's current full roster. Full members only. */
export function clanBoard(discordId: string, scope: StatScope, limit?: number): Promise<Boards | "not-linked" | "not-in-clan" | "pending"> {
  return clanBoardDb(db(), discordId, scope, limit, new Date());
}
/** One page (`BOARD_PAGE_SIZE` rows, 1-based) of one public board — the "see all" page behind a top-N panel. */
export function boardPage(kind: BoardKind, scope: StatScope, page: number): Promise<BoardPage> {
  return boardPageDb(db(), kind, scope, page, new Date());
}
/** The same page, narrowed to the viewer's own clan's current full roster. Full members only. */
export function clanBoardPage(discordId: string, kind: BoardKind, scope: StatScope, page: number): Promise<BoardPage | "not-linked" | "not-in-clan" | "pending"> {
  return clanBoardPageDb(db(), discordId, kind, scope, page, new Date());
}
export { BOARD_KINDS, BOARD_PAGE_SIZE, FEED_PAGE_SIZE };
/** One page (`FEED_PAGE_SIZE` entries, 1-based, newest first) of what the log recorded about one player. Null for a name it has never seen. */
export function playerFeed(gamertag: string, scope: StatScope, page: number): Promise<PlayerFeed | null> {
  return playerFeedDb(db(), gamertag, scope, page, new Date());
}

/** Claim a silent leader's seat (guide ch. 3/8). Full members only; every eligibility rule is inside `claimSuccessionDb`. */
export function claimSuccession(discordId: string) {
  return claimSuccessionDbFor(db(), new Date(), discordId);
}
/** Open a no-confidence vote against your leader, nominating a replacement (yourself included). The leader may not open one. */
export function openVote(discordId: string, nomineeDiscordId: string) {
  return openVoteDbFor(db(), new Date(), discordId, nomineeDiscordId);
}
/** Cast your one ballot in your clan's open vote. */
export function castVote(discordId: string) {
  return castVoteDbFor(db(), new Date(), discordId);
}

/** Your clan's vault: locks your rank may see, and — leader only — its history. Never a code. */
export function vaultFor(discordId: string) {
  return vaultForDb(db(), discordId);
}
/** Add a vault lock. Officer+ only. */
export function addLock(discordId: string, a: { name: string; note: string | null; minRole: Role; code?: string }) {
  return addLockDbFor(db(), new Date(), discordId, a);
}
/** Rename/re-describe/re-gate a lock. Officer+ only; the code is untouched. */
export function editLock(discordId: string, a: { lockId: number; name: string; note: string | null; minRole: Role }) {
  return editLockDbFor(db(), new Date(), discordId, a);
}
/** Delete a lock. Officer+ only. */
export function deleteLock(discordId: string, lockId: number) {
  return deleteLockDbFor(db(), new Date(), discordId, lockId);
}
/** Reveal a lock's code. Any rank meeting the lock's `min_role`. */
export function revealLock(discordId: string, lockId: number) {
  return revealLockDbFor(db(), new Date(), discordId, lockId);
}
/** Rotate one lock's code, or every lock in the vault (`lockId: "all"`). Officer+ only. */
export function rotateLocks(discordId: string, lockId: number | "all") {
  return rotateLocksDbFor(db(), new Date(), discordId, lockId);
}
/** Confirm a lock's code was changed in-game. Any rank meeting the lock's `min_role`. */
export function confirmLock(discordId: string, lockId: number) {
  return confirmLockDbFor(db(), new Date(), discordId, lockId);
}

/** Grant a 24 h guest voice pass, by Discord id or by a linked gamertag. Officer+ only. */
export function grantGuestPass(discordId: string, target: GuestTargetRef) {
  return grantGuestPassDbFor(db(), new Date(), discordId, target);
}
/** Revoke an open guest pass early. Officer+ only. */
export function revokeGuestPass(discordId: string, passId: number) {
  return revokeGuestPassDbFor(db(), new Date(), discordId, passId);
}
