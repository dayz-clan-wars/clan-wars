import { describe, it, expect, vi } from "vitest";
import {
  buildCommands, claimCustomId, parseClaimCustomId,
  planClaimReply, flagSuggestions, MAX_PRUNE_OPTIONS,
  respondToClaimConfirm,
  INVITE_ACCEPT_PREFIX, INVITE_DECLINE_PREFIX, TRANSFER_PREFIX, DISBAND_PREFIX,
  inviteAcceptCustomId, inviteDeclineCustomId, transferCustomId, disbandCustomId,
  parseInviteAcceptCustomId, parseInviteDeclineCustomId, parseTransferCustomId, parseDisbandCustomId,
  routeRosterButton, serverChoices, deliverInviteDm, planRosterButtons,
  PUBLIC_ROSTER_SUBCOMMANDS, apologiseForFailure, INTERACTION_FAILURE_MESSAGE,
} from "../src/discord.js";
import type { FactionDeps, FactionReply } from "../src/faction-commands.js";
import type { Participant } from "../src/ceremony-store.js";
import type { FactionStore, OpenCeremony } from "../src/faction-store.js";
import type { RosterStore, Membership } from "../src/roster-store.js";
import type { RosterDeps, RosterReply, RosterPrompt } from "../src/roster-commands.js";
import {
  handleFactionInvite, handleFactionInvites, handleFactionKick, handleFactionLeave,
  handleFactionPromote, handleFactionDemote, handleFactionTransfer, handleFactionDisband,
  handleFactionRename, handleFactionInfo, handleFactionRoster,
} from "../src/roster-commands.js";

const participant = (n: number): Participant => ({
  dayzId: `dayz-${n}`.padEnd(10, "0"), discordId: `discord-${n}`, gamertag: `Player${n}`,
});

describe("faction wiring", () => {
  it("registers /faction claim with its three options", () => {
    const faction = buildCommands().find((c) => c.name === "faction");
    expect(faction).toBeDefined();
    const claim = (faction as { options?: { name: string; options?: { name: string }[] }[] })
      .options?.find((o) => o.name === "claim");
    expect(claim?.options?.map((o) => o.name)).toEqual(["name", "tag", "flag"]);
  });

  it("round-trips a ceremony id through a custom id", () => {
    expect(parseClaimCustomId(claimCustomId(42))).toBe(42);
  });

  it("refuses a custom id that is not ours", () => {
    // Discord delivers every component interaction in the guild; a foreign
    // custom id must not be parsed into a ceremony id.
    expect(parseClaimCustomId("something-else")).toBeNull();
    expect(parseClaimCustomId("claim-confirm:notanumber")).toBeNull();
  });

  it("keeps the custom id inside Discord's 100-character limit", () => {
    // The reason a claim draft is a database row rather than encoded here.
    expect(claimCustomId(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
  });
});

describe("planClaimReply", () => {
  const draft = { name: "Test", tag: "TST", texture: "Flag_Wolf" };

  it("renders plain text when there is no prompt", () => {
    const reply: FactionReply = { content: "no ceremony", ephemeral: true };
    expect(planClaimReply(reply)).toEqual({ kind: "text", content: "no ceremony" });
  });

  it("renders a select with all options pre-selected when at the cap", () => {
    const participants = Array.from({ length: MAX_PRUNE_OPTIONS }, (_, i) => participant(i));
    const reply: FactionReply = {
      content: "confirm your roster", ephemeral: true,
      prompt: { kind: "claim-confirm", ceremonyId: 42, participants, draft },
    };
    const plan = planClaimReply(reply);
    expect(plan.kind).toBe("select");
    if (plan.kind !== "select") throw new Error("expected select");
    expect(plan.customId).toBe(claimCustomId(42));
    expect(plan.options).toHaveLength(MAX_PRUNE_OPTIONS);
    expect(plan.maxValues).toBe(MAX_PRUNE_OPTIONS);
    expect(plan.options.every((o) => o.default === true)).toBe(true);
    expect(plan.options[0]).toEqual({ label: "Player0", value: participants[0]!.dayzId, default: true });
  });

  it("refuses loudly, with no select, one participant over the cap", () => {
    // The select's values BECOME the founding roster: silently slicing here
    // would drop a real participant from the faction with no error.
    const participants = Array.from({ length: MAX_PRUNE_OPTIONS + 1 }, (_, i) => participant(i));
    const reply: FactionReply = {
      content: "confirm your roster", ephemeral: true,
      prompt: { kind: "claim-confirm", ceremonyId: 42, participants, draft },
    };
    const plan = planClaimReply(reply);
    expect(plan.kind).toBe("refuse");
    expect(plan.content).toMatch(/26/);
    expect(plan.content).toMatch(new RegExp(String(MAX_PRUNE_OPTIONS)));
    expect(plan.content.toLowerCase()).toMatch(/admin/);
    expect("customId" in plan).toBe(false);
  });
});

describe("flagSuggestions", () => {
  it("returns 25 or fewer flags for an empty query", () => {
    const results = flagSuggestions("");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(25);
  });

  it("filters by a partial query", () => {
    const results = flagSuggestions("wolf");
    expect(results).toContain("Flag_Wolf");
    expect(results.every((f) => f.toLowerCase().includes("wolf"))).toBe(true);
  });

  it("returns nothing for a query that matches no flag", () => {
    expect(flagSuggestions("not-a-real-flag")).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(flagSuggestions("ZENIT")).toContain("Flag_Zenit");
    expect(flagSuggestions("zenit")).toContain("Flag_Zenit");
  });
});

describe("claim-confirm interaction", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const ceremony: OpenCeremony = {
    id: 7, serverId: 1, poleKey: "1:2:3", x: "1.00", y: "2.00", z: "3.00",
    participants: [participant(0)],
  };

  const stub = (calls: string[]): FactionDeps => {
    const store: FactionStore = {
      openCeremonyFor: async () => { calls.push("openCeremonyFor"); return ceremony; },
      openCeremonyByIdFor: async () => { calls.push("openCeremonyByIdFor"); return ceremony; },
      textureHeld: async () => false,
      saveDraft: async () => {},
      loadDraft: async () => { calls.push("loadDraft"); return { name: "N", tag: "NN", texture: "Flag_Wolf" }; },
      reserve: async () => { calls.push("reserve"); return "ok"; },
    };
    return { store, now: () => now, reservationTtlMs: 86_400_000 };
  };

  const interaction = (calls: string[], customId: string) => ({
    customId,
    userId: participant(0).discordId,
    values: [participant(0).dayzId],
    deferReply: vi.fn(async (_opts: { flags: number }) => { calls.push("deferReply"); }),
    editReply: vi.fn(async (_opts: { content: string }) => { calls.push("editReply"); }),
  });

  it("defers before it touches the database", async () => {
    // ⚠️ Confirming runs two queries plus a multi-statement transaction, and
    // Discord's initial-response window is 3 seconds. Undeferred, a timeout
    // lands in the worst possible order: reserve() has already committed, the
    // flag is out of the 33-slot pool, and the player is told "The application
    // did not respond".
    const calls: string[] = [];
    const i = interaction(calls, claimCustomId(7));
    expect(await respondToClaimConfirm(stub(calls), i)).toBe(true);
    expect(calls[0]).toBe("deferReply");
    expect(calls).toContain("reserve");
    expect(calls.indexOf("deferReply")).toBeLessThan(calls.indexOf("reserve"));
  });

  it("answers with editReply, because the response was already deferred", async () => {
    const calls: string[] = [];
    const i = interaction(calls, claimCustomId(7));
    await respondToClaimConfirm(stub(calls), i);
    expect(i.editReply).toHaveBeenCalledTimes(1);
    expect(i.editReply.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringMatching(/reserved/i) });
  });

  it("does not defer a component interaction that is not ours", async () => {
    // Discord delivers every component interaction in the guild; deferring one
    // we will not answer leaves someone else's menu showing "thinking".
    const calls: string[] = [];
    const i = interaction(calls, "some-other-menu");
    expect(await respondToClaimConfirm(stub(calls), i)).toBe(false);
    expect(i.deferReply).not.toHaveBeenCalled();
  });
});

describe("roster custom ids", () => {
  it("round-trips an invite accept id and rejects a foreign one", () => {
    expect(parseInviteAcceptCustomId(inviteAcceptCustomId(9))).toBe(9);
    expect(parseInviteAcceptCustomId("claim-confirm:9")).toBeNull();
    expect(parseInviteAcceptCustomId(`${INVITE_DECLINE_PREFIX}9`)).toBeNull();
  });

  it("round-trips an invite decline id and rejects a foreign one", () => {
    expect(parseInviteDeclineCustomId(inviteDeclineCustomId(9))).toBe(9);
    expect(parseInviteDeclineCustomId("claim-confirm:9")).toBeNull();
    expect(parseInviteDeclineCustomId(`${INVITE_ACCEPT_PREFIX}9`)).toBeNull();
  });

  it("parses a transfer custom id and rejects a foreign one", () => {
    expect(parseTransferCustomId("roster-transfer:12:d9")).toEqual({ factionId: 12, targetDiscordId: "d9" });
    expect(parseTransferCustomId("claim-confirm:12")).toBeNull();
  });

  it("round-trips a disband id and rejects a foreign one", () => {
    expect(parseDisbandCustomId(disbandCustomId(12))).toBe(12);
    expect(parseDisbandCustomId(`${TRANSFER_PREFIX}12:d9`)).toBeNull();
  });

  it("keeps every custom id inside Discord's 100-character cap", () => {
    // A Discord custom id longer than 100 chars is rejected at send time, so
    // the message never renders and the player sees nothing at all.
    expect(transferCustomId(9_007_199_254_740_991, "1".repeat(20)).length).toBeLessThanOrEqual(100);
    expect(inviteAcceptCustomId(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
    expect(inviteDeclineCustomId(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
    expect(disbandCustomId(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
  });
});

describe("routeRosterButton", () => {
  const now = new Date("2026-08-31T12:00:00Z");

  const unimplemented = (name: string) => () => { throw new Error(`unexpected call: ${name}`); };

  const fakeStore = (overrides: Partial<RosterStore>): RosterStore => ({
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
  } as RosterStore);

  const deps = (overrides: Partial<RosterStore>): RosterDeps => ({
    store: fakeStore(overrides),
    now: () => now,
    inviteTtlMs: 604_800_000,
    cooldownMs: 259_200_000,
    renameCooldownMs: 604_800_000,
  });

  const interaction = (calls: string[], customId: string) => ({
    customId,
    userId: "d1",
    deferReply: vi.fn(async () => { calls.push("deferReply"); }),
    editReply: vi.fn(async (_opts: { content: string }) => { calls.push("editReply"); }),
  });

  it("does not defer a button that is not ours", async () => {
    const calls: string[] = [];
    const d = deps({});
    const i = interaction(calls, "some-other-button");
    expect(await routeRosterButton(d, i)).toBe(false);
    expect(i.deferReply).not.toHaveBeenCalled();
  });

  it("defers before accepting an invite", async () => {
    const calls: string[] = [];
    const d = deps({ acceptInvite: async () => { calls.push("acceptInvite"); return "ok"; } });
    const i = interaction(calls, inviteAcceptCustomId(9));
    expect(await routeRosterButton(d, i)).toBe(true);
    expect(calls).toEqual(["deferReply", "acceptInvite", "editReply"]);
    expect(i.editReply).toHaveBeenCalledWith({ content: expect.stringMatching(/joined/i) });
  });

  it("defers before declining an invite", async () => {
    const calls: string[] = [];
    const d = deps({ declineInvite: async () => { calls.push("declineInvite"); return true; } });
    const i = interaction(calls, inviteDeclineCustomId(9));
    expect(await routeRosterButton(d, i)).toBe(true);
    expect(calls).toEqual(["deferReply", "declineInvite", "editReply"]);
  });

  it("defers before transferring leadership, and calls the store — not the prompt-only handler", async () => {
    const calls: string[] = [];
    const d = deps({
      transfer: async (a) => {
        calls.push("transfer");
        expect(a).toMatchObject({ factionId: 12, fromDiscordId: "d1", toDiscordId: "d9" });
        return "ok";
      },
    });
    const i = interaction(calls, transferCustomId(12, "d9"));
    expect(await routeRosterButton(d, i)).toBe(true);
    expect(calls).toEqual(["deferReply", "transfer", "editReply"]);
    expect(i.editReply).toHaveBeenCalledWith({ content: expect.stringMatching(/transfer/i) });
  });

  it("defers before disbanding, and calls the store — not the prompt-only handler", async () => {
    const calls: string[] = [];
    const d = deps({
      disband: async (factionId, discordId) => {
        calls.push("disband");
        expect(factionId).toBe(12);
        expect(discordId).toBe("d1");
        return "ok";
      },
    });
    const i = interaction(calls, disbandCustomId(12));
    expect(await routeRosterButton(d, i)).toBe(true);
    expect(calls).toEqual(["deferReply", "disband", "editReply"]);
    expect(i.editReply).toHaveBeenCalledWith({ content: expect.stringMatching(/disband/i) });
  });

  it("reports a race where the actor is no longer the leader by the time the button is pressed", async () => {
    const calls: string[] = [];
    const d = deps({ transfer: async () => "not-leader" });
    const i = interaction(calls, transferCustomId(12, "d9"));
    await routeRosterButton(d, i);
    expect(i.editReply).toHaveBeenCalledWith({ content: expect.stringMatching(/only the leader/i) });
  });
});

describe("serverChoices", () => {
  const membership = (over: Partial<Membership> = {}): Membership => ({
    factionId: 1, serverId: 1, serverName: "S1", factionName: "Bears", tag: "BEAR", role: "leader",
    ...over,
  });

  it("formats each membership as name: server name, value: server id", () => {
    const memberships = [membership({ serverId: 1, serverName: "Alpha" }), membership({ serverId: 2, serverName: "Bravo" })];
    expect(serverChoices(memberships)).toEqual([
      { name: "Alpha", value: 1 },
      { name: "Bravo", value: 2 },
    ]);
  });

  it("caps at Discord's 25-choice limit", () => {
    const memberships = Array.from({ length: 30 }, (_, i) => membership({ serverId: i, serverName: `S${i}` }));
    expect(serverChoices(memberships)).toHaveLength(25);
  });
});

describe("deliverInviteDm", () => {
  const dm: NonNullable<RosterReply["dm"]> = {
    discordId: "d9", content: "You're invited", onFailure: "Could not DM them the invite — they'll still see it with `/faction invites`.", inviteId: 7,
  };

  it("sends the DM with accept/decline buttons when the user is reachable", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = { users: { fetch: vi.fn().mockResolvedValue({ send }) } };
    const followUp = vi.fn();
    await deliverInviteDm(client, { followUp }, dm);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ content: "You're invited" });
    expect(followUp).not.toHaveBeenCalled();
  });

  it("tells the inviter, naming /faction invites, when the DM cannot be delivered", async () => {
    // A closed DM is ordinary, not an error — the invitation is already
    // durable in the database, and /faction invites is the pull route that
    // makes it reachable. What matters is the INVITER is told.
    const client = { users: { fetch: vi.fn().mockRejectedValue(new Error("DMs closed")) } };
    const followUp = vi.fn().mockResolvedValue(undefined);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await deliverInviteDm(client, { followUp }, dm);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(followUp.mock.calls[0]?.[0].content).toMatch(/\/faction invites/);
    warned.mockRestore();
  });
});

describe("planRosterButtons", () => {
  it("renders nothing for a reply with no prompt", () => {
    expect(planRosterButtons(undefined)).toEqual([]);
  });

  it("renders a single confirm-transfer row", () => {
    const prompt: RosterPrompt = { kind: "confirm-transfer", factionId: 12, targetDiscordId: "d9" };
    expect(planRosterButtons(prompt)).toEqual([
      [{ customId: transferCustomId(12, "d9"), label: "Confirm transfer", style: "danger" }],
    ]);
  });

  it("renders a single confirm-disband row", () => {
    const prompt: RosterPrompt = { kind: "confirm-disband", factionId: 12 };
    expect(planRosterButtons(prompt)).toEqual([
      [{ customId: disbandCustomId(12), label: "Confirm disband", style: "danger" }],
    ]);
  });

  it("renders one accept/decline row per listed invite, on the same custom ids the DM path uses", () => {
    const prompt: RosterPrompt = {
      kind: "list-invites",
      invites: [{ id: 7, tag: "BEAR" }, { id: 8, tag: "WOLF" }],
      hiddenCount: 0,
    };
    expect(planRosterButtons(prompt)).toEqual([
      [
        { customId: inviteAcceptCustomId(7), label: "Accept BEAR", style: "success" },
        { customId: inviteDeclineCustomId(7), label: "Decline BEAR", style: "danger" },
      ],
      [
        { customId: inviteAcceptCustomId(8), label: "Accept WOLF", style: "success" },
        { customId: inviteDeclineCustomId(8), label: "Decline WOLF", style: "danger" },
      ],
    ]);
  });

  it("stays inside Discord's five-row cap even at MAX_LISTED_INVITES", () => {
    const invites = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, tag: `T${i}` }));
    const prompt: RosterPrompt = { kind: "list-invites", invites, hiddenCount: 3 };
    expect(planRosterButtons(prompt)).toHaveLength(5);
  });
});

describe("apologiseForFailure", () => {
  const fake = (over: Partial<{ deferred: boolean; replied: boolean }> = {}) => ({
    deferred: true, replied: false, editReply: vi.fn(async () => undefined), ...over,
  });

  it("answers a deferred interaction so it cannot hang on thinking", async () => {
    const i = fake();
    await apologiseForFailure(i);
    expect(i.editReply).toHaveBeenCalledWith({ content: INTERACTION_FAILURE_MESSAGE });
  });

  it("says nothing when the interaction was never deferred", async () => {
    const i = fake({ deferred: false });
    await apologiseForFailure(i);
    expect(i.editReply).not.toHaveBeenCalled();
  });

  it("says nothing when the interaction was already answered", async () => {
    const i = fake({ replied: true });
    await apologiseForFailure(i);
    expect(i.editReply).not.toHaveBeenCalled();
  });

  it("swallows a dead interaction token rather than becoming an unhandled rejection", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const i = { deferred: true, replied: false, editReply: vi.fn(async () => { throw new Error("Unknown interaction"); }) };
    await expect(apologiseForFailure(i)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

/**
 * `PUBLIC_ROSTER_SUBCOMMANDS` picks the defer flags before the handler runs,
 * and each handler independently sets `RosterReply.ephemeral`. The wiring
 * uses the set and ignores the field, so nothing but this test stops the two
 * from drifting into disagreement — at which point a reply Discord already
 * committed to being ephemeral would claim to be public, or the reverse.
 */
describe("PUBLIC_ROSTER_SUBCOMMANDS agrees with the handlers", () => {
  const store = {
    membershipsFor: async () => [{ factionId: 1, serverId: 1, serverName: "S", factionName: "Bears", tag: "BEAR", role: "leader" as const }],
    linkFor: async () => null,
    factionByName: async () => ({
      id: 1, serverId: 1, serverName: "S", name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      status: "active", poleKey: "1:2:3", memberCount: 1, leaderDiscordId: "d1",
      createdAt: new Date("2026-08-31T12:00:00Z"),
    }),
    rosterOf: async () => [],
    createInvite: async () => ({ outcome: "ok" as const, inviteId: 7 }),
    kick: async () => "ok" as const,
    leave: async () => "ok" as const,
    setRole: async () => "ok" as const,
    rename: async () => "ok" as const,
  } as unknown as RosterStore;
  const deps: RosterDeps = {
    store, now: () => new Date("2026-08-31T12:00:00Z"),
    inviteTtlMs: 1, cooldownMs: 1, renameCooldownMs: 1,
  };
  const U = "d1";
  const target = { serverId: null, targetDiscordId: "d2" };

  const invocations: Record<string, () => Promise<RosterReply>> = {
    invite: () => handleFactionInvite(deps, U, { serverId: null, inviteeDiscordId: "d2" }),
    invites: () => handleFactionInvites(deps, U),
    kick: () => handleFactionKick(deps, U, target),
    leave: () => handleFactionLeave(deps, U, null),
    promote: () => handleFactionPromote(deps, U, target),
    demote: () => handleFactionDemote(deps, U, target),
    transfer: () => handleFactionTransfer(deps, U, target),
    disband: () => handleFactionDisband(deps, U, null),
    rename: () => handleFactionRename(deps, U, { serverId: null, name: "Cubs" }),
    info: () => handleFactionInfo(deps, U, "Bears", null),
    roster: () => handleFactionRoster(deps, U, "Bears", null),
  };

  it("covers every roster subcommand the wiring registers", () => {
    const registered = (buildCommands().find((c) => c.name === "faction") as { options: { name: string }[] })
      .options.map((o) => o.name).filter((n) => n !== "claim");
    expect(new Set(registered)).toEqual(new Set(Object.keys(invocations)));
    for (const sub of PUBLIC_ROSTER_SUBCOMMANDS) expect(registered).toContain(sub);
  });

  for (const [sub, run] of Object.entries(invocations)) {
    it(`${sub} replies ${PUBLIC_ROSTER_SUBCOMMANDS.has(sub) ? "publicly" : "ephemerally"}`, async () => {
      const reply = await run();
      expect(reply.ephemeral).toBe(!PUBLIC_ROSTER_SUBCOMMANDS.has(sub));
    });
  }
});
