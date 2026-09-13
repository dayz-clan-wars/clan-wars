import { describe, it, expect } from "vitest";
import { discordCopy } from "@factions/copy";
import type { DirectoryEntry } from "@factions/roster";
import { clansGroup } from "../src/commands/clans.js";
import { directoryEmbed } from "../src/commands/embeds/clans.js";
import { specOf, sourceOf, input, ctxWith } from "./command-fakes.js";

const spec = (path: string) => specOf(clansGroup, path);

/** A complete `DirectoryEntry`. Local to this file — no other task needs it. */
function entry(over: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    tag: "WLF", name: "Wolves", texture: "wolf", status: "active", memberCount: 5,
    recruiting: false, playWindow: null, language: null, pitch: null, alpha: false,
    ...over,
  };
}

describe("/clans join", () => {
  it("renders every RequestJoinOutcome from the shared table", async () => {
    for (const o of ["ok", "not-recruiting", "not-holding", "already-member", "cooldown", "cap",
                     "already-requested", "not-linked", "no-such-clan"] as const) {
      const ctx = ctxWith({ requestJoin: async () => ({ outcome: o, requestId: null }) });
      expect((await spec("clans join").handler(ctx, input({ tag: "WLF" }))).content, o).toBe(discordCopy("request", o));
    }
  });
});

describe("/clans show", () => {
  it("says so plainly when no clan has that tag", async () => {
    const ctx = ctxWith({ clanByTag: async () => null });
    expect((await spec("clans show").handler(ctx, input({ tag: "NOPE" }))).content).toBe(discordCopy("request", "no-such-clan"));
  });

  it("passes the viewer through so canRequest is computed for them", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ clanByTag: async (t: string, v: string | null) => { seen.push([t, v]); return null; } });
    await spec("clans show").handler(ctx, input({ tag: "WLF" }));
    expect(seen).toEqual([["WLF", "111"]]);
  });
});

describe("directoryEmbed", () => {
  it("marks recruiting clans and never carries a base", () => {
    const json = JSON.stringify(directoryEmbed([entry({ recruiting: true }), entry({ tag: "OTH", recruiting: false })], "https://x"));
    expect(json).toContain("Recruiting");
    expect(json).not.toMatch(/base/iu);
  });

  it("stays inside Discord's field length with a long directory", () => {
    const many = Array.from({ length: 60 }, (_, n) => entry({ tag: `T${n}`, name: `Clan number ${n}` }));
    for (const f of directoryEmbed(many, "https://x").toJSON().fields ?? []) {
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe("/clans autocomplete", () => {
  it("offers tags from the directory, filtered by what was typed", async () => {
    const ctx = ctxWith({ directory: async () => ({ clans: [entry({ tag: "WLF", name: "Wolves" }), entry({ tag: "BER", name: "Bears" })], flags: { taken: [], free: [] } }) });
    const choices = await sourceOf(clansGroup, "clans join", "tag")(ctx, { actorDiscordId: "111", value: "wo" });
    expect(choices.map((c) => c.value)).toEqual(["WLF"]);
  });
});
