import { describe, it, expect } from "vitest";

/**
 * The capability rule (target spec §10.4; frontend rebuild §3). The site can
 * do exactly what this package exports, so the export list IS the
 * permission list. It is pinned by name, in full, and apps/web pins the
 * same list from its side — adding an export means editing both on purpose.
 *
 * ⚠️ An allowlist, not a denylist. A denylist of forbidden names can be
 * dodged by a synonym; an allowlist cannot grow by accident.
 */
export const ROSTER_EXPORTS = ["BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE", "ISSUE_OUTCOME_KINDS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX", "acceptInvite", "achievementsFor", "addLock", "alphas", "attention", "baseFor", "boardPage", "cancelLink", "castVote", "claimCeremony", "claimContext", "claimSuccession", "clanBoard", "clanBoardPage", "clanByTag", "clanFor", "confirmLock", "confirmRebind", "decideRequest", "declareSolo", "declineInvite", "deleteLock", "deletePin", "demote", "directory", "disband", "dropPin", "editLock", "grantGuestPass", "invite", "kick", "leave", "linkStatus", "liveServers", "mapState", "myInvites", "myRequests", "openVote", "playerBoards", "playerFeed", "playerProfile", "promote", "releaseSolo", "rename", "requestJoin", "revealLock", "revokeGuestPass", "revokeInvite", "rotateLocks", "scoreboard", "searchGamertags", "seasons", "setRecruitingPost", "startLink", "suggestGamertags", "transfer", "unlink", "vaultFor", "viewerFor", "warLog", "withdrawRequest"] as const;

describe("@factions/roster exports exactly its allowlist", () => {
  it("matches", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod).sort()).toEqual([...ROSTER_EXPORTS].sort());
  });

  it("exports nothing that could set a clan active or dormant, write a raid, or bind a pole", async () => {
    const mod = await import("../src/index");
    const names = Object.keys(mod).map((n) => n.toLowerCase());
    for (const bad of ["activate", "dormant", "raid", "defense", "declaration", "reserve", "createfaction", "insert"]) {
      expect(names.filter((n) => n.includes(bad))).toEqual([]);
    }
  });
});
