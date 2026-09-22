import type { Database } from "@factions/db";
import { viewerForDb, type Viewer, type Role } from "./viewer";
import {
  linkStatusDb, startLinkDb, cancelLinkDb, unlinkDb, searchGamertagsDb,
  type LinkStatus, type LinkStep, type UnlinkOutcome,
} from "./link";
import { suggestGamertagsDb, type SuggestScope } from "./suggest";
import { baseForDb, declareSoloDb, releaseSoloDb, type BaseView, type DeclareSoloOutcome, type DeclareSoloReason } from "./base";
import type { IssueOutcome, IssueOutcomeKind } from "@factions/verification";
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
import { baseDamageWindowDb, type BaseDamageWindow } from "./base-damage-window";
import { liveServersDb, type LiveServer } from "./servers";
import { restartsScheduledDb } from "./restarts";
import { reportIncidentDb, REPORT_REASONS, type ReportOutcome, type ReportableIncident } from "./internal/incidents";
import {
  notificationsForDb, markAllNoticesReadDb, markNoticeReadDb, NOTIFICATIONS_PAGE_SIZE,
  type NotificationsPage, type NoticeRow,
} from "./notifications";
import {
  boosterKitForDb, saveBoosterKitSlotDb, saveBoosterKitDb, startKitPlacementDb, cancelKitPlacementDb,
  type BoosterKitView, type KitStep, type KitSpot, type KitArmband, type KitChallenge, type SaveKitOutcome,
} from "./booster-kit";
import type { KitSlot } from "@factions/domain";
import {
  awardsForDb, awardForDb, saveAwardPickDb, startAwardPlacementDb, cancelAwardPlacementDb,
  type AwardSummary, type AwardView, type AwardWriteOutcome,
} from "./awards";

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
export type { GuestGrantOutcome, GuestTargetRef };
export type { Attention };
export type { BaseDamageWindow };
export type { LiveServer };
export type { AchievementWall, AchievementTile, AchievementSubject };
export type { ReportOutcome, ReportableIncident };
export type { NotificationsPage, NoticeRow };
export type { BoosterKitView, KitStep, KitSpot, KitArmband, KitChallenge, SaveKitOutcome };
export type { AwardSummary, AwardView, AwardWriteOutcome };
export type { NoticePayload } from "./internal/notices";
export { NOTIFICATIONS_PAGE_SIZE };
export { SUGGEST_SCOPES, type SuggestScope } from "./suggest";
export { DECLARE_SOLO_REASONS } from "./base";
export { ISSUE_OUTCOME_KINDS } from "@factions/verification";
export { BOARD_KINDS, BOARD_PAGE_SIZE, FEED_PAGE_SIZE } from "./stats";
export { VAULT_NAME_MAX, VAULT_NOTE_MAX } from "./vault";
export { REPORT_REASONS } from "./internal/incidents";

/**
 * The site's capability layer, parameterized (spec §3.1).
 *
 * `index.ts` binds this to the package's own pooled client and re-exports the
 * result, so `apps/web` sees exactly the export list `test/exports.test.ts`
 * pins. `apps/bot` binds it to the handle `start()` already owns, which is
 * what stops the two surfaces from growing separate copies of a rule — the
 * duplication increment 2b removed and spec §1 forbids.
 *
 * ⚠️ `getNow` exists so a caller can freeze the clock in a test. It is NOT a
 * way to backdate a write: every store re-reads its own bounds from the row it
 * locks, and a `getNow` in the past produces refusals, not history.
 */
export function makeRoster(getDb: () => Database, getNow: () => Date = () => new Date()) {
  return {
    /** The site bar's two counts: what is waiting on you (/me) and on your clan (/clan). Read on every page, so it is cheap. */
    attention: (discordId: string): Promise<Attention> => attentionDb(getDb(), discordId, getNow()),

    /** The status strip's base-damage line: live/closed/unconfirmed/skipped, from a CONFIRMED flip — never the clock's guess. */
    baseDamageWindow: (): Promise<BaseDamageWindow> => baseDamageWindowDb(getDb(), getNow()),

    /** The server strip under the top bar: each live server's in-game name as Nitrado last reported it. The same for every viewer. */
    liveServers: (): Promise<LiveServer[]> => liveServersDb(getDb()),
    restartsScheduled: (): Promise<boolean> => restartsScheduledDb(getDb(), getNow()),

    /** Who is looking: their link and their clan, or null for either. */
    viewerFor: (discordId: string): Promise<Viewer> => viewerForDb(getDb(), discordId),

    /** /link's one read: your link, your open challenge, how the last one ended. */
    linkStatus: (discordId: string): Promise<LinkStatus> => linkStatusDb(getDb(), discordId, getNow()),
    /** Issue (or re-show) a link challenge for a character the log has seen. */
    startLink: (discordId: string, targetDayzId: string, opts: { newSequence?: boolean } = {}): Promise<IssueOutcome> =>
      startLinkDb(getDb(), { discordId, targetDayzId, newSequence: opts.newSequence, now: getNow(), rng: Math.random }),
    cancelLink: (discordId: string): Promise<{ canceled: boolean }> => cancelLinkDb(getDb(), discordId, getNow()),
    /** Refused while in a clan; releases a solo base. */
    unlink: (discordId: string): Promise<UnlinkOutcome> => unlinkDb(getDb(), discordId, getNow()),
    searchGamertags: (prefix: string): Promise<{ dayzId: string; gamertag: string }[]> => searchGamertagsDb(getDb(), prefix),
    /** Autocomplete names for a gamertag box: `seen` for the public player search, `linked` for invites and guest passes. */
    suggestGamertags: (prefix: string, scope: SuggestScope): Promise<string[]> => suggestGamertagsDb(getDb(), prefix, scope),

    /** /base's one read: your raises, your declaration. */
    baseFor: (discordId: string): Promise<BaseView> => baseForDb(getDb(), discordId),
    /** Declare a solo base at a pole you have raised at. Every rule is inside. */
    declareSolo: (discordId: string, poleKey: string): Promise<DeclareSoloOutcome> => declareSoloDb(getDb(), discordId, poleKey, getNow()),
    releaseSolo: (discordId: string): Promise<{ released: boolean }> => releaseSoloDb(getDb(), discordId, getNow()),

    /** Invite a linked player to your clan, by Discord id or by gamertag. Officer+ only; the invitee must already be linked. */
    invite: (actorDiscordId: string, invitee: InviteeRef): Promise<{ outcome: InviteOutcome; inviteId: number | null }> =>
      inviteDb(getDb(), getNow(), actorDiscordId, invitee),
    /** Withdraw an outstanding invite. Officer+ only. */
    revokeInvite: (actorDiscordId: string, inviteId: number) => revokeInviteDb(getDb(), getNow(), actorDiscordId, inviteId),
    /** Accept an invite sent to you. */
    acceptInvite: (discordId: string, inviteId: number) => acceptInviteDb(getDb(), getNow(), discordId, inviteId),
    /** Decline an invite sent to you. */
    declineInvite: (discordId: string, inviteId: number) => declineInviteDb(getDb(), getNow(), discordId, inviteId),
    /** Ask to join a recruiting clan by its tag. */
    requestJoin: (discordId: string, tag: string) => requestJoinDbByTag(getDb(), getNow(), discordId, tag),
    /** Withdraw your own join request. */
    withdrawRequest: (discordId: string, requestId: number) => withdrawRequestDbFor(getDb(), getNow(), discordId, requestId),
    /** Accept or decline a join request against your clan. Officer+ only. */
    decideRequest: (actorDiscordId: string, requestId: number, decision: "accepted" | "declined") =>
      decideRequestDbFor(getDb(), getNow(), actorDiscordId, requestId, decision),
    /** Leave your clan. A pending member may leave too. */
    leave: (discordId: string) => leaveDb(getDb(), getNow(), discordId),
    /** Kick a member from your clan. Officer+ only. */
    kick: (actorDiscordId: string, targetDiscordId: string) => kickDb(getDb(), getNow(), actorDiscordId, targetDiscordId),
    /** Promote a member to officer. Leader only. */
    promote: (actorDiscordId: string, targetDiscordId: string) => promoteDb(getDb(), actorDiscordId, targetDiscordId),
    /** Demote an officer to member. Leader only. */
    demote: (actorDiscordId: string, targetDiscordId: string) => demoteDb(getDb(), actorDiscordId, targetDiscordId),
    /** Hand leadership to another full member. */
    transfer: (actorDiscordId: string, targetDiscordId: string) => transferDb(getDb(), getNow(), actorDiscordId, targetDiscordId),
    /** Disband your clan. Leader only. */
    disband: (actorDiscordId: string) => disbandDb(getDb(), actorDiscordId),
    /** Rename your clan, and optionally its tag. Leader only, on a cooldown. */
    rename: (actorDiscordId: string, r: { name: string; tag?: string }) => renameDb(getDb(), getNow(), actorDiscordId, r),
    /** Edit your clan's recruiting post. Officer+ only. */
    setRecruitingPost: (actorDiscordId: string, post: { recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }) =>
      setRecruitingPostDb(getDb(), actorDiscordId, post),
    /** Claim a ceremony: name, tag, flag, and a roster pruned to real participants. */
    claimCeremony: (discordId: string, ceremonyId: number, a: { name: string; tag: string; texture: string; memberDayzIds: string[] }) =>
      claimCeremonyDb(getDb(), getNow(), discordId, ceremonyId, a),
    /** Confirm moving your clan's base to a pole a member raised your flag at. Leader only. */
    confirmRebind: (actorDiscordId: string, poleKey: string) => confirmRebindDb(getDb(), getNow(), actorDiscordId, poleKey),

    /** Your clan page: roster, and — role permitting — invites out, requests in, rebind candidates. */
    clanFor: (discordId: string): Promise<ClanView | "not-linked" | "not-in-clan"> => clanForDb(getDb(), discordId, getNow()),
    /** The public listing: recruiting clans first, then by name, plus the flag pool. */
    directory: (): Promise<{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }> => directoryDb(getDb()),
    /** A single clan's public page, and whether the viewer may request to join it. */
    clanByTag: (tag: string, viewerDiscordId: string | null): Promise<ClanPage | null> => clanByTagDb(getDb(), tag, viewerDiscordId, getNow()),
    /** The viewer's open founding ceremony, or null. */
    claimContext: (discordId: string): Promise<ClaimContext> => claimContextDb(getDb(), discordId),
    /** Invites still open to you. */
    myInvites: (discordId: string) => myInvitesDb(getDb(), discordId, getNow()),
    /** Your own outstanding join requests. */
    myRequests: (discordId: string) => myRequestsDb(getDb(), discordId, getNow()),
    /**
     * /notifications: a page of everything this viewer may read, newest first.
     * `pageSize` lets a caller that only shows a handful (the bell panel) ask
     * for exactly that many, rather than fetching a full page and slicing it.
     */
    notificationsFor: (discordId: string, page: number, pageSize?: number): Promise<NotificationsPage> =>
      notificationsForDb(getDb(), discordId, page, pageSize),
    /** The "Mark all read" button. One watermark row, whatever the backlog. */
    markAllNoticesRead: (discordId: string): Promise<void> => markAllNoticesReadDb(getDb(), discordId),
    /** One notice, marked read because an action resolved it. */
    markNoticeRead: (discordId: string, noticeId: number): Promise<void> =>
      markNoticeReadDb(getDb(), discordId, noticeId),

    /** The open season's table in §8.1 order: ranked clans first, then unranked, by name. */
    scoreboard: (): Promise<Scoreboard> => scoreboardDb(getDb()),
    /** Every closed week of the open season, newest first. */
    alphas: (): Promise<{ season: { number: number } | null; weeks: AlphaWeek[] }> => alphasDb(getDb()),
    /** Closed seasons, newest first, with their final standings and champion. */
    seasons: (): Promise<SeasonSummary[]> => seasonsDb(getDb()),
    /** Raids and defenses of the open season, newest first. */
    warLog: (limit?: number, filter?: WarLogFilter): Promise<WarLogEntry[]> => warLogDb(getDb(), limit, filter),

    /** The map, scoped to who is looking (spec §10.3). */
    mapState: (discordId: string): Promise<MapState | "not-linked"> => mapStateDb(getDb(), discordId, getNow()),
    /** Drop a clan pin. Full members only; every rule is inside. */
    dropPin: (discordId: string, pin: { x: number; z: number; icon: string; note: string | null }): Promise<DropPinOutcome> =>
      dropPinDb(getDb(), discordId, pin, getNow()),
    /** Delete one of your clan's pins. Any full member may. */
    deletePin: (discordId: string, pinId: number): Promise<{ deleted: boolean }> => deletePinDb(getDb(), discordId, pinId),

    /** The public player boards for one scope: raiders, killers, K/D, play time, friendly fire (spec §11). */
    playerBoards: (scope: StatScope, limit?: number): Promise<Boards> => playerBoardsDb(getDb(), scope, limit, getNow()),
    /** One player's public page, by gamertag. Null when the log has never seen that name. */
    playerProfile: (gamertag: string, scope: StatScope): Promise<PlayerProfile | null> => playerProfileDb(getDb(), gamertag, scope, getNow()),
    /** The badge wall for a player (by gamertag) or a clan (by tag). Null when the name is unknown. */
    achievementsFor: (subject: AchievementSubject): Promise<AchievementWall | null> => achievementsForDb(getDb(), subject, getNow()),
    /** The same boards, narrowed to the viewer's own clan's current full roster. Full members only. */
    clanBoard: (discordId: string, scope: StatScope, limit?: number): Promise<Boards | "not-linked" | "not-in-clan" | "pending"> =>
      clanBoardDb(getDb(), discordId, scope, limit, getNow()),
    /** One page (`BOARD_PAGE_SIZE` rows, 1-based) of one public board — the "see all" page behind a top-N panel. */
    boardPage: (kind: BoardKind, scope: StatScope, page: number): Promise<BoardPage> => boardPageDb(getDb(), kind, scope, page, getNow()),
    /** The same page, narrowed to the viewer's own clan's current full roster. Full members only. */
    clanBoardPage: (discordId: string, kind: BoardKind, scope: StatScope, page: number): Promise<BoardPage | "not-linked" | "not-in-clan" | "pending"> =>
      clanBoardPageDb(getDb(), discordId, kind, scope, page, getNow()),
    /** One page (`FEED_PAGE_SIZE` entries, 1-based, newest first) of what the log recorded about one player. Null for a name it has never seen. */
    playerFeed: (gamertag: string, scope: StatScope, page: number): Promise<PlayerFeed | null> => playerFeedDb(getDb(), gamertag, scope, page, getNow()),

    /** Claim a silent leader's seat (guide ch. 3/8). Full members only; every eligibility rule is inside `claimSuccessionDb`. */
    claimSuccession: (discordId: string) => claimSuccessionDbFor(getDb(), getNow(), discordId),
    /** Open a no-confidence vote against your leader, nominating a replacement (yourself included). The leader may not open one. */
    openVote: (discordId: string, nomineeDiscordId: string) => openVoteDbFor(getDb(), getNow(), discordId, nomineeDiscordId),
    /** Cast your one ballot in your clan's open vote. */
    castVote: (discordId: string) => castVoteDbFor(getDb(), getNow(), discordId),

    /** Your clan's vault: locks your rank may see, and — leader only — its history. Never a code. */
    vaultFor: (discordId: string) => vaultForDb(getDb(), discordId),
    /** Add a vault lock. Officer+ only. */
    addLock: (discordId: string, a: { name: string; note: string | null; minRole: Role; code?: string }) =>
      addLockDbFor(getDb(), getNow(), discordId, a),
    /** Rename/re-describe/re-gate a lock. Officer+ only; the code is untouched. */
    editLock: (discordId: string, a: { lockId: number; name: string; note: string | null; minRole: Role }) =>
      editLockDbFor(getDb(), getNow(), discordId, a),
    /** Delete a lock. Officer+ only. */
    deleteLock: (discordId: string, lockId: number) => deleteLockDbFor(getDb(), getNow(), discordId, lockId),
    /** Reveal a lock's code. Any rank meeting the lock's `min_role`. */
    revealLock: (discordId: string, lockId: number) => revealLockDbFor(getDb(), getNow(), discordId, lockId),
    /** Rotate one lock's code, or every lock in the vault (`lockId: "all"`). Officer+ only. */
    rotateLocks: (discordId: string, lockId: number | "all") => rotateLocksDbFor(getDb(), getNow(), discordId, lockId),
    /** Confirm a lock's code was changed in-game. Any rank meeting the lock's `min_role`. */
    confirmLock: (discordId: string, lockId: number) => confirmLockDbFor(getDb(), getNow(), discordId, lockId),

    /** Grant a 24 h guest voice pass, by Discord id or by a linked gamertag. Officer+ only. */
    grantGuestPass: (discordId: string, target: GuestTargetRef) => grantGuestPassDbFor(getDb(), getNow(), discordId, target),
    /** Revoke an open guest pass early. Officer+ only. */
    revokeGuestPass: (discordId: string, passId: number) => revokeGuestPassDbFor(getDb(), getNow(), discordId, passId),

    /**
     * Press charges on a bot-witnessed incident at your own base, against a
     * chosen subset of its participants (`chargedDayzIds`, validated against
     * the incident's own participant rows — an id that was not witnessed on
     * THIS incident is refused, never silently dropped). A SOLO base is
     * reportable only by its declarant; a clan base, officer+ only. Each
     * charged person is still sentenced on the incident's full damage total
     * — liability is joint per charged person. This writes ban rows with no
     * staff review; see `reportIncidentDb`'s own comment for why that is
     * safe here.
     */
    reportIncident: (discordId: string, incidentId: number, chargedDayzIds: string[]): Promise<ReportOutcome> =>
      reportIncidentDb(getDb(), getNow(), discordId, incidentId, chargedDayzIds),

    /** The booster kit page's one read: boosting, linked, the nine picks, the spot, the armband, any open sequence. */
    boosterKit: (discordId: string): Promise<BoosterKitView> => boosterKitForDb(getDb(), discordId, getNow()),
    /** Save one of the nine slots, checked against the committed catalogue. Refusals are an outcome; never writes the kit's position. */
    saveBoosterKitSlot: (discordId: string, slot: string, className: string): Promise<SaveKitOutcome> =>
      saveBoosterKitSlotDb(getDb(), { discordId, slot, className, now: getNow() }),
    /** Save all nine slots in one write, for the kit page's single Save button. Same catalogue check; refuses the whole kit rather than write half of it. */
    saveBoosterKit: (discordId: string, picks: Record<KitSlot, string>): Promise<SaveKitOutcome> =>
      saveBoosterKitDb(getDb(), { discordId, picks, now: getNow() }),
    /** Draw the emote sequence that marks where the kit spawns; null for an account with no linked character. */
    startKitPlacement: (discordId: string): Promise<KitChallenge | null> =>
      startKitPlacementDb(getDb(), { discordId, now: getNow(), rng: Math.random }),
    /** Close the caller's own open placement sequence. True when there was one to close. */
    cancelKitPlacement: (discordId: string): Promise<boolean> =>
      cancelKitPlacementDb(getDb(), { discordId, now: getNow() }),

    /** Every grant the viewer holds, with its derived state. */
    awards: (discordId: string): Promise<AwardSummary[]> => awardsForDb(getDb(), discordId, getNow()),
    /** One grant's page, or null when it is not the viewer's — indistinguishable from missing. */
    award: (discordId: string, grantId: number): Promise<AwardView | null> => awardForDb(getDb(), discordId, grantId, getNow()),
    /** Set or clear one of a grant's slots, checked against the award catalogue. Refusals are an outcome. */
    saveAwardPick: (discordId: string, grantId: number, slot: string, className: string): Promise<AwardWriteOutcome> =>
      saveAwardPickDb(getDb(), { discordId, grantId, slot, className, now: getNow() }),
    /** Draw the emote sequence that marks where a grant spawns. Needs every slot picked and a linked character. */
    startAwardPlacement: (discordId: string, grantId: number): Promise<AwardWriteOutcome> =>
      startAwardPlacementDb(getDb(), { discordId, grantId, now: getNow(), rng: Math.random }),
    /** Close the caller's open sequence for this grant. True when there was one. */
    cancelAwardPlacement: (discordId: string, grantId: number): Promise<boolean> =>
      cancelAwardPlacementDb(getDb(), { discordId, grantId, now: getNow() }),
  };
}

export type Roster = ReturnType<typeof makeRoster>;
