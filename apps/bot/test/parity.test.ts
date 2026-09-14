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
 * ⚠️ Reads are deliberately NOT here. Most of them DO have commands now —
 * `/me show`, `/clan info`, `/clans list`, `/vault list`, `/map pins`,
 * `/scoreboard`, `/player`, `/board` and the rest — but a test that demanded
 * one command per read export would have to carve out the two things that
 * stay site-only by design (spec §2.2): the drawn map behind `/map view`,
 * and board pagination past the first pages. Carving those out is how a
 * list stops meaning anything, so reads are listed by name below instead.
 */
const COMMANDS: Record<string, string> = {
  startLink: "link start", cancelLink: "link cancel", unlink: "link unlink",
  declareSolo: "base declare", releaseSolo: "base release",
  acceptInvite: "me accept", declineInvite: "me decline", withdrawRequest: "me withdraw",
  invite: "roster invite", revokeInvite: "roster revoke", decideRequest: "roster decide",
  kick: "roster kick", promote: "roster promote", demote: "roster demote", transfer: "roster transfer",
  leave: "clan leave", rename: "clan rename", setRecruitingPost: "clan recruiting",
  confirmRebind: "clan rebind", disband: "clan disband",
  requestJoin: "clans join",
  claimSuccession: "lead claim", openVote: "lead vote", castVote: "lead ballot",
  claimCeremony: "found",
  grantGuestPass: "guest grant", revokeGuestPass: "guest revoke",
  addLock: "vault add", editLock: "vault edit", deleteLock: "vault delete",
  revealLock: "vault reveal", confirmLock: "vault confirm", rotateLocks: "vault rotate",
  dropPin: "map pin", deletePin: "map unpin",
};

/**
 * Empty, and that is the point: every write `@factions/roster` exports has a
 * command. A new write lands here only if a future increment ships one
 * without a Discord command — and then this file says which plan owes it.
 */
const PENDING: Record<string, string> = {};

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
