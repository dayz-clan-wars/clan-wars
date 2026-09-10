import { describe, it, expect } from "vitest";
import { escapeMarkdown, howLine, killFeedEmbed, type KillFeedItem } from "../src/kill-feed-embed.js";

const at = new Date("2026-09-07T20:51:18Z");
const site = "https://dayzclanwars.com";
const kill = (over: Partial<KillFeedItem> = {}): KillFeedItem => ({
  eventId: 4000, occurredAt: at,
  killer: { gamertag: "IGC slide", tag: "BEAR", texture: "Flag_Bear" },
  victim: { gamertag: "RonaldRaygun552", tag: "WOLF", texture: "Flag_Wolf" },
  weapon: "KA-74", distanceM: 40.714, friendlyFire: false, cause: "pvp",
  tally: { killerKills: 13, victimDeaths: 4, season: 1 },
  ...over,
});

describe("killFeedEmbed", () => {
  it("titles with the killer and their tag, linked to the profile", () => {
    const e = killFeedEmbed(kill(), site);
    expect(e.title).toBe("IGC slide [BEAR]");
    expect(e.url).toBe("https://dayzclanwars.com/players/IGC%20slide");
  });

  it("says who was killed, with what, from how far, and the running tally", () => {
    const d = killFeedEmbed(kill(), site).description!;
    expect(d).toContain("killed **[RonaldRaygun552](https://dayzclanwars.com/players/RonaldRaygun552)** [WOLF]");
    expect(d).toContain("KA-74 · 41 m");
    expect(d).toContain("13 kills for IGC slide · 4 deaths for RonaldRaygun552 this season");
    expect(killFeedEmbed(kill(), site).footer?.text).toBe("Season 1");
  });

  it("⚠️ timestamps from the kill, not from now", () => {
    expect(killFeedEmbed(kill(), site).timestamp).toBe(at.toISOString());
  });

  it("thumbnails the killer's flag when a resolver gives one, and names it in a field", () => {
    const e = killFeedEmbed(kill(), site, (t) => `${site}/flags/${t}.png`);
    expect(e.thumbnail?.url).toBe("https://dayzclanwars.com/flags/Flag_Bear.png");
    expect(e.fields).toEqual([{ name: "Flag", value: "Bear", inline: true }]);
    expect(killFeedEmbed(kill(), site).thumbnail).toBeUndefined();
  });

  it("a player with no clan gets no tag, no flag and no field", () => {
    const e = killFeedEmbed(kill({ killer: { gamertag: "Lone", tag: null, texture: null } }), site, (t) => t);
    expect(e.title).toBe("Lone");
    expect(e.thumbnail).toBeUndefined();
    expect(e.fields).toBeUndefined();
  });

  it("friendly fire is amber and says so", () => {
    const e = killFeedEmbed(kill({ friendlyFire: true, victim: { gamertag: "Dave", tag: "BEAR", texture: "Flag_Bear" } }), site);
    expect(e.title).toBe("Friendly fire — IGC slide [BEAR]");
    expect(e.color).toBe(0xe67e22);
    expect(e.description).toContain("killed their own clanmate **[Dave]");
    expect(killFeedEmbed(kill(), site).color).toBe(0xb0482a);
  });

  it("drops the how line when the log gave neither weapon nor distance", () => {
    expect(howLine(null, null)).toBe("");
    expect(howLine("M4-A1", null)).toBe("M4-A1");
    expect(howLine(null, 12.3)).toBe("12 m");
    const d = killFeedEmbed(kill({ weapon: null, distanceM: null }), site).description!;
    expect(d.split("\n")).toHaveLength(2);
  });

  it("counts in all-time when there is no season", () => {
    const e = killFeedEmbed(kill({ tally: { killerKills: 1, victimDeaths: 1, season: null } }), site);
    expect(e.description).toContain("1 kill for IGC slide · 1 death for RonaldRaygun552 all-time");
    expect(e.footer?.text).toBe("All-time");
  });

  it("never lets a gamertag restyle the line", () => {
    expect(escapeMarkdown("x_x*[y]")).toBe("x\\_x\\*\\[y\\]");
    const d = killFeedEmbed(kill({ victim: { gamertag: "_sneaky_", tag: null, texture: null } }), site).description!;
    expect(d).toContain("\\_sneaky\\_");
  });

  it("a credited kill says finished, never killed — the log named no killer", () => {
    expect(killFeedEmbed(kill({ cause: "finished" }), site).description).toContain("finished **[RonaldRaygun552]");
    expect(killFeedEmbed(kill({ cause: "finished", friendlyFire: true }), site).description).toContain("finished their own clanmate");
  });
});
