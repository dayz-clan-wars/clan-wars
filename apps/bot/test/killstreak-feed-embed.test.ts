import { describe, it, expect } from "vitest";
import { killstreakFeedEmbed, type KillstreakFeedItem } from "../src/killstreak-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: KillstreakFeedItem = {
  eventId: 9, occurredAt: new Date("2026-09-12T01:41:00Z"), startedAt: new Date("2026-09-12T01:00:00Z"),
  killer: { gamertag: "Steve", tag: "WOLF", texture: null },
  streak: 6, victims: ["Dave", "Rob", "Amy", "Jen", "Kai", "Mo"],
};

describe("killstreakFeedEmbed", () => {
  it("leads with the number", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.title).toBe("Steve [WOLF]");
    expect(e.description).toContain("6 kill streak");
  });

  it("lists the victims oldest first", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.description).toContain("last 6: Dave, Rob, Amy, Jen, Kai, Mo");
  });

  it("caps a long victim list", () => {
    const victims = Array.from({ length: 15 }, (_, n) => `V${n}`);
    const e = killstreakFeedEmbed({ ...base, streak: 15, victims }, site);
    expect(e.description).toContain("… and 5 more");
  });

  it("says how long the streak has been running, from the kill times", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.description).toContain("started 41 minutes ago");
  });

  it("⚠️ timestamps the kill, not the post", () => {
    expect(killstreakFeedEmbed(base, site).timestamp).toBe("2026-09-12T01:41:00.000Z");
  });

  it("escapes markdown in every name", () => {
    const e = killstreakFeedEmbed({ ...base, killer: { gamertag: "S*t*eve", tag: null, texture: null }, victims: ["D_ave"] }, site);
    expect(e.title).toBe("S\\*t\\*eve");
    expect(e.description).toContain("D\\_ave");
  });
});
