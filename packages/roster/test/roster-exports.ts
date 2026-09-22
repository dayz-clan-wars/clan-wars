/**
 * The capability rule (target spec §10.4; frontend rebuild §3). The site can
 * do exactly what this package exports, so the export list IS the
 * permission list. It is pinned by name, in full, and apps/web pins the
 * same list from its side — adding an export means editing both on purpose.
 *
 * ⚠️ An allowlist, not a denylist. A denylist of forbidden names can be
 * dodged by a synonym; an allowlist cannot grow by accident.
 */
export const ROSTER_EXPORTS = ["BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE", "ISSUE_OUTCOME_KINDS", "NOTIFICATIONS_PAGE_SIZE", "REPORT_REASONS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX", "acceptInvite", "achievementsFor", "addLock", "alphas", "attention", "award", "awards", "baseDamageWindow", "baseFor", "boardPage", "boosterKit", "cancelAwardPlacement", "cancelKitPlacement", "cancelLink", "castVote", "claimCeremony", "claimContext", "claimSuccession", "clanBoard", "clanBoardPage", "clanByTag", "clanFor", "confirmLock", "confirmRebind", "decideRequest", "declareSolo", "declineInvite", "deleteLock", "deletePin", "demote", "directory", "disband", "dropPin", "editLock", "grantGuestPass", "invite", "kick", "leave", "linkStatus", "liveServers", "makeRoster", "mapState", "markAllNoticesRead", "markNoticeRead", "myInvites", "myRequests", "notificationsFor", "openVote", "playerBoards", "playerFeed", "playerProfile", "promote", "releaseSolo", "rename", "reportIncident", "requestJoin", "restartsScheduled", "revealLock", "revokeGuestPass", "revokeInvite", "rotateLocks", "saveAwardPick", "saveBoosterKit", "saveBoosterKitSlot", "scoreboard", "searchGamertags", "seasons", "setRecruitingPost", "startAwardPlacement", "startKitPlacement", "startLink", "suggestGamertags", "transfer", "unlink", "vaultFor", "viewerFor", "warLog", "withdrawRequest"] as const;
