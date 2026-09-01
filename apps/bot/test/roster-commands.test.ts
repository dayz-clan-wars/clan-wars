import { describe, it, expect, vi } from "vitest";
import type { RosterStore, Membership, PendingInvite } from "../src/roster-store.js";
import {
  handleFactionInvite, handleFactionInvites, handleInviteAccept, handleInviteDecline,
  handleFactionKick, handleFactionLeave,
  handleFactionPromote, handleFactionDemote, handleFactionTransfer,
  handleFactionDisband, handleFactionRename,
  type RosterDeps,
} from "../src/roster-commands.js";

const now = new Date("2026-08-31T12:00:00Z");

const membership = (over: Partial<Membership> = {}): Membership => ({
  factionId: 1, serverId: 1, serverName: "S", factionName: "Bears", tag: "BEAR", role: "leader",
  ...over,
});

/** A hand-written fake satisfying the full `RosterStore` interface. Methods
 * this suite never exercises throw if called, so an accidental write shows
 * up as a test failure instead of silently succeeding. */
function fakeStore(overrides: Partial<RosterStore>): RosterStore {
  const unimplemented = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    membershipsFor: unimplemented("membershipsFor"),
    linkFor: unimplemented("linkFor"),
    linkForDayzId: unimplemented("linkForDayzId"),
    memberOf: unimplemented("memberOf"),
    rosterOf: unimplemented("rosterOf"),
    factionById: unimplemented("factionById"),
    factionByName: unimplemented("factionByName"),
    cooldownUntil: unimplemented("cooldownUntil"),
    createInvite: unimplemented("createInvite"),
    pendingInvitesFor: unimplemented("pendingInvitesFor"),
    acceptInvite: unimplemented("acceptInvite"),
    declineInvite: unimplemented("declineInvite"),
    kick: unimplemented("kick"),
    leave: unimplemented("leave"),
    setRole: unimplemented("setRole"),
    transfer: unimplemented("transfer"),
    disband: unimplemented("disband"),
    rename: unimplemented("rename"),
    ...overrides,
  } as RosterStore;
}

const deps = (overrides: Partial<RosterStore>): RosterDeps => ({
  store: fakeStore(overrides),
  now: () => now,
  inviteTtlMs: 604_800_000,
  cooldownMs: 259_200_000,
  renameCooldownMs: 604_800_000,
});

describe("handleFactionInvite", () => {
  it("refuses when the actor holds no faction", async () => {
    const r = await handleFactionInvite(deps({ membershipsFor: async () => [] }), "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("refuses when the actor is a plain member", async () => {
    const d = deps({ membershipsFor: async () => [membership({ role: "member" })] });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toBe("Only the leader and officers can invite.");
    expect(r.ephemeral).toBe(true);
  });

  it("refuses when the invitee has no linked character, without writing an invite", async () => {
    const createInvite = vi.fn();
    const d = deps({
      membershipsFor: async () => [membership()],
      linkFor: async () => null,
      createInvite,
    });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/has not linked a character yet/i);
    expect(r.content).toMatch(/\/link/);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("reports already-member distinctly", async () => {
    const d = deps({
      membershipsFor: async () => [membership()],
      linkFor: async () => ({ dayzId: "P1", gamertag: "G" }),
      createInvite: async () => ({ outcome: "already-member" as const, inviteId: null }),
    });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/already in a faction/i);
  });

  it("reports cooldown distinctly", async () => {
    const d = deps({
      membershipsFor: async () => [membership()],
      linkFor: async () => ({ dayzId: "P1", gamertag: "G" }),
      createInvite: async () => ({ outcome: "cooldown" as const, inviteId: null }),
    });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/cooldown/i);
  });

  it("reports not-holding distinctly", async () => {
    const d = deps({
      membershipsFor: async () => [membership()],
      linkFor: async () => ({ dayzId: "P1", gamertag: "G" }),
      createInvite: async () => ({ outcome: "not-holding" as const, inviteId: null }),
    });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/no longer active/i);
  });

  it("succeeds and includes a DM to the invitee", async () => {
    const createInvite = vi.fn(async () => ({ outcome: "ok" as const, inviteId: 42 }));
    const d = deps({
      membershipsFor: async () => [membership()],
      linkFor: async () => ({ dayzId: "P1", gamertag: "G" }),
      createInvite,
    });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/Invited/);
    expect(r.dm?.discordId).toBe("d9");
    expect(r.dm?.content).toMatch(/Bears/);
    expect(createInvite).toHaveBeenCalledWith(expect.objectContaining({
      factionId: 1, serverId: 1, inviteeDiscordId: "d9", inviteeDayzId: "P1", invitedByDiscordId: "d1",
      at: now, expiresAt: new Date(now.getTime() + 604_800_000),
    }));
  });

  it("refuses an ambiguous actor without a named server", async () => {
    const d = deps({ membershipsFor: async () => [membership({ serverId: 1 }), membership({ serverId: 2 })] });
    const r = await handleFactionInvite(d, "d1", { serverId: null, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/more than one server/i);
  });

  it("refuses a named server the actor holds no faction on", async () => {
    const d = deps({ membershipsFor: async () => [membership({ serverId: 1 })] });
    const r = await handleFactionInvite(d, "d1", { serverId: 99, inviteeDiscordId: "d9" });
    expect(r.content).toMatch(/don't hold a faction on that server/i);
  });
});

describe("handleFactionInvites", () => {
  it("asks the caller to link when they have none", async () => {
    const d = deps({ linkFor: async () => null });
    const r = await handleFactionInvites(d, "d9");
    expect(r.content).toMatch(/link a character/i);
  });

  it("reports no pending invitations", async () => {
    const d = deps({ linkFor: async () => ({ dayzId: "P1", gamertag: "G" }), pendingInvitesFor: async () => [] });
    const r = await handleFactionInvites(d, "d9");
    expect(r.content).toMatch(/no pending invitations/i);
  });

  it("lists pending invitations", async () => {
    const invite: PendingInvite = {
      id: 7, factionId: 1, factionName: "Bears", tag: "BEAR",
      serverId: 1, serverName: "S", expiresAt: new Date(now.getTime() + 1000),
    };
    const d = deps({ linkFor: async () => ({ dayzId: "P1", gamertag: "G" }), pendingInvitesFor: async () => [invite] });
    const r = await handleFactionInvites(d, "d9");
    expect(r.content).toMatch(/Bears/);
    expect(r.content).toMatch(/BEAR/);
  });
});

describe("handleInviteAccept", () => {
  it("maps every store outcome to a distinct reply", async () => {
    const cases: Array<["ok" | "gone" | "already-member" | "cooldown" | "not-holding", RegExp]> = [
      ["ok", /joined/i],
      ["gone", /no longer available/i],
      ["already-member", /already in a faction/i],
      ["cooldown", /cooldown/i],
      ["not-holding", /no longer active/i],
    ];
    const seen = new Set<string>();
    for (const [outcome, expected] of cases) {
      const d = deps({ acceptInvite: async () => outcome });
      const r = await handleInviteAccept(d, "d9", 42);
      expect(r.content).toMatch(expected);
      expect(seen.has(r.content)).toBe(false);
      seen.add(r.content);
      expect(r.ephemeral).toBe(true);
    }
  });
});

describe("handleInviteDecline", () => {
  it("confirms a successful decline", async () => {
    const d = deps({ declineInvite: async () => true });
    const r = await handleInviteDecline(d, "d9", 42);
    expect(r.content).toMatch(/declined/i);
  });

  it("reports when the invite is no longer available", async () => {
    const d = deps({ declineInvite: async () => false });
    const r = await handleInviteDecline(d, "d9", 42);
    expect(r.content).toMatch(/no longer available/i);
  });
});

describe("handleFactionKick", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionKick(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("maps every store outcome to a distinct reply", async () => {
    const cases: Array<[
      "ok" | "not-permitted" | "target-not-member" | "cannot-kick-self" | "cannot-kick-officer" | "cannot-kick-leader",
      RegExp,
    ]> = [
      ["ok", /kicked/i],
      ["not-permitted", /leader and officers can kick/i],
      ["target-not-member", /not in .*Bears/i],
      ["cannot-kick-self", /can't kick yourself/i],
      ["cannot-kick-officer", /can't kick other officers/i],
      ["cannot-kick-leader", /can't kick the leader/i],
    ];
    const seen = new Set<string>();
    for (const [outcome, expected] of cases) {
      const d = deps({ membershipsFor: async () => [membership()], kick: async () => outcome });
      const r = await handleFactionKick(d, "d1", { serverId: null, targetDiscordId: "d9" });
      expect(r.content).toMatch(expected);
      expect(seen.has(r.content)).toBe(false);
      seen.add(r.content);
      expect(r.ephemeral).toBe(true);
    }
  });

  it("names the cooldown and the server on success", async () => {
    const d = deps({ membershipsFor: async () => [membership()], kick: async () => "ok" as const });
    const r = await handleFactionKick(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.content).toMatch(/cannot join a faction on \*\*S\*\* for 3 days/);
  });

  it("passes the cooldown window through to the store", async () => {
    const kick = vi.fn(async () => "ok" as const);
    const d = deps({ membershipsFor: async () => [membership()], kick });
    await handleFactionKick(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(kick).toHaveBeenCalledWith({
      factionId: 1, actorDiscordId: "d1", targetDiscordId: "d9",
      at: now, until: new Date(now.getTime() + 259_200_000),
    });
  });
});

describe("handleFactionLeave", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionLeave(d, "d1", null);
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("maps every store outcome to a distinct reply", async () => {
    const cases: Array<["ok" | "not-member" | "leader-must-transfer", RegExp]> = [
      ["ok", /you left/i],
      ["not-member", /not in .*Bears/i],
      ["leader-must-transfer", /transfer leadership/i],
    ];
    const seen = new Set<string>();
    for (const [outcome, expected] of cases) {
      const d = deps({ membershipsFor: async () => [membership()], leave: async () => outcome });
      const r = await handleFactionLeave(d, "d1", null);
      expect(r.content).toMatch(expected);
      expect(seen.has(r.content)).toBe(false);
      seen.add(r.content);
      expect(r.ephemeral).toBe(true);
    }
  });

  it("names the cooldown and the server on success", async () => {
    const d = deps({ membershipsFor: async () => [membership()], leave: async () => "ok" as const });
    const r = await handleFactionLeave(d, "d1", null);
    expect(r.content).toMatch(/cannot join a faction on \*\*S\*\* for 3 days/);
  });

  it("passes the cooldown window through to the store", async () => {
    const leave = vi.fn(async () => "ok" as const);
    const d = deps({ membershipsFor: async () => [membership()], leave });
    await handleFactionLeave(d, "d1", null);
    expect(leave).toHaveBeenCalledWith({
      factionId: 1, discordId: "d1",
      at: now, until: new Date(now.getTime() + 259_200_000),
    });
  });
});

describe("handleFactionPromote", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionPromote(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("maps every store outcome to a distinct reply", async () => {
    const cases: Array<["ok" | "not-leader" | "target-not-member" | "cannot-target-leader", RegExp]> = [
      ["ok", /officer/i],
      ["not-leader", /leader can promote/i],
      ["target-not-member", /not in .*Bears/i],
      ["cannot-target-leader", /leader doesn't need promoting/i],
    ];
    const seen = new Set<string>();
    for (const [outcome, expected] of cases) {
      const d = deps({ membershipsFor: async () => [membership()], setRole: async () => outcome });
      const r = await handleFactionPromote(d, "d1", { serverId: null, targetDiscordId: "d9" });
      expect(r.content).toMatch(expected);
      expect(seen.has(r.content)).toBe(false);
      seen.add(r.content);
      expect(r.ephemeral).toBe(true);
    }
  });

  it("passes the role and target through to the store", async () => {
    const setRole = vi.fn(async () => "ok" as const);
    const d = deps({ membershipsFor: async () => [membership()], setRole });
    await handleFactionPromote(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(setRole).toHaveBeenCalledWith({
      factionId: 1, actorDiscordId: "d1", targetDiscordId: "d9", role: "officer",
    });
  });
});

describe("handleFactionDemote", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionDemote(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("maps every store outcome to a distinct reply", async () => {
    const cases: Array<["ok" | "not-leader" | "target-not-member" | "cannot-target-leader", RegExp]> = [
      ["ok", /member/i],
      ["not-leader", /leader can demote/i],
      ["target-not-member", /not in .*Bears/i],
      ["cannot-target-leader", /can't demote the leader/i],
    ];
    const seen = new Set<string>();
    for (const [outcome, expected] of cases) {
      const d = deps({ membershipsFor: async () => [membership()], setRole: async () => outcome });
      const r = await handleFactionDemote(d, "d1", { serverId: null, targetDiscordId: "d9" });
      expect(r.content).toMatch(expected);
      expect(seen.has(r.content)).toBe(false);
      seen.add(r.content);
      expect(r.ephemeral).toBe(true);
    }
  });

  it("passes the role and target through to the store", async () => {
    const setRole = vi.fn(async () => "ok" as const);
    const d = deps({ membershipsFor: async () => [membership()], setRole });
    await handleFactionDemote(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(setRole).toHaveBeenCalledWith({
      factionId: 1, actorDiscordId: "d1", targetDiscordId: "d9", role: "member",
    });
  });
});

describe("handleFactionTransfer", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionTransfer(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("refuses a non-leader without touching the store", async () => {
    const d = deps({ membershipsFor: async () => [membership({ role: "officer" })] });
    const r = await handleFactionTransfer(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.content).toMatch(/only the leader can transfer/i);
    expect(r.prompt).toBeUndefined();
  });

  it("does not call the store and returns a confirm-transfer prompt", async () => {
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })] });
    const r = await handleFactionTransfer(d, "d1", { serverId: null, targetDiscordId: "d9" });
    expect(r.prompt).toEqual({ kind: "confirm-transfer", factionId: 1, targetDiscordId: "d9" });
    expect(r.ephemeral).toBe(true);
  });
});

describe("handleFactionDisband", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionDisband(d, "d1", null);
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("refuses a non-leader without touching the store", async () => {
    const d = deps({ membershipsFor: async () => [membership({ role: "officer" })] });
    const r = await handleFactionDisband(d, "d1", null);
    expect(r.content).toMatch(/only the leader can disband/i);
    expect(r.prompt).toBeUndefined();
  });

  it("does not call the store and returns a confirm-disband prompt", async () => {
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })] });
    const r = await handleFactionDisband(d, "d1", null);
    expect(r.prompt).toEqual({ kind: "confirm-disband", factionId: 1 });
    expect(r.ephemeral).toBe(true);
  });
});

describe("handleFactionRename", () => {
  it("refuses when the actor holds no faction", async () => {
    const d = deps({ membershipsFor: async () => [] });
    const r = await handleFactionRename(d, "d1", { serverId: null, name: "Bears" });
    expect(r.content).toMatch(/not in a faction/i);
  });

  it("refuses a name that's too short without touching the store", async () => {
    const rename = vi.fn();
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })], rename });
    const r = await handleFactionRename(d, "d1", { serverId: null, name: "AB" });
    expect(r.content).toMatch(/3-64 characters/i);
    expect(rename).not.toHaveBeenCalled();
  });

  it("refuses a name that's too long without touching the store", async () => {
    const rename = vi.fn();
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })], rename });
    const r = await handleFactionRename(d, "d1", { serverId: null, name: "x".repeat(65) });
    expect(r.content).toMatch(/3-64 characters/i);
    expect(rename).not.toHaveBeenCalled();
  });

  it("refuses a name containing control characters without touching the store", async () => {
    const rename = vi.fn();
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })], rename });
    const r = await handleFactionRename(d, "d1", { serverId: null, name: "Bad\u200BName" });
    expect(r.content).toMatch(/control characters/i);
    expect(rename).not.toHaveBeenCalled();
  });

  it("trims the name before validating and passing it to the store", async () => {
    const rename = vi.fn(async () => "ok" as const);
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })], rename });
    await handleFactionRename(d, "d1", { serverId: null, name: "  Bears  " });
    expect(rename).toHaveBeenCalledWith({
      factionId: 1, discordId: "d1", name: "Bears", at: now, notBefore: new Date(now.getTime() - 604_800_000),
    });
  });

  it("maps not-leader and cooldown outcomes to messages", async () => {
    for (const [outcome, expected] of [["not-leader", /only the leader can rename/i], ["cooldown", /renamed too recently/i]] as const) {
      const d = deps({ membershipsFor: async () => [membership({ role: "leader" })], rename: async () => outcome });
      const r = await handleFactionRename(d, "d1", { serverId: null, name: "Bears" });
      expect(r.content).toMatch(expected);
    }
  });

  it("confirms success with the new name", async () => {
    const d = deps({ membershipsFor: async () => [membership({ role: "leader" })], rename: async () => "ok" });
    const r = await handleFactionRename(d, "d1", { serverId: null, name: "Bears" });
    expect(r.content).toMatch(/now named \*\*Bears\*\*/);
  });
});
