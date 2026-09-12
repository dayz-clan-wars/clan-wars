import { describe, it, expect } from "vitest";
import { longRangeFeedEmbed, type LongRangeFeedItem } from "../src/long-range-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: LongRangeFeedItem = {
  eventId: 3, occurredAt: new Date("2026-09-12T02:00:00Z"),
  killer: { gamertag: "Steve", tag: "WOLF", texture: null },
  victim: { gamertag: "Dave", tag: "BEAR", texture: null },
  weapon: "Mosin", distanceM: 340, friendlyFire: false, qualifies: true,
  personalBest: true, seasonRank: 2, season: 4,
};

describe("longRangeFeedEmbed", () => {
  it("leads with the distance", () => {
    const e = longRangeFeedEmbed(base, site);
    expect(e.description).toContain("340 m");
  });

  it("names the victim and the weapon", () => {
    const e = longRangeFeedEmbed(base, site);
    expect(e.description).toContain("killed **[Dave](https://dayzclanwars.com/players/Dave)** [BEAR]");
    expect(e.description).toContain("Mosin");
  });

  it("says a personal best and the season rank", () => {
    const e = longRangeFeedEmbed(base, site);
    expect(e.description).toContain("Steve's longest yet");
    expect(e.description).toContain("2nd longest this season");
  });

  it("ordinalises the rank correctly", () => {
    expect(longRangeFeedEmbed({ ...base, seasonRank: 1 }, site).description).toContain("longest this season");
    expect(longRangeFeedEmbed({ ...base, seasonRank: 3 }, site).description).toContain("3rd longest");
    expect(longRangeFeedEmbed({ ...base, seasonRank: 4 }, site).description).toContain("4th longest");
  });

  it("says all-time when the kill predates every season", () => {
    const e = longRangeFeedEmbed({ ...base, season: null, seasonRank: 2 }, site);
    expect(e.description).toContain("2nd longest all-time");
  });

  it("omits each record line independently", () => {
    const neither = longRangeFeedEmbed({ ...base, personalBest: false, seasonRank: null }, site);
    expect(neither.description).not.toContain("longest");
    const onlyBest = longRangeFeedEmbed({ ...base, seasonRank: null }, site);
    expect(onlyBest.description).toContain("longest yet");
    expect(onlyBest.description).not.toContain("this season");
  });

  it("says friendly fire in the title and colours it amber", () => {
    const e = longRangeFeedEmbed({ ...base, friendlyFire: true }, site);
    expect(e.title).toContain("Friendly fire");
    expect(e.color).toBe(0xe67e22);
  });

  it("⚠️ timestamps the kill, not the post", () => {
    expect(longRangeFeedEmbed(base, site).timestamp).toBe("2026-09-12T02:00:00.000Z");
  });
});
