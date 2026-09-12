import { describe, it, expect } from "vitest";
import { ACHIEVEMENT_GROUP_COLORS } from "@factions/domain";
import { achievementEmbed, achievementMention, badgeUrl, colourInt } from "../src/achievement-embed.js";

const site = "https://dayzclanwars.com";
const player = { key: "sniper", name: "Sniper", description: "A kill from 300 m or more", ownerKind: "player", ownerName: "111111111111111111", gamertag: "SubatomicRacer", clanTag: "BEAR" };
const clan = { key: "fortress", name: "Fortress", description: "Complete 10 defenses", ownerKind: "clan", ownerName: "Bear Company", gamertag: null, clanTag: "BEAR", public: true };

describe("achievementEmbed", () => {
  it("colours by the achievement's group, as an integer", () => {
    expect(achievementEmbed(player, site).color).toBe(0xd4623a);
    expect(achievementEmbed(clan, site).color).toBe(0xd9a03c);
    expect(colourInt(ACHIEVEMENT_GROUP_COLORS.pve)).toBe(0x8fa36a);
  });
  it("thumbnails the unlocked badge the site serves", () => {
    expect(achievementEmbed(player, site).thumbnail).toEqual({ url: "https://dayzclanwars.com/achievements/unlocked/sniper.png" });
    expect(badgeUrl(site, "champions")).toBe("https://dayzclanwars.com/achievements/unlocked/champions.png");
  });
  it("names a player by gamertag and a clan by tag", () => {
    expect(achievementEmbed(player, site).description).toBe("**SubatomicRacer** unlocked **Sniper** · A kill from 300 m or more");
    expect(achievementEmbed(clan, site).description).toBe("**[BEAR]** unlocked **Fortress** · Complete 10 defenses");
  });
  it("never prints a raw Discord id as a name when the gamertag is missing", () => {
    const d = achievementEmbed({ ...player, gamertag: null }, site).description!;
    expect(d).not.toContain("111111111111111111");
    expect(d).toContain("**A player** unlocked");
  });
  it("carries the footer, and no field that could hold a coordinate", () => {
    const e = achievementEmbed(player, site);
    expect(e.footer).toEqual({ text: "Clan Wars · Livonia" });
    expect(e.fields).toBeUndefined();
    expect(JSON.stringify(e)).not.toMatch(/"(x|z|poleKey)"/u);
  });
  it("still renders an unknown key, without a badge, rather than throwing", () => {
    const e = achievementEmbed({ ...player, key: "retired_thing" }, site);
    expect(e.thumbnail).toBeUndefined();
    expect(e.description).toContain("unlocked");
  });
});

describe("achievementMention", () => {
  it("mentions a linked player and nobody else", () => {
    expect(achievementMention(player)).toBe("<@111111111111111111>");
    expect(achievementMention({ ...player, ownerName: "Unlinked" })).toBe("");
    expect(achievementMention(clan)).toBe("");
  });
});
