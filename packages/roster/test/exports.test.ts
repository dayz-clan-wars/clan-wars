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
export const ROSTER_EXPORTS = ["DECLARE_SOLO_REASONS", "ISSUE_OUTCOME_KINDS", "acceptInvite", "baseFor", "cancelLink", "claimCeremony", "claimContext", "clanByTag", "clanFor", "confirmRebind", "decideRequest", "declareSolo", "declineInvite", "demote", "directory", "disband", "invite", "kick", "leave", "linkStatus", "myInvites", "myRequests", "promote", "releaseSolo", "rename", "requestJoin", "revokeInvite", "searchGamertags", "setRecruitingPost", "startLink", "transfer", "unlink", "viewerFor", "withdrawRequest"] as const;

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
