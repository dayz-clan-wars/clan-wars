import { describe, it, expect, vi } from "vitest";
import {
  buildCommands, claimCustomId, parseClaimCustomId,
  planClaimReply, flagSuggestions, MAX_PRUNE_OPTIONS,
  respondToClaimConfirm,
} from "../src/discord.js";
import type { FactionDeps, FactionReply } from "../src/faction-commands.js";
import type { Participant } from "../src/ceremony-store.js";
import type { FactionStore, OpenCeremony } from "../src/faction-store.js";

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
