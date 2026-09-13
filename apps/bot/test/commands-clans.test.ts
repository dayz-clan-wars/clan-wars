import { describe, it, expect } from "vitest";
import { discordCopy } from "@factions/copy";
import type { ClanPage, DirectoryEntry } from "@factions/roster";
import { clansGroup } from "../src/commands/clans.js";
import { clanPageEmbed, directoryEmbed } from "../src/commands/embeds/clans.js";
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

/** A complete `ClanPage`. Local to this file — no other task needs it. */
function page(over: Partial<ClanPage> = {}): ClanPage {
  return {
    ...entry(),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    roster: [],
    canRequest: "yes",
    placements: [],
    alphaWeeks: 0,
    stats: { raids: 0, defenses: 0, longestSiegeSeconds: null, daysHeld: null },
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

  /**
   * Before this test, both existing `/clans show` cases stub `clanByTag` to
   * return `null`, so `clanPageEmbed` — thirty lines, six conditional field
   * blocks — never ran under test. This is the success path.
   */
  it("renders an embed, not the no-such-clan sentence, when clanByTag finds a page", async () => {
    const ctx = ctxWith({ clanByTag: async () => page({ pitch: "Chill raiders" }) });
    const reply = await spec("clans show").handler(ctx, input({ tag: "WLF" }));
    expect(reply.content).toBeUndefined();
    expect(reply.embeds).toHaveLength(1);
  });
});

describe("clanPageEmbed", () => {
  it("renders every optional field when all of them are present", () => {
    const full = page({
      pitch: "Chill raiders welcome",
      playWindow: "18:00-22:00 UTC",
      language: "EN",
      alphaWeeks: 3,
      roster: [{ gamertag: "Vasily", role: "leader" }, { gamertag: null, role: "member" }],
      canRequest: "yes",
    });
    const json = clanPageEmbed(full, "https://x").toJSON();
    expect(JSON.stringify(json)).toContain("Chill raiders welcome");
    expect(JSON.stringify(json)).toContain("18:00-22:00 UTC");
    expect(JSON.stringify(json)).toContain("EN");
    expect(JSON.stringify(json)).toContain("Alpha weeks");
    expect(JSON.stringify(json)).toContain("Vasily");
    expect(json.footer?.text).toContain("/clans join");
  });

  /** The branch every earlier test skipped: no optional field set at all. */
  it("renders cleanly with none of the optional fields present", () => {
    const bare = page({
      pitch: null, playWindow: null, language: null, alphaWeeks: 0, roster: [], canRequest: "in-clan",
    });
    const embed = clanPageEmbed(bare, "https://x");
    const json = embed.toJSON();
    expect(json.description).toBeUndefined();
    expect((json.fields ?? []).some((f) => f.name === "Plays")).toBe(false);
    expect((json.fields ?? []).some((f) => f.name === "Language")).toBe(false);
    expect((json.fields ?? []).some((f) => f.name === "Alpha weeks")).toBe(false);
    expect((json.fields ?? []).some((f) => f.name === "Roster")).toBe(false);
    expect(json.footer).toBeUndefined();
  });

  it("never carries a coordinate — /clans is public data", () => {
    const full = page({
      pitch: "Chill raiders", playWindow: "18:00-22:00 UTC", language: "EN", alphaWeeks: 3,
      roster: [{ gamertag: "Vasily", role: "leader" }],
    });
    expect(JSON.stringify(clanPageEmbed(full, "https://x"))).not.toMatch(/base/iu);
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

  /**
   * M6: at today's scale (dozens of clans) this never triggers, but at
   * roughly 120+ clans an uncapped directory would build an embed Discord
   * rejects outright — 25 fields and 6000 total characters are hard caps,
   * not soft ones. This asserts the card stays inside both caps and says,
   * in the card itself, how many clans were left off rather than silently
   * truncating.
   */
  it("caps field count and total length for a very large directory, and says how many were dropped", () => {
    const huge = Array.from({ length: 1000 }, (_, n) => entry({ tag: `T${n}`, name: `Clan number ${n}` }));
    const json = directoryEmbed(huge, "https://x").toJSON();
    const fields = json.fields ?? [];

    expect(fields.length).toBeLessThanOrEqual(25);
    const totalChars = (json.title?.length ?? 0) + (json.footer?.text.length ?? 0)
      + fields.reduce((s, f) => s + f.name.length + f.value.length, 0);
    expect(totalChars).toBeLessThanOrEqual(6000);

    const last = fields.at(-1)!;
    expect(last.value).toMatch(/^\+\d+ more — see the site\.$/);
  });
});

describe("/clans autocomplete", () => {
  it("offers tags from the directory, filtered by what was typed", async () => {
    const ctx = ctxWith({ directory: async () => ({ clans: [entry({ tag: "WLF", name: "Wolves" }), entry({ tag: "BER", name: "Bears" })], flags: { taken: [], free: [] } }) });
    const choices = await sourceOf(clansGroup, "clans join", "tag")(ctx, { actorDiscordId: "111", value: "wo" });
    expect(choices.map((c) => c.value)).toEqual(["WLF"]);
  });
});
