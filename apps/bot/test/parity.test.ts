import { describe, it, expect } from "vitest";
import { SPECS } from "../src/commands/index.js";

/**
 * Spec §2.1: every player WRITE the site can make, Discord can make too.
 *
 * The map below is the claim, written down. `PENDING` is the honest part: a
 * write lands here the moment `packages/roster` exports it, and moves to
 * `COMMANDS` when its command ships. The last assertion is what makes the
 * list expensive to ignore — a new roster export that is neither mapped nor
 * explicitly deferred fails this suite, so parity cannot rot quietly on the
 * next increment.
 *
 * ⚠️ Reads are deliberately NOT here. `/map` and deep board pagination are
 * site-only by design (spec §2.2); a test that demanded a command per read
 * would have to carve out exceptions and would stop meaning anything.
 */
const COMMANDS: Record<string, string> = {
  startLink: "link start",
  cancelLink: "link cancel",
  unlink: "link unlink",
  declareSolo: "base declare",
  releaseSolo: "base release",
};

/** Shipping in plans 2 and 3. Each entry names the plan that removes it. */
const PENDING: Record<string, string> = {
  invite: "plan 2", revokeInvite: "plan 2", acceptInvite: "plan 2", declineInvite: "plan 2",
  requestJoin: "plan 2", withdrawRequest: "plan 2", decideRequest: "plan 2", leave: "plan 2",
  kick: "plan 2", promote: "plan 2", demote: "plan 2", transfer: "plan 2", disband: "plan 2",
  rename: "plan 2", setRecruitingPost: "plan 2", claimCeremony: "plan 2", confirmRebind: "plan 2",
  claimSuccession: "plan 2", openVote: "plan 2", castVote: "plan 2",
  grantGuestPass: "plan 2", revokeGuestPass: "plan 2",
  addLock: "plan 3", editLock: "plan 3", deleteLock: "plan 3", revealLock: "plan 3",
  confirmLock: "plan 3", rotateLocks: "plan 3", dropPin: "plan 3", deletePin: "plan 3",
};

/** Every roster export that WRITES. Reads are excluded by name, on purpose, and reviewed when this list changes. */
const WRITES = [...Object.keys(COMMANDS), ...Object.keys(PENDING)];

describe("Discord parity with the site", () => {
  it("routes every shipped write to a registered command", () => {
    for (const [write, path] of Object.entries(COMMANDS)) {
      expect(SPECS.has(path), `${write} maps to /${path}, which has no handler`).toBe(true);
    }
  });

  it("does not list a write as both shipped and pending", () => {
    for (const write of Object.keys(COMMANDS)) {
      expect(Object.hasOwn(PENDING, write), `${write} is in both COMMANDS and PENDING`).toBe(false);
    }
  });

  it("accounts for every write @factions/roster exports", async () => {
    // ⚠️ Not `exports.test.js` — importing another file's `.test.ts` would
    // re-register its describes. The plain module `roster-exports.ts` holds
    // the const precisely so this file (and apps/web) can import it safely.
    const { ROSTER_EXPORTS } = await import("../../../packages/roster/test/roster-exports.js");
    const known = new Set(WRITES);
    // Names that read. Anything not here and not in `known` is a new export
    // nobody has decided about — which is exactly what this test is for.
    const reads = new Set([
      "attention", "liveServers", "viewerFor", "linkStatus", "searchGamertags", "suggestGamertags",
      "baseFor", "clanFor", "directory", "clanByTag", "claimContext", "myInvites", "myRequests",
      "scoreboard", "alphas", "seasons", "warLog", "mapState", "playerBoards", "playerProfile",
      "achievementsFor", "clanBoard", "clanBoardPage", "boardPage", "playerFeed", "vaultFor",
      "makeRoster",
      "BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE",
      "ISSUE_OUTCOME_KINDS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX",
    ]);
    const unaccounted = ROSTER_EXPORTS.filter((n) => !known.has(n) && !reads.has(n));
    expect(unaccounted, "new roster export with no command and no decision — add it to COMMANDS, PENDING, or reads").toEqual([]);
  });
});
