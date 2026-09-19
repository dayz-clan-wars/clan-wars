/**
 * @factions/roster — what the site and the bot are allowed to do (target spec §10.4).
 *
 * `apps/web` imports this and never @factions/db. The export list below IS
 * the permission list; test/exports.test.ts pins it by name and so does
 * apps/web/test/smoke.test.ts.
 *
 * ⚠️ Since 2026-09-13 the wrapper BODIES live in `api.ts`, behind
 * `makeRoster(getDb, getNow)`. This file binds that factory to the package's
 * own pooled client, so the names below and their behaviour are unchanged.
 * `apps/bot` binds the same factory to its own handle and therefore runs the
 * same rules — spec §3.1. Adding a capability means adding it in `api.ts` AND
 * naming it here, on purpose, in both pinning tests.
 *
 * Nothing here may ever set a clan active or dormant, write a raid or a
 * defense, insert a declaration without citing evidence the log already
 * holds, or create a faction without a ceremony.
 */
import { db } from "./client";
import { makeRoster } from "./api";

export { makeRoster, type Roster } from "./api";

export type { Viewer, Role } from "./api";
export type { MapState, MapFix, DropPinOutcome } from "./api";
export type { LinkStatus, LinkStep, UnlinkOutcome, IssueOutcome, IssueOutcomeKind } from "./api";
export type { BaseView, DeclareSoloOutcome, DeclareSoloReason } from "./api";
export type {
  ActorRefusal, InviteOutcome, InviteeRef, ReserveOutcome, CreateInviteOutcome, AcceptInviteOutcome, KickOutcome, LeaveOutcome,
  SetRoleOutcome, TransferOutcome, RenameOutcome, RequestJoinOutcome, DecideRequestOutcome,
} from "./api";
export type { RosterRow, ClanView, DirectoryEntry, ClanPage, ClaimContext, MyInvite, MyRequest } from "./api";
export type { Scoreboard, ScoreboardRow, AlphaWeek, SeasonSummary, WarLogEntry, WarLogFilter } from "./api";
export type { StatScope, ResolvedScope, BoardRow, KdRow, LongestKillRow, Boards, PlayerProfile, BoardKind, BoardPage, RowClan, RowClans, Encounter, FeedEntry, PlayerFeed } from "./api";
export type { ClaimOutcome, OpenVoteOutcome, CastOutcome, OpenVote, OpenClaim } from "./api";
export type { VaultState, VaultLockView, VaultHistoryRow } from "./api";
export type { GuestGrantOutcome, GuestTargetRef } from "./api";
export type { Attention } from "./api";
export type { BaseDamageWindow } from "./api";
export type { LiveServer } from "./api";
export type { AchievementWall, AchievementTile, AchievementSubject } from "./api";
export type { ReportOutcome, ReportableIncident } from "./api";
export type { NotificationsPage, NoticeRow } from "./api";
export type { NoticePayload } from "./api";
export type { BoosterKitView, KitStep, KitSpot, KitArmband, KitChallenge, SaveKitOutcome } from "./api";

export const {
  acceptInvite, achievementsFor, addLock, alphas, attention, baseDamageWindow, baseFor, boardPage, boosterKit, cancelLink, castVote,
  claimCeremony, claimContext, claimSuccession, clanBoard, clanBoardPage, clanByTag, clanFor, confirmLock,
  confirmRebind, decideRequest, declareSolo, declineInvite, deleteLock, deletePin, demote, directory,
  disband, dropPin, editLock, grantGuestPass, invite, kick, leave, linkStatus, liveServers, mapState,
  markAllNoticesRead, markNoticeRead,
  myInvites, myRequests, notificationsFor, openVote, playerBoards, playerFeed, playerProfile, promote, releaseSolo, rename,
  reportIncident, requestJoin, restartsScheduled, revealLock, revokeGuestPass, revokeInvite, rotateLocks, saveBoosterKitSlot, scoreboard, searchGamertags, seasons,
  setRecruitingPost, startKitPlacement, startLink, suggestGamertags, transfer, unlink, vaultFor, viewerFor, warLog, withdrawRequest,
} = makeRoster(db);

export { SUGGEST_SCOPES, type SuggestScope } from "./api";
export { DECLARE_SOLO_REASONS } from "./api";
export { ISSUE_OUTCOME_KINDS } from "./api";
export { BOARD_KINDS, BOARD_PAGE_SIZE, FEED_PAGE_SIZE } from "./api";
export { VAULT_NAME_MAX, VAULT_NOTE_MAX } from "./api";
export { REPORT_REASONS } from "./api";
export { NOTIFICATIONS_PAGE_SIZE } from "./api";
