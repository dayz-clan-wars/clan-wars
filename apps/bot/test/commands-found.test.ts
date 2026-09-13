import { describe, it, expect, afterEach } from "vitest";
import { discordCopy } from "@factions/copy";
import type { ClaimContext } from "@factions/roster";
import { foundGroup } from "../src/commands/found.js";
import { foundEmbed } from "../src/commands/embeds/found.js";
import { getDraft, clearDraft, DRAFT_TTL_MS } from "../src/commands/founding-draft.js";
import { specOf, ctxWith, input } from "./command-fakes.js";

const spec = (path: string) => specOf(foundGroup, path);

function context(over: Partial<NonNullable<ClaimContext>> = {}): NonNullable<ClaimContext> {
  return {
    ceremony: {
      id: 9,
      detectedAt: new Date("2026-09-13T00:00:00Z"),
      expiresAt: new Date("2026-09-13T00:30:00Z"),
      participants: [
        { dayzId: "a", gamertag: "Alpha", discordId: "111" },
        { dayzId: "b", gamertag: "Bravo", discordId: "222" },
        { dayzId: "c", gamertag: "Charlie", discordId: "333" },
      ],
    },
    freeFlags: ["Flag_Zenit", "Flag_Livonia"],
    ...over,
  };
}

afterEach(() => {
  clearDraft("111");
});

describe("/found", () => {
  it("says so when there is no open ceremony", async () => {
    const ctx = ctxWith({ claimContext: async () => null });
    const reply = await spec("found").handler(ctx, input());
    expect(reply.content).toContain("ceremony");
    expect(reply.components).toBeUndefined();
  });

  it("seeds a draft with every participant and no flag", async () => {
    const ctx = ctxWith({ claimContext: async () => context() });
    await spec("found").handler(ctx, input());
    expect(getDraft("111", ctx.now)).toEqual({ ceremonyId: 9, texture: null, memberDayzIds: ["a", "b", "c"] });
  });

  it("offers at most 25 flags — Discord rejects a longer select menu", async () => {
    const flags = Array.from({ length: 40 }, (_, n) => `Flag_${n}`);
    const ctx = ctxWith({ claimContext: async () => context({ freeFlags: flags }) });
    const reply = await spec("found").handler(ctx, input());
    const menu = reply.components![0]!.toJSON() as { components: { options: unknown[] }[] };
    expect(menu.components[0]!.options).toHaveLength(25);
  });
});

describe("/found selections", () => {
  it("records the chosen flag without writing anything", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => { seen.push("ran"); return "ok"; } });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    expect(getDraft("111", ctx.now)!.texture).toBe("Flag_Zenit");
    expect(seen).toEqual([]);
  });

  it("records a pruned crew", async () => {
    const ctx = ctxWith({ claimContext: async () => context() });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-crew"]!(ctx, { actorDiscordId: "111", arg: null, values: ["a", "c"] });
    expect(getDraft("111", ctx.now)!.memberDayzIds).toEqual(["a", "c"]);
  });
});

describe("/found modal submit", () => {
  it("sends the draft's flag and crew with the modal's name and tag", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({
      claimContext: async () => context(),
      claimCeremony: async (d: string, id: number, a: unknown) => { seen.push([d, id, a]); return "ok"; },
    });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    const reply = await foundGroup.modals!.found!(ctx, {
      actorDiscordId: "111", arg: "9", field: (n) => (n === "name" ? "Wolves" : "WLF"),
    });
    expect(seen).toEqual([["111", 9, { name: "Wolves", tag: "WLF", texture: "Flag_Zenit", memberDayzIds: ["a", "b", "c"] }]]);
    expect(reply.content).toBe(discordCopy("claim", "ok"));
  });

  it("clears the draft on success, so one draft cannot found two clans", async () => {
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => "ok" });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(getDraft("111", ctx.now)).toBeNull();
  });

  it("keeps the draft when the roster refuses, so the player can fix the name", async () => {
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => "name-taken" });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    const reply = await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(reply.content).toBe(discordCopy("claim", "name-taken"));
    expect(getDraft("111", ctx.now)).not.toBeNull();
  });

  it("refuses a submit with no flag chosen, without calling the roster", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => { seen.push("ran"); return "ok"; } });
    await spec("found").handler(ctx, input());
    const reply = await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(seen).toEqual([]);
    expect(reply.content).toBe(discordCopy("claim", "bad-flag"));
  });

  it("renders every claim outcome", async () => {
    const outcomes = [
      "ok", "ceremony-taken", "flag-taken", "tag-taken", "pole-taken", "too-close",
      "name-taken", "name-held", "tag-held", "not-linked", "no-such-ceremony",
      "bad-name", "bad-tag", "bad-flag", "bad-roster",
    ] as const;
    for (const o of outcomes) {
      const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => o });
      await spec("found").handler(ctx, input());
      await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
      const reply = await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
      expect(reply.content, o).toBe(discordCopy("claim", o));
      clearDraft("111");
    }
  });

  it("refuses a submit whose draft has expired", async () => {
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => "ok" });
    await spec("found").handler(ctx, input());
    const later = { ...ctx, now: new Date(ctx.now.getTime() + DRAFT_TTL_MS + 1) };
    const reply = await foundGroup.modals!.found!(later, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(reply.content).toContain("/found");
  });
});

describe("foundEmbed", () => {
  it("shows the chosen flag when one has been picked", () => {
    const c = context();
    const draft = { ceremonyId: 9, texture: "Flag_Zenit", memberDayzIds: ["a", "b"] };
    const json = JSON.stringify(foundEmbed(c, draft, "https://x"));
    expect(json).toContain("Flag_Zenit");
    expect(json).not.toContain("not chosen yet");
  });

  it("says the flag is not chosen yet when the draft has none", () => {
    const c = context();
    const draft = { ceremonyId: 9, texture: null, memberDayzIds: ["a", "b", "c"] };
    const json = JSON.stringify(foundEmbed(c, draft, "https://x"));
    expect(json).toContain("not chosen yet");
  });
});
